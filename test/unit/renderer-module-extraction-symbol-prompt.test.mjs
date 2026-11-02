import test from "node:test";
import assert from "node:assert/strict";
import {
  moduleSymbolPrompt,
  moduleSymbolRecoveryPrompt,
  moduleExplicitPrompt,
} from "../../src/suites/explicit-edit-multi-agent/extraction/prompt.mjs";

test("symbol assignment exposes public declarations but never private plan fields", () => {
  const task = {
    file: "shape.h",
    kind: "header",
    fragments: [{ text: "PRIVATE_BODY_829", start: 913 }],
    destination: "PRIVATE_TEMPLATE_829",
    replacement: "PRIVATE_POSITION_829",
  };
  const spec = [
    { scope: "frond", kind: "function", signature: "int shade(float value)" },
    { scope: "frond", kind: "using", signature: "using scalar = float;" },
    { scope: "frond", kind: "function", signature: 'void label(const char* value = "a\\b")' },
    { scope: "", kind: "typedef", signature: "Thing", members: ["int a;"], occurrences: 2 },
  ];
  const prompt = moduleSymbolPrompt(task, spec);
  assert.doesNotMatch(prompt, /"(?:scope|kind|signature|members|action|occurrences)"\s*:/);
  for (const value of [
    "shape.h",
    "frond",
    "int shade(float value)",
    "using scalar = float;",
    'void label(const char* value = "a\\b")',
    "int a;",
    "2",
  ])
    assert.ok(prompt.includes(value));
  for (const value of ["PRIVATE_BODY_829", "PRIVATE_TEMPLATE_829", "PRIVATE_POSITION_829", "913"])
    assert.ok(!prompt.includes(value));
});

test("explicit assignment delivers required inventories and selected ambiguity hints without other private fields", () => {
  const task = {
    file: "shape.h",
    kind: "header",
    replacement: '#include "shape.h"\n',
    fragments: [{ text: "PRIVATE_BODY_829" }],
    destination: "PRIVATE_TEMPLATE_829",
  };
  const spec = {
    entities: [{ scope: "", kind: "function-definition", signature: "int shade()" }],
    contract: { preamble: [{ kind: "include", name: "<vector>" }], conditionals: [] },
    hints: ["Snapshot line 83: ANCHOR_123"],
  };
  const prompt = moduleExplicitPrompt(task, spec);
  for (const value of ["int shade()", "<vector>", "83", "ANCHOR_123"])
    assert.ok(prompt.includes(value));
  for (const value of ["PRIVATE_BODY_829", "PRIVATE_TEMPLATE_829"])
    assert.ok(!prompt.includes(value));
});

test("repeated namespace is stated once while every assigned signature remains", () => {
  const scope = "sample_scope_824";
  const entities = Array.from({ length: 20 }, (_, index) => ({
    scope,
    kind: index % 2 ? "function-definition" : "function-declaration",
    signature: `void example_${index}(int value)`,
  }));
  const prompt = moduleSymbolPrompt({ file: "sample.h", kind: "header" }, entities);
  assert.equal(prompt.split(scope).length - 1, 1);
  for (const entity of entities) assert.ok(prompt.includes(entity.signature));
});
test("symbol recovery excludes compiler excerpts and location metadata", () => {
  const task = {
    file: "shape.h",
    kind: "header",
    recovery: {
      diagnostics: [{ file: "main.cpp", line: 913, column: 26, message: "PRIVATE_BODY_829" }],
      verified: { targetMatched: false, sourceMatched: true },
    },
  };
  const prompt = moduleSymbolRecoveryPrompt(task);
  assert.doesNotMatch(prompt, /"(?:sourceMatched|targetMatched)"\s*:/);
  assert.ok(prompt.includes("shape.h"));
  for (const value of ["PRIVATE_BODY_829", "913", "26", "main.cpp:913"])
    assert.ok(!prompt.includes(value));
});
