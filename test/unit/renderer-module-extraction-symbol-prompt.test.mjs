import test from "node:test";
import assert from "node:assert/strict";
import {
  moduleSymbolPrompt,
  moduleSymbolRecoveryPrompt,
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
    { scope: "", kind: "typedef", signature: "Thing", members: ["int a;"], occurrences: 2 },
  ];
  const prompt = moduleSymbolPrompt(task, spec);
  for (const value of [
    "shape.h",
    "frond",
    "int shade(float value)",
    "using scalar = float;",
    "int a;",
    "occurrences",
  ])
    assert.ok(prompt.includes(value));
  for (const value of ["PRIVATE_BODY_829", "PRIVATE_TEMPLATE_829", "PRIVATE_POSITION_829", "913"])
    assert.ok(!prompt.includes(value));
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
  assert.ok(prompt.includes("shape.h"));
  for (const value of ["PRIVATE_BODY_829", "913", "26", "main.cpp:913"])
    assert.ok(!prompt.includes(value));
});
