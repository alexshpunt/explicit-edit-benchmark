import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkStructuralRecoveryFeedback,
  chunkSharedRecoveryFeedback,
} from "../../src/suites/explicit-edit-multi-agent/extraction/chunk-recovery-feedback.mjs";

const entity = { scope: "", kind: "function-definition", signature: "int paint()" };
const task = { id: "extract-1", file: "paint.cpp", kind: "implementation" };
const plan = {
  tasks: [task],
  expected: {
    "main.cpp": "int main() { return 0; }\n",
    "paint.cpp": "int paint() { return 873125; }\n",
  },
};
const assignments = new Map([[task.id, { entities: [entity] }]]);

test("structural feedback identifies public entities and never gives away reference bodies", async () => {
  const structure = {
    files: [{ id: task.id, targetMatched: false, sourceMatched: false }],
    diagnostics: [],
  };
  const tree = {
    "paint.cpp": "int paint() { return 5; }\n",
    "main.cpp": "int paint() { return 2; }\nint main() { return 0; }\n",
  };
  const result = await chunkStructuralRecoveryFeedback({
    plan,
    task,
    structure,
    tree,
    assignments,
  });
  assert.deepEqual(
    result.feedback.map(({ status, source }) => [status, !!source]),
    [
      ["changed", false],
      ["extra", true],
    ],
  );
  assert.ok(result.prompt.includes(entity.signature));
  assert.ok(!result.prompt.includes("873125"));
  assert.ok(!result.prompt.includes("return 5"));
  assert.ok(!result.prompt.includes('"status"'));
});

test("shared feedback reports safe unexpected files without exposing private diagnostics", () => {
  const result = chunkSharedRecoveryFeedback({
    diagnostics: [
      { kind: "extra-file", file: "extra.txt" },
      { kind: "extra-file", file: "../private.txt" },
      { kind: "residual-main", file: "main.cpp", privateSource: "SECRET_873125" },
    ],
  });
  assert.ok(result.includes("extra.txt"));
  assert.ok(!result.includes("../private.txt"));
  assert.ok(!result.includes("SECRET_873125"));
});
