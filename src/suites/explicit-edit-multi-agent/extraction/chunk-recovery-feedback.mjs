import assert from "node:assert/strict";
import { moduleSymbolRecoveryPrompt } from "./prompt.mjs";
import { buildSymbolRecoveryFeedback } from "./symbol-feedback.mjs";

/** Make a prose-only structural repair assignment from public symbols and a fresh candidate. */
export async function chunkStructuralRecoveryFeedback({
  plan,
  task,
  structure,
  tree,
  assignments,
}) {
  assert.ok(
    plan &&
      Array.isArray(plan.tasks) &&
      plan.tasks.some((item) => item.id === task.id && item.file === task.file),
  );
  assert.ok(assignments instanceof Map && tree && structure && Array.isArray(structure.files));
  const current = structure.files.find((item) => item.id === task.id);
  assert.ok(
    current &&
      typeof current.targetMatched === "boolean" &&
      typeof current.sourceMatched === "boolean",
  );
  assert.ok(!current.targetMatched || !current.sourceMatched, "Task has no structural failure");
  const assignment = assignments.get(task.id);
  assert.ok(Array.isArray(assignment?.entities), "Missing public task inventory");
  const feedback = [];
  const vendor = !!assignment.contract?.flatVendor;
  if (!current.targetMatched) {
    const actual = tree[task.file];
    if (actual === undefined || typeof actual === "string") {
      feedback.push(
        ...(await buildSymbolRecoveryFeedback({
          expected: plan.expected[task.file],
          actual: actual ?? "",
          entities: assignment.entities,
          kind: vendor ? "vendor-header" : task.kind,
        })),
      );
    } else feedback.push({ status: "unavailable" });
  }
  if (!current.sourceMatched && typeof tree["main.cpp"] === "string" && !vendor) {
    const sourceFeedback = await buildSymbolRecoveryFeedback({
      expected: plan.expected["main.cpp"],
      actual: tree["main.cpp"],
      entities: assignment.entities,
      detectUnexpected: true,
    });
    feedback.push(
      ...sourceFeedback
        .filter(({ status }) => status === "extra")
        .map((item) => ({ ...item, source: true })),
    );
  }
  const recovery = {
    verified: { sourceMatched: current.sourceMatched, targetMatched: current.targetMatched },
    publicFeedback: feedback,
  };
  return { feedback, prompt: moduleSymbolRecoveryPrompt({ ...task, recovery }) };
}

/** Shared failures can be reported without exposing private verifier contents or coordinates. */
export function chunkSharedRecoveryFeedback(structure) {
  assert.ok(structure && Array.isArray(structure.diagnostics));
  return moduleSymbolRecoveryPrompt({
    kind: "main-recovery",
    recovery: { diagnostics: structure.diagnostics },
  });
}
