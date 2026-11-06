import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalAssignmentPrompt,
  canonicalIntegrationNodes,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";

test("structural unit assignments are delivered as prose without structured data", () => {
  const prompt = canonicalAssignmentPrompt([
    { id: "units-a-1", kind: "unit-correction", prompt: "Add one copy of this code." },
  ]);
  assert.ok(prompt.includes("Add one copy of this code."));
  assert.equal(/JSON|location\.path|hunk/i.test(prompt), false);
});
test("integration checks remain separate executable files", () => {
  for (const stage of ["build-correction", "image-correction"]) {
    const nodes = canonicalIntegrationNodes(stage, {
      expectedPixels: ["a".repeat(64), "b".repeat(64)],
    });
    assert.equal(nodes.length, 1);
    assert.ok(nodes[0].validation.length > 0);
    assert.ok(nodes[0].prompt.includes(nodes[0].validationFile));
    assert.equal(nodes[0].prompt.includes(nodes[0].validation), false);
    assert.deepEqual(nodes[0].dependencies, []);
  }
  assert.throws(() => canonicalIntegrationNodes("original", { expectedPixels: [] }));
  assert.throws(() => canonicalIntegrationNodes("image-correction", { expectedPixels: [] }));
  assert.throws(() => canonicalAssignmentPrompt([]));
});
