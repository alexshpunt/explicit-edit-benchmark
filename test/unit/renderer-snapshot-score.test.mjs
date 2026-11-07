import assert from "node:assert/strict";
import test from "node:test";
import {
  SNAPSHOT_SCORE_POLICY,
  snapshotScore,
} from "../../src/suites/explicit-edit-multi-agent/extraction/snapshot-run.mjs";

const { reference } = SNAPSHOT_SCORE_POLICY;
const rows = (solved, total, seconds) =>
  Array.from({ length: total }, (_, index) => ({
    passed: index < solved,
    started: new Date(0).toISOString(),
    ended: new Date(seconds * 1000).toISOString(),
  }));
const usage = (solved, scale = 1) => ({
  input: reference.input * solved * scale,
  output: reference.output * solved * scale,
});

test("the reference efficiency leaves only the squared solved share", () => {
  const score = snapshotScore({ usage: usage(100) }, rows(100, 100, reference.seconds));
  assert.equal(score.efficiency, 1);
  assert.equal(score.score, 100);
  const missed = snapshotScore({ usage: usage(90) }, rows(90, 100, (reference.seconds * 90) / 100));
  assert.ok(Math.abs(missed.score - 81) < 1e-9);
});

test("efficiency adjusts but cannot buy back missed tasks", () => {
  const cheap = snapshotScore({ usage: usage(100, 0.5) }, rows(100, 100, reference.seconds / 2));
  assert.ok(Math.abs(cheap.score - 100 * 2 ** 0.25) < 1e-9);
  // Giving up early: few tasks, little spent.
  const quitter = snapshotScore({ usage: usage(20, 0.1) }, rows(20, 100, reference.seconds / 50));
  assert.ok(quitter.score < 6);
  // Unknown usage scores time alone.
  const unknown = snapshotScore({ usage: null }, rows(100, 100, reference.seconds));
  assert.deepEqual(unknown.factors, { input: null, output: null, time: 1 });
  assert.equal(unknown.score, 100);
});
