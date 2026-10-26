import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareBarrierSymbolMap,
  evaluateBarrierSymbolMap,
} from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderer-binding-facts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let index = 0;
  return () => ({ evidence: path.join(root, String(index++)) });
}

const one = (bindings, predicate) => {
  const matches = bindings.filter(predicate);
  assert.equal(matches.length, 1);
  return matches[0];
};

test("candidate binding facts retain physical UTF-8 locations and outer function ownership", async (t) => {
  const options = await fixture(t);
  const source = `// π
namespace sample {
struct Box { int Value; };
int calculate(int First) {
  auto call = [](int Step) { return Step + 1; };
  Box box{};
  return call(First) + box.Value;
}
}
auto standalone = [](int Standalone) { return Standalone; };
`;
  const map = await prepareBarrierSymbolMap({ "main.cpp": source }, options());
  const first = one(
    map.bindings,
    (binding) => binding.role === "variable" && binding.name === "First",
  );
  assert.equal(first.file, "main.cpp");
  assert.equal(first.translationUnit, "main.cpp");
  assert.equal(first.offset, Buffer.byteLength(source.slice(0, source.indexOf("First"))));
  assert.equal(first.line, 4);
  assert.equal(first.scope, "sample::calculate::First");
  assert.deepEqual(first.owner, {
    scope: "sample::calculate",
    signature: "int (int)",
    definition: true,
  });
  const step = one(
    map.bindings,
    (binding) => binding.role === "variable" && binding.name === "Step",
  );
  assert.equal(step.scope, "sample::calculate::operator()::Step");
  assert.deepEqual(step.owner, first.owner);
  const standalone = one(map.bindings, (binding) => binding.name === "Standalone");
  assert.equal(standalone.owner.scope, "operator()");
  assert.equal(standalone.owner.definition, true);
  const field = one(
    map.bindings,
    (binding) => binding.role === "field" && binding.name === "Value",
  );
  assert.equal(field.scope, "sample::Box::Value");
  assert.equal(field.declaringScope, "sample::Box");
  assert.equal(Object.hasOwn(field, "owner"), false);
  assert.equal(typeof first.id, "string");
  assert.deepEqual(first.files, ["main.cpp"]);
});

test("candidate facts deduplicate physical headers and include all bound declaration and use files", async (t) => {
  const options = await fixture(t);
  const tree = {
    "api.h": "#pragma once\nnamespace sample { int chosen(int Input); }\n",
    "a.cpp": '#include "api.h"\nnamespace sample { int chosen(int Input) { return Input; } }\n',
    "b.cpp": '#include "api.h"\nint use() { return sample::chosen(2); }\n',
  };
  const { bindings } = await prepareBarrierSymbolMap(tree, options());
  const prototype = one(
    bindings,
    (binding) =>
      binding.file === "api.h" && binding.role === "function" && binding.name === "chosen",
  );
  const definition = one(
    bindings,
    (binding) =>
      binding.file === "a.cpp" && binding.role === "function" && binding.name === "chosen",
  );
  assert.equal(prototype.definition, false);
  assert.equal(definition.definition, true);
  assert.equal(prototype.id, definition.id);
  assert.equal(definition.translationUnit, "a.cpp");
  assert.deepEqual(prototype.files, ["a.cpp", "api.h", "b.cpp"]);
  assert.deepEqual(definition.files, prototype.files);
  const parameter = one(
    bindings,
    (binding) => binding.file === "api.h" && binding.name === "Input",
  );
  assert.equal(parameter.owner.definition, false);
});

test("an implementation-only header binding records the translation unit that enabled its body", async (t) => {
  const options = await fixture(t);
  const tree = {
    "api.h":
      "#pragma once\n#ifdef IMPLEMENTATION\nint active(int Current) { return Current; }\n#else\nint active(int Prototype);\n#endif\n",
    "a.cpp": '#include "api.h"\n',
    "z.cpp": '#define IMPLEMENTATION\n#include "api.h"\n',
  };
  const { bindings } = await prepareBarrierSymbolMap(tree, options());
  const current = one(bindings, (binding) => binding.name === "Current");
  assert.equal(current.file, "api.h");
  assert.equal(current.translationUnit, "z.cpp");
  assert.equal(current.owner.definition, true);
  const prototype = one(bindings, (binding) => binding.name === "Prototype");
  assert.equal(prototype.translationUnit, "a.cpp");
  assert.equal(prototype.owner.definition, false);
});

