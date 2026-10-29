import assert from "node:assert/strict";
import test from "node:test";
import { prepareCanonicalDiff } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";
import { runCanonicalRound } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-round.mjs";

const snapshot = (value, extra = false) => ({
  version: "canonical-round-fixture-v1",
  files: {
    "main.cpp": `int value = ${value};\n`,
    ...(extra ? { "extra.cpp": "int damage;\n" } : {}),
  },
});
const prepared = prepareCanonicalDiff(snapshot(0), snapshot(1));
const pass = { buildPassed: true, resultMatched: true };
const buildFailure = { buildPassed: false, resultMatched: false };
const imageFailure = { buildPassed: true, resultMatched: false };

function fixture({ snapshots = [snapshot(1)], measurements = [pass], failure, signal } = {}) {
  const events = [];
  let captured = 0,
    measured = 0,
    active = false;
  return {
    events,
    options: {
      prepared,
      signal,
      executeWave: async ({ stage, comparison, integration }) => {
        assert.equal(active, false);
        active = true;
        events.push({ kind: "execute", stage, comparison, integration });
        await Promise.resolve();
        active = false;
        if (failure) throw failure;
      },
      capture: async ({ stage }) => {
        assert.equal(active, false, "Capture must follow complete wave shutdown");
        events.push({ kind: "capture", stage });
        assert.ok(captured < snapshots.length);
        return { snapshot: snapshots[captured++], identity: `candidate-${captured}` };
      },
      measure: async (candidate, { stage }) => {
        assert.equal(active, false);
        assert.equal(candidate.identity, `candidate-${captured}`);
        events.push({ kind: "measure", stage });
        assert.ok(measured < measurements.length);
        return measurements[measured++];
      },
      onStage: async (row, { candidate }) => {
        assert.equal(candidate.identity, `candidate-${captured}`);
        events.push({ kind: "saved", stage: row.stage });
      },
    },
  };
}
const waves = (f) => f.events.filter(({ kind }) => kind === "execute").map(({ stage }) => stage);

test("an exact endpoint uses one drained wave and earns the full round score", async () => {
  const f = fixture();
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original"]);
  assert.deepEqual(
    f.events.map(({ kind }) => kind),
    ["execute", "capture", "saved", "measure"],
  );
  assert.equal(result.score.score, 100);
  assert.equal(result.structure.initialDifferences.length, 0);
  assert.equal(result.stages.length, 1);
});

test("one structural correction receives the supplied differences and only half credit", async () => {
  const f = fixture({ snapshots: [snapshot(0), snapshot(1)] });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "structural-correction"]);
  assert.deepEqual(
    f.events.find(({ stage }) => stage === "structural-correction").comparison.differenceIds,
    ["reference:0"],
  );
  assert.equal(result.score.structural.first.score, 0);
  assert.equal(result.score.score, 50);
  assert.deepEqual(result.structure.correctionDifferences, []);
  assert.equal(f.events.filter(({ kind }) => kind === "measure").length, 1);
});

test("an unresolved structural correction is retained without a third structural attempt", async () => {
  const f = fixture({ snapshots: [snapshot(0), snapshot(0)] });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "structural-correction"]);
  assert.equal(result.score.structural.final.rawBalance, -1);
  assert.equal(result.score.score, 0);
});

test("a build repair does not spend the independent image correction budget", async () => {
  const f = fixture({ snapshots: [snapshot(1), snapshot(1)], measurements: [buildFailure, pass] });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "build-correction"]);
  assert.deepEqual(result.build, { firstPassed: false, correctionUsed: true, finalPassed: true });
  assert.deepEqual(result.images, { firstPassed: true, correctionUsed: false, finalPassed: true });
  assert.equal(result.score.score, 75);
});

test("an image repair rebuilds actual changed source and receives its own factor", async () => {
  const f = fixture({ snapshots: [snapshot(1), snapshot(1)], measurements: [imageFailure, pass] });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "image-correction"]);
  assert.equal(result.score.score, 75);
  assert.equal(f.events.filter(({ kind }) => kind === "measure").length, 2);
  assert.deepEqual(result.structure.laterDifferences, [
    { stage: "image-correction", differences: [] },
  ]);
});

test("all four waves have independent fixed budgets and retain every candidate", async () => {
  const f = fixture({
    snapshots: [snapshot(0), snapshot(1), snapshot(1), snapshot(1)],
    measurements: [buildFailure, imageFailure, pass],
  });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), [
    "original",
    "structural-correction",
    "build-correction",
    "image-correction",
  ]);
  assert.equal(result.stages.length, 4);
  assert.equal(result.score.score, 28.125);
  assert.equal(f.events.filter(({ kind }) => kind === "saved").length, 4);
});

test("a still-unbuildable final candidate skips image repair and applies both failed factors", async () => {
  const f = fixture({
    snapshots: [snapshot(1), snapshot(1)],
    measurements: [buildFailure, buildFailure],
  });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "build-correction"]);
  assert.equal(result.images, null);
  assert.equal(result.score.score, 25);
});

test("an image correction cannot preserve earlier build success after breaking compilation", async () => {
  const f = fixture({
    snapshots: [snapshot(1), snapshot(1)],
    measurements: [imageFailure, buildFailure],
  });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "image-correction"]);
  assert.equal(result.build.finalPassed, false);
  assert.equal(result.score.build.factor, 0.5);
  assert.equal(result.score.images.factor, 0.5);
  assert.equal(result.score.score, 25);
});

test("integration repair damage costs structural credit even when the build and pixels pass", async () => {
  const f = fixture({
    snapshots: [snapshot(1), snapshot(1, true)],
    measurements: [imageFailure, pass],
  });
  const result = await runCanonicalRound(f.options);
  assert.equal(result.score.structural.first.score, 100);
  assert.equal(result.score.structural.final.rawBalance, 0);
  assert.equal(result.score.score, 0);
  assert.equal(result.structure.laterDifferences[0].differences.length, 1);
});

test("an unchanged integration disagreement is not debited again in a later repair", async () => {
  const f = fixture({
    snapshots: [snapshot(1), snapshot(1, true), snapshot(1, true)],
    measurements: [buildFailure, imageFailure, pass],
  });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(
    result.score.structural.ledger.map(({ change }) => change),
    [0, -1, 0],
  );
});

test("provider failures propagate unchanged without capture, repair or grading", async () => {
  const failure = Object.assign(new Error("provider fixture"), { category: "auth" });
  const f = fixture({ failure });
  await assert.rejects(runCanonicalRound(f.options), (error) => error === failure);
  assert.deepEqual(
    f.events.map(({ kind }) => kind),
    ["execute"],
  );
});

test("grading infrastructure failures propagate without an editing correction", async () => {
  const failure = Object.assign(new Error("grader fixture"), { category: "infrastructure" });
  const f = fixture();
  f.options.measure = async () => {
    throw failure;
  };
  await assert.rejects(runCanonicalRound(f.options), (error) => error === failure);
  assert.deepEqual(waves(f), ["original"]);
});

test("cancellation before a wave creates no participant and preserves its reason", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel fixture");
  controller.abort(reason);
  const f = fixture({ signal: controller.signal });
  await assert.rejects(runCanonicalRound(f.options), (error) => error === reason);
  assert.equal(f.events.length, 0);
});

test("contradictory integration receipts are infrastructure errors, not image failures", async () => {
  const f = fixture({ measurements: [{ buildPassed: false, resultMatched: true }] });
  await assert.rejects(runCanonicalRound(f.options));
  assert.deepEqual(waves(f), ["original"]);
});
