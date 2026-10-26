import assert from "node:assert/strict";
import test from "node:test";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

const before = {
  "shape.h": "#pragma once\nnamespace sample {\nint public_api(int value);\n}\n",
  "main.cpp":
    '#include "shape.h"\nnamespace sample {\nint internal(int value);\nint internal(int value) { return value + 1; }\nint public_api(int value) { return internal(value); }\n}\n',
};
const operation = {
  id: "move-internal",
  phase: "structure",
  action: "implementation",
  file: "shape.cpp",
  includes: [{ file: "shape.h", quoted: true }],
  preamble: '#include "shape.h"\n\n',
  targets: [
    {
      selector: {
        kind: "function",
        scope: "sample",
        declarator: "intinternal(intvalue)",
        definition: true,
      },
      context: [],
    },
  ],
};
const after = applyCoherentStructure(before, operation);
const contract = prepareCoherentContract(after);

function inHeader(source) {
  return { ...after, "shape.h": source };
}

test("a selected definition move leaves existing header declarations and the unlisted temporary declaration intact", () => {
  assert.equal(after["shape.h"], before["shape.h"]);
  assert.ok(after["main.cpp"].includes("int internal(int value);"));
  assert.ok(after["shape.cpp"].includes("int internal(int value) { return value + 1; }"));
  assert.equal(evaluateCoherentContract(after, contract).status, "pass");
  assert.equal(evaluateCoherentContract(after, contract).status, "pass");
});

test("adding a matching header prototype is an extra declaration, not include scaffolding", () => {
  const tree = inHeader(
    before["shape.h"].replace("int public_api", "int internal(int value);\nint public_api"),
  );
  const barrier = evaluateCoherentContract(tree, contract);
  assert.equal(barrier.status, "fail");
  assert.ok(
    barrier.obligations.some((entry) => entry.kind === "unexpected" && entry.file === "shape.h"),
  );
  assert.equal(evaluateCoherentContract(tree, contract).status, "fail");
});

test("removing or relocating an existing public declaration still violates preservation", () => {
  const missing = inHeader("#pragma once\nnamespace sample {}\n");
  assert.equal(evaluateCoherentContract(missing, contract).status, "fail");
  const relocated = {
    ...missing,
    "shape.cpp": after["shape.cpp"] + "\nnamespace sample { int public_api(int value); }\n",
  };
  assert.equal(evaluateCoherentContract(relocated, contract).status, "fail");
});

test("include and namespace-wrapper variation does not require a canonical byte layout", () => {
  const equivalent = inHeader(
    "#pragma once\n#include <cstddef>\nnamespace sample { int public_api(int value); }\n",
  );
  assert.equal(evaluateCoherentContract(equivalent, contract).status, "pass");
  assert.equal(evaluateCoherentContract(equivalent, contract).status, "pass");
});

test("only an explicitly selected temporary declaration may be removed", () => {
  const cleanup = {
    phase: "structure",
    action: "remove-generated-declaration",
    file: "main.cpp",
    selector: { scope: "sample", declarator: "intinternal(intvalue)", definition: false },
  };
  const cleaned = applyCoherentStructure(after, cleanup);
  assert.ok(!cleaned["main.cpp"].includes("int internal(int value);"));
  assert.equal(cleaned["shape.h"], before["shape.h"]);
  assert.equal(
    evaluateCoherentContract(
      cleaned,
      prepareCoherentContract({
        ...after,
        "main.cpp": after["main.cpp"].replace("int internal(int value);", ""),
      }),
    ).status,
    "pass",
  );
});
