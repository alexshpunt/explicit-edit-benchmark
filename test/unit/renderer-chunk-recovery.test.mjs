import assert from "node:assert/strict";
import test from "node:test";
import { runChunkRecovery } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-recovery.mjs";

const snapshot = (differences, buildPassed = true, resultMatched = buildPassed) => ({
  structure: { status: differences.length ? "fail" : "pass", differenceIds: differences },
  integration: { buildPassed, resultMatched },
});

test("structural repairs use fresh evidence, skip resolved work, and receive partial credit", async () => {
  let state = snapshot(["one", "two"]);
  const repairs = [];
  const result = await runChunkRecovery({
    totalFiles: 2,
    capture: async () => structuredClone(state),
    repairStructural: async ({ id, state: current }) => {
      repairs.push({ id, differences: current.structure.differenceIds });
      state = snapshot([]);
    },
    repairIntegration: async () => assert.fail("No integration correction is needed"),
  });
  assert.deepEqual(repairs, [{ id: "one", differences: ["one", "two"] }]);
  assert.deepEqual(
    result.attempts.map(({ id, status }) => [id, status]),
    [
      ["one", "settled"],
      ["two", "skipped"],
    ],
  );
  assert.deepEqual(
    result.stages.map(({ stage }) => stage),
    ["original", "structural-correction"],
  );
  assert.equal(result.score.score, 50);
});

test("build and image corrections each run only when their stage needs them", async () => {
  let state = snapshot([], false, false);
  const repairs = [];
  const result = await runChunkRecovery({
    totalFiles: 1,
    capture: async () => structuredClone(state),
    repairStructural: async () => assert.fail("No structural correction is needed"),
    repairIntegration: async ({ stage }) => {
      repairs.push(stage);
      state = stage === "build-correction" ? snapshot([], true, false) : snapshot([]);
    },
  });
  assert.deepEqual(repairs, ["build-correction", "image-correction"]);
  assert.deepEqual(
    result.stages.map(({ stage }) => stage),
    ["original", ...repairs],
  );
  assert.equal(result.score.score, 56.25);
});

test("new structural regressions are recorded but do not receive another wave", async () => {
  let state = snapshot(["one"]);
  const repairs = [];
  const result = await runChunkRecovery({
    totalFiles: 2,
    capture: async () => structuredClone(state),
    repairStructural: async ({ id }) => {
      repairs.push(id);
      state = snapshot(["two"]);
    },
    repairIntegration: async () => assert.fail("No integration correction is needed"),
  });
  assert.deepEqual(repairs, ["one"]);
  assert.equal(result.score.score, 25);
});

test("a failed build correction does not invent an image attempt", async () => {
  const repairs = [];
  const result = await runChunkRecovery({
    totalFiles: 1,
    capture: async () => snapshot([], false, false),
    repairStructural: async () => assert.fail("No structural correction is needed"),
    repairIntegration: async ({ stage }) => {
      repairs.push(stage);
    },
  });
  assert.deepEqual(repairs, ["build-correction"]);
  assert.equal(result.score.images.available, false);
  assert.equal(result.score.score, 25);
});
test("a cancelled or failed repair does not produce a successful score", async () => {
  const controller = new AbortController();
  const error = Error("cancelled");
  await assert.rejects(
    runChunkRecovery({
      totalFiles: 1,
      signal: controller.signal,
      capture: async () => snapshot(["one"]),
      repairStructural: async () => {
        controller.abort(error);
      },
      repairIntegration: async () => {},
    }),
    error,
  );
});
