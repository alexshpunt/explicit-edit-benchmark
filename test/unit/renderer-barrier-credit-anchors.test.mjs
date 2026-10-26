import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  indexBarrierSymbolMap,
  prepareBarrierSymbolMap,
  evaluateBarrierSymbolMap,
} from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-credit-anchors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let sequence = 0;
  return () => ({ evidence: path.join(directory, String(sequence++)) });
}

const at = (source, text, start = 0) =>
  Buffer.byteLength(source.slice(0, source.indexOf(text, start)));
const declarationAt = (map, file, offset, kind) =>
  map.credit.anchors.find(
    (row) =>
      row.role === "declaration" && row.file === file && row.offset === offset && row.kind === kind,
  );

function referenceAt(map, file, offset, kind) {
  return map.credit.anchors.find(
    (row) =>
      row.role === "reference" && row.file === file && row.offset === offset && row.kind === kind,
  );
}

test("private compiler anchors retain independent parameter bindings in a partially renamed owner", async (t) => {
  const options = await fixture(t);
  const source = "int sum(int first, int right) { return first + right; }\n";
  const map = await indexBarrierSymbolMap({ "main.cpp": source }, options());
  assert.equal(map.credit.version, "renderer-binding-anchors-v1");
  assert.deepEqual(map.credit.translationUnits, [
    { file: "main.cpp", status: "pass", files: ["main.cpp"] },
  ]);
  const first = declarationAt(map, "main.cpp", at(source, "first"), "PARM_DECL");
  const right = declarationAt(map, "main.cpp", at(source, "right"), "PARM_DECL");
  assert.ok(first?.id && right?.id && first.id !== right.id);
  const firstUse = referenceAt(
    map,
    "main.cpp",
    at(source, "first", source.indexOf("return")),
    "DECL_REF_EXPR",
  );
  const rightUse = referenceAt(
    map,
    "main.cpp",
    at(source, "right", source.indexOf("return")),
    "DECL_REF_EXPR",
  );
  assert.equal(firstUse.target.id, first.id);
  assert.equal(rightUse.target.id, right.id);
  assert.equal(firstUse.target.file, "main.cpp");
  assert.equal(firstUse.target.offset, first.offset);
  assert.equal(firstUse.target.kind, "PARM_DECL");
  assert.ok(map.credit.anchors.every((row) => row.translationUnit === "main.cpp"));
});

test("compiler anchor offsets count UTF-8 bytes rather than JavaScript characters", async (t) => {
  const options = await fixture(t);
  const source = "// λ\nint inspect(int value) { return value; }\n";
  const map = await indexBarrierSymbolMap({ "main.cpp": source }, options());
  const offset = at(source, "value");
  assert.notEqual(offset, source.indexOf("value"));
  const declaration = declarationAt(map, "main.cpp", offset, "PARM_DECL");
  assert.ok(declaration?.id);
  const use = referenceAt(
    map,
    "main.cpp",
    at(source, "value", source.indexOf("return")),
    "DECL_REF_EXPR",
  );
  assert.equal(use.target.id, declaration.id);
  assert.equal(use.target.offset, offset);
});

