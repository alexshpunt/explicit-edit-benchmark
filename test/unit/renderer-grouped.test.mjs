import assert from "node:assert/strict";
import { test } from "node:test";
import { GradeFailure } from "../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import {
  groupedRequests,
  runGroupedRequestChain,
} from "../../scripts/multi-agent/experiments/grouped-requests.mjs";

const requests = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `edit-${index}`,
    phase: "structure",
    group: "layout",
    prompt: `Move owner ${index}. Keep all other owners unchanged.`,
    dependsOn: index ? [`edit-${index - 1}`] : [],
  }));

test("ordered lists deliver many operations in one call and grade only the complete list", async () => {
  const steps = requests(60);
  const lists = groupedRequests(steps);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].referenceBatchId, "batch-003");
  assert.deepEqual(
    lists.flatMap((list) => list.requests.map((step) => step.id)),
    steps.map((step) => step.id),
  );
  let edits = 0,
    grades = 0;
  const report = await runGroupedRequestChain(lists, {
    identity: async () => String(edits),
    execute: async ({ list, repair }) => {
      assert.equal(repair, false);
      assert.equal(list.requests.length, 60);
      edits++;
      return { toolCalls: 1 };
    },
    grade: async ({ list }) => {
      assert.equal(edits, 1);
      assert.equal(list.referenceBatchId, "batch-003");
      grades++;
      return { status: "pass" };
    },
  });
  assert.equal(report.status, "pass");
  assert.equal(edits, 1);
  assert.equal(grades, 1);
  assert.equal(report.passedRequests, 60);
  assert.equal(report.passedBatches, 1);
  assert.equal(report.deliveries.length, 1);
  assert.equal(report.deliveries[0].requestIds.length, 60);
});

test("lists keep phase, related groups and old reference boundaries without dropping large requests", () => {
  const steps = requests(80);
  steps[40].group = "headers";
  steps[41].phase = "names";
  for (const step of steps.slice(42)) step.phase = "names";
  const lists = groupedRequests(steps, 2200);
  assert.deepEqual(
    lists.flatMap((list) => list.requests.map((step) => step.id)),
    steps.map((step) => step.id),
  );
  assert.ok(
    lists.every((list) =>
      list.requests.every((step) => step.phase === list.phase && step.group === list.group),
    ),
  );
  assert.equal(lists.at(-1).referenceBatchId, "batch-005");
  assert.throws(() => groupedRequests(steps, 20), /fit|size|budget/i);
  assert.throws(() => groupedRequests([...steps, steps[0]]), /duplicate/i);
});

test("three coarse list repairs retain edits and never replay operations or deliver a future list", async () => {
  const steps = requests(40);
  steps.slice(20).forEach((step) => {
    step.group = "next";
  });
  const lists = groupedRequests(steps);
  let edits = 0;
  const deliveries = [];
  const report = await runGroupedRequestChain(lists, {
    oracleRecoveries: 3,
    feedbackMode: "coarse",
    identity: async () => String(edits),
    execute: async ({ list, repair, prompt }) => {
      assert.equal(list.id, "list-001");
      assert.equal(repair, edits > 0);
      if (repair) {
        assert.match(prompt, /The project does not build\./);
        assert.doesNotMatch(prompt, /secret compiler diagnostic|Move owner/);
      }
      deliveries.push(repair);
      edits++;
    },
    grade: async () => {
      throw new GradeFailure("build", "secret compiler diagnostic");
    },
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(deliveries, [false, true, true, true]);
  assert.equal(report.passedRequests, 0);
  assert.equal(report.batchReport.attempts.length, 4);
  assert.ok(report.requests.slice(20).every((request) => request.status === "unattempted"));
  assert.equal(report.deliveries.at(-1).after, "4");
});