test("same-named internal declarations in different headers have distinct private current identities", async (t) => {
  const options = await fixture(t);
  const tree = {
    "a/api.h": "#pragma once\nstatic int Current = 1;\n",
    "b/api.h": "#pragma once\nstatic int Current = 2;\n",
    "a.cpp": '#include "a/api.h"\nint first() { return Current; }\n',
    "b.cpp": '#include "b/api.h"\nint second() { return Current; }\n',
  };
  const { bindings } = await prepareBarrierSymbolMap(tree, options());
  const first = one(
    bindings,
    (binding) => binding.file === "a/api.h" && binding.name === "Current",
  );
  const second = one(
    bindings,
    (binding) => binding.file === "b/api.h" && binding.name === "Current",
  );
  assert.equal(first.internal, true);
  assert.equal(second.internal, true);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.files, ["a.cpp", "a/api.h"]);
  assert.deepEqual(second.files, ["b.cpp", "b/api.h"]);
});

test("read-only function facts include spaced operator declarations", async (t) => {
  const options = await fixture(t);
  const tree = {
    "main.cpp":
      "struct Box { int Value; };\nbool operator ==(const Box& Left, const Box& Right) { return Left.Value == Right.Value; }\n",
  };
  const { bindings } = await prepareBarrierSymbolMap(tree, options());
  const operator = one(
    bindings,
    (binding) => binding.role === "function" && binding.name === "operator==",
  );
  assert.equal(operator.scope, "operator==");
  assert.equal(operator.definition, true);
  assert.equal(operator.owner.scope, "operator==");
});

test("repair facts are actual candidate data and do not participate in symbol-map acceptance", async (t) => {
  const options = await fixture(t);
  const original = { "main.cpp": "int chosen(int Previous) { return Previous; }\n" };
  const expected = await prepareBarrierSymbolMap(original, options());
  expected.bindings = [{ id: "PRIVATE_EXPECTED_ID", name: "PRIVATE_EXPECTED_NAME" }];
  const same = await evaluateBarrierSymbolMap(original, expected, options());
  assert.equal(same.status, "pass");
  assert.equal(
    same.bindings.some((binding) => binding.name === "Previous"),
    true,
  );
  assert.equal(JSON.stringify(same.bindings).includes("PRIVATE_EXPECTED"), false);
  const broken = {
    "main.cpp": "int chosen(int Current) { return Current; }\nMissingType broken;\n",
  };
  const result = await evaluateBarrierSymbolMap(broken, expected, options());
  assert.equal(result.status, "fail");
  assert.ok(result.compilerDiagnostics.some((diagnostic) => diagnostic.severity === "error"));
  const current = one(result.bindings, (binding) => binding.name === "Current");
  assert.equal(current.recovered, true);
  assert.equal(current.owner.scope, "chosen");
  assert.equal(
    result.bindings.some((binding) => binding.name === "Previous"),
    false,
  );
  assert.equal(JSON.stringify(result.bindings).includes("PRIVATE_EXPECTED"), false);
});

test("one failed barrier reports every unresolved candidate use for its correction epoch", async (t) => {
  const options = await fixture(t);
  const expected = await prepareBarrierSymbolMap(
    { "main.cpp": "int initial() { return 0; }\n" },
    options(),
  );
  const names = Array.from({ length: 30 }, (_, index) => `Missing${index}`);
  const source = names.map((name, index) => `int f${index}() { return ${name}; }`).join("\n");
  const actual = await evaluateBarrierSymbolMap({ "main.cpp": source }, expected, options());
  assert.equal(actual.status, "fail");
  for (const name of names)
    assert.ok(
      actual.compilerDiagnostics.some((diagnostic) => diagnostic.message.includes(`'${name}'`)),
      name,
    );
});
