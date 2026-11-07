import assert from "node:assert/strict";
import test from "node:test";
import {
  combineScores,
  snapshotScore,
} from "../../src/suites/explicit-edit-multi-agent/extraction/snapshot-run.mjs";

const rows = (solved, total, seconds) =>
  Array.from({ length: total }, (_, index) => ({
    passed: index < solved,
    started: new Date(0).toISOString(),
    ended: new Date(seconds * 1000).toISOString(),
  }));

test("a run gives three separate numbers over every task of the set", () => {
  const score = snapshotScore({ usage: { output: 4000 } }, rows(9, 10, 12));
  assert.equal(score.solved, 9);
  assert.equal(score.solvedPercent, 90);
  // Rates divide by all ten tasks, so a failed task is not free.
  assert.equal(score.outputTokensPerTask, 400);
  assert.equal(score.secondsPerTask, 12);
  assert.equal(snapshotScore({ usage: null }, rows(9, 10, 12)).outputTokensPerTask, null);
  // Uncached input is shown per task; totals are for reference.
  const shown = snapshotScore(
    { usage: { input: 1000, output: 4000, cacheRead: 9000 }, minutes: 2 },
    rows(9, 10, 12),
  );
  assert.equal(shown.shown.uncachedInputTokensPerTask, 100);
  assert.deepEqual(shown.totals, {
    inputTokens: 1000,
    cachedInputTokens: 9000,
    outputTokens: 4000,
    agentSeconds: 120,
    wallMinutes: 2,
  });
});

test("repeated runs report the mean and range of each number", () => {
  const combined = combineScores([
    snapshotScore({ usage: { output: 4000 } }, rows(9, 10, 10)),
    snapshotScore({ usage: { output: 2000 } }, rows(7, 10, 20)),
  ]);
  assert.deepEqual(combined.solvedPercent, { mean: 80, min: 70, max: 90 });
  assert.deepEqual(combined.outputTokensPerTask, { mean: 300, min: 200, max: 400 });
  assert.deepEqual(combined.secondsPerTask, { mean: 15, min: 10, max: 20 });
  assert.equal(
    combineScores([snapshotScore({ usage: null }, rows(1, 2, 1))]).outputTokensPerTask,
    null,
  );
});