test("physical target anchors distinguish a using rebind while legacy strict comparison is unchanged", async (t) => {
  const options = await fixture(t);
  const prefix =
    "namespace alpha { struct Restored {}; }\nnamespace beta { struct Restored {}; }\n";
  const expectedSource =
    prefix + "namespace frond { using namespace alpha; int inspect(Restored) { return 1; } }\n";
  const actualSource = expectedSource.replace("using namespace alpha", "using namespace beta");
  const expected = await prepareBarrierSymbolMap({ "main.cpp": expectedSource }, options());
  const result = await evaluateBarrierSymbolMap({ "main.cpp": actualSource }, expected, options());
  assert.equal(result.status, "fail");
  assert.equal(result.symbolMap.status, "pass");
  const expectedRef = referenceAt(
    expected,
    "main.cpp",
    at(expectedSource, "Restored", prefix.length),
    "TYPE_REF",
  );
  const actualRef = referenceAt(
    result.symbolMap,
    "main.cpp",
    at(actualSource, "Restored", prefix.length),
    "TYPE_REF",
  );
  assert.equal(expectedRef.target.offset, at(expectedSource, "Restored"));
  assert.equal(
    actualRef.target.offset,
    at(actualSource, "Restored", actualSource.indexOf("namespace beta")),
  );
  assert.notEqual(expectedRef.target.id, actualRef.target.id);
  for (const record of result.symbolMap.symbols)
    assert.deepEqual(Object.keys(record).sort(), [
      "count",
      "declaration",
      "definition",
      "file",
      "kind",
      "references",
      "tokensSha256",
      "usr",
    ]);
});

test("an invalid independent TU never supplies recovered grading anchors or erases a valid TU", async (t) => {
  const options = await fixture(t);
  const map = await indexBarrierSymbolMap(
    {
      "a.cpp": "int valid(int value) { return value; }\n",
      "b.cpp": "int broken(int candidate) { return candidate + ; }\n",
    },
    options(),
  );
  assert.equal(map.status, "fail");
  assert.deepEqual(map.credit.translationUnits, [
    { file: "a.cpp", status: "pass", files: ["a.cpp"] },
    { file: "b.cpp", status: "fail", files: ["b.cpp"] },
  ]);
  assert.ok(map.credit.anchors.length > 0);
  assert.ok(
    map.credit.anchors.every((row) => row.translationUnit === "a.cpp" && row.file === "a.cpp"),
  );
  assert.ok(map.bindings.some((row) => row.translationUnit === "b.cpp" && row.recovered));
});

test("translation unit coverage retains available project includes even for missing-header errors", async (t) => {
  const options = await fixture(t);
  const map = await indexBarrierSymbolMap(
    {
      "api.h": "#pragma once\nint declared();\n",
      "nested.h": '#pragma once\n#include "api.h"\n',
      "a.cpp": '#include "nested.h"\nint good() { return declared(); }\n',
      "b.cpp": '#include "nested.h"\n#include "missing.h"\nint bad() { return declared(); }\n',
    },
    options(),
  );
  assert.deepEqual(map.credit.translationUnits, [
    { file: "a.cpp", status: "pass", files: ["a.cpp", "api.h", "nested.h"] },
    { file: "b.cpp", status: "fail", files: ["api.h", "b.cpp", "nested.h"] },
  ]);
  assert.ok(
    map.credit.anchors.some((row) => row.file === "api.h" && row.translationUnit === "a.cpp"),
  );
  assert.ok(map.credit.anchors.every((row) => row.translationUnit !== "b.cpp"));
});

test("referenced implicit constructors retain project declaration anchors and external functions retain identities", async (t) => {
  const options = await fixture(t);
  const source =
    "#include <cmath>\nstruct Box { int value; };\ndouble inspect() { Box box{}; auto copy = box; return std::sqrt(double(copy.value)); }\n";
  const map = await indexBarrierSymbolMap({ "main.cpp": source }, options());
  assert.equal(map.status, "pass");
  const constructor = map.credit.anchors.find(
    (row) => row.role === "reference" && row.target.kind === "CONSTRUCTOR",
  );
  assert.ok(constructor?.target.id);
  assert.ok(
    map.credit.anchors.some(
      (row) =>
        row.role === "declaration" &&
        row.id === constructor.target.id &&
        row.file === constructor.target.file &&
        row.offset === constructor.target.offset,
    ),
  );
  const external = map.credit.anchors.find(
    (row) => row.role === "reference" && row.target.usr?.includes("sqrt"),
  );
  assert.ok(external?.target.id);
  assert.equal(external.target.kind, "FUNCTION_DECL");
  assert.ok(external.target.external);
});
