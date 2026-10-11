import assert from "node:assert/strict";
import test from "node:test";
import {
  batchRequests,
  runBatchedRequestChain,
} from "../../src/suites/explicit-edit-multi-agent/tasks/request-batches.mjs";
import { GradeFailure } from "../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";

const request = (id, phase = "structure", group = "headers") => ({ id, phase, group, prompt: id });

await test("related batches keep every request in order, cap at twenty and never mix phases", () => {
  const steps = Array.from({ length: 23 }, (_, index) => request(`header-${index}`));
  steps.push(request("definition", "structure", "shape"), request("names", "names", "shape"));
  const result = batchRequests(steps);
  assert.deepEqual(
    result.map((batch) => batch.requests.length),
    [20, 3, 1, 1],
  );
  assert.deepEqual(
    result.flatMap((batch) => batch.requests),
    steps,
  );
  assert.deepEqual(result, batchRequests(structuredClone(steps)));
  assert.throws(() => batchRequests(steps, 21), /twenty|20|limit/i);
  assert.throws(() => batchRequests([request("same"), request("same")]), /duplicate/i);
  assert.throws(
    () => batchRequests([request("name", "names"), request("later")]),
    /phase|structure/i,
  );
  assert.throws(() => batchRequests([{ ...request("bad"), group: "" }]), /group/i);
});

await test("the agent gets one request at a time and grading happens only after the whole batch", async () => {
  const steps = [
    request("create-header"),
    request("move-body"),
    request("add-include"),
    request("rename", "names", "shape"),
  ];
  const calls = [];
  let state = "monolith";
  const saved = [];
  const result = await runBatchedRequestChain(steps, {
    identity: () => state,
    execute: async ({ prompt, index, repair }) => {
      assert.equal(repair, false);
      assert.equal(prompt, steps[index].prompt);
      assert.ok(!prompt.includes(steps.at(-1).prompt) || index === 3);
      calls.push(`edit:${index}`);
      state = ["missing-body", "missing-include", "split", "named"][index];
    },
    grade: async ({ index, batch }) => {
      calls.push(`grade:${index}`);
      assert.equal(state, index === 0 ? "split" : "named");
      assert.equal(batch.requests.length, index === 0 ? 3 : 1);
      return { status: "pass" };
    },
    save: async (report) => saved.push(structuredClone(report)),
  });
  assert.deepEqual(calls, ["edit:0", "edit:1", "edit:2", "grade:0", "edit:3", "grade:1"]);
  assert.equal(result.status, "pass");
  assert.equal(result.passedBatches, 2);
  assert.equal(result.passedRequests, 4);
  assert.ok(
    saved.some((report) => report.requests[0].status === "edited" && report.passedRequests === 0),
  );
  assert.ok(result.requests.every((item) => item.status === "pass"));
});

await test("repairs retain the whole failed batch without replaying edits and withhold the next batch after three failures", async () => {
  const steps = [
    request("first"),
    request("second"),
    request("third", "structure", "definitions"),
    request("fourth", "structure", "definitions"),
    request("future", "names", "shape"),
  ];
  const calls = [];
  let state = 0;
  const result = await runBatchedRequestChain(steps, {
    identity: () => String(state),
    execute: async ({ prompt, index, repair, attempt }) => {
      calls.push({ prompt, index, repair, attempt, state });
      state++;
      if (repair) {
        assert.match(prompt, /Previous attempt failed \[build\]/);
        assert.match(prompt, /current workspace/i);
        assert.ok(!prompt.includes("future"));
      }
    },
    grade: async ({ index, attempt }) => {
      if (index === 0 && attempt === 2) return { status: "pass" };
      throw new GradeFailure("build", "Missing batch include");
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.passedBatches, 1);
  assert.equal(result.passedRequests, 2);
  assert.deepEqual(
    calls.filter((call) => !call.repair).map((call) => call.index),
    [0, 1, 2, 3],
  );
  assert.equal(calls.filter((call) => call.repair).length, 3);
  assert.deepEqual(
    calls.map((call) => call.state),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(result.requests.at(-1).status, "unattempted");
  assert.equal(result.batchReport.attempts.at(-1).attempt, 3);
});
