import assert from "node:assert/strict";
import test from "node:test";
import { prepareLineDifferences } from "../../src/suites/explicit-edit-multi-agent/grading/line-differences.mjs";
import { runCanonicalRound } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-round.mjs";

const tree = (value, extra = false) => ({
  "main.cpp": `int value = ${value};\n`,
  ...(extra ? { "extra.cpp": "int damage;\n" } : {}),
});
// One changed line: its old form disappears and its new form appears.
const prepared = prepareLineDifferences(tree(0), tree(1));
const pass = { buildPassed: true, resultMatched: true };
const buildFailure = { buildPassed: false, resultMatched: false };
const imageFailure = { buildPassed: true, resultMatched: false };

/** Candidates are consumed by every capture; measurements by every integration check. */
function fixture({ candidates = [tree(1)], measurements = [pass, pass], failure, signal } = {}) {
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
        const candidate = candidates[Math.min(captured, candidates.length - 1)];
        captured++;
        return { units: { tree: candidate, extraUnits: [] }, identity: `candidate-${captured}` };
      },
      measure: async (candidate, { stage }) => {
        assert.equal(candidate.identity, `candidate-${captured}`);
        events.push({ kind: "measure", stage });
        assert.ok(measured < measurements.length, "Unexpected integration check");
        return measurements[measured++];
      },
    },
  };
}
const waves = (f) => f.events.filter(({ kind }) => kind === "execute").map(({ stage }) => stage);

test("an exact endpoint uses only the original wave and earns the full score", async () => {
  const f = fixture();
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original"]);
  assert.deepEqual(
    result.stages.map(({ stage }) => stage),
    ["original", "build-check", "final"],
  );
  assert.equal(prepared.totalUnits, 2);
  assert.equal(result.score.score, 100);
});

test("the structural correction receives the comparison and resolved lines earn a quarter", async () => {
  const f = fixture({ candidates: [tree(0), tree(1)] });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "structural-correction"]);
  const correction = f.events.find(({ stage }) => stage === "structural-correction");
  assert.equal(correction.comparison.differenceIds.length, 2);
  assert.equal(result.score.structural.rawBalance, 0.5);
  assert.equal(result.score.score, 25);
});

test("a failed build gets one build correction and the corrected factor", async () => {
  const f = fixture({ measurements: [buildFailure, pass, pass] });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "build-correction"]);
  assert.equal(result.score.build.factor, 0.75);
  assert.equal(result.score.images.factor, 1);
  assert.equal(result.score.score, 75);
});

test("a build that still fails gets the result correction as its last wave", async () => {
  const f = fixture({
    candidates: [tree(0), tree(1)],
    measurements: [buildFailure, buildFailure, buildFailure],
  });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), [
    "original",
    "structural-correction",
    "build-correction",
    "image-correction",
  ]);
  assert.equal(result.score.build.factor, 0.5);
  assert.equal(result.score.images.factor, 0.5);
});

test("an image failure gets one result correction", async () => {
  const f = fixture({ measurements: [imageFailure, pass] });
  const result = await runCanonicalRound(f.options);
  assert.deepEqual(waves(f), ["original", "image-correction"]);
  assert.equal(result.score.images.factor, 0.75);
});

test("damage introduced by a later correction costs one per new line difference", async () => {
  const f = fixture({ candidates: [tree(1), tree(1), tree(1, true)] });
  let checks = 0;
  f.options.measure = async () => (checks++ === 0 ? imageFailure : pass);
  const result = await runCanonicalRound(f.options);
  // The extra file costs its presence and its one line.
  assert.deepEqual(result.score.structural.introduced.length, 2);
  assert.equal(result.score.structural.rawBalance, 0);
});

test("participant failures and cancellation propagate without grading", async () => {
  const failure = Object.assign(new Error("provider stopped"), { category: "provider_failure" });
  const failed = fixture({ failure });
  await assert.rejects(runCanonicalRound(failed.options), (error) => error === failure);
  assert.equal(failed.events.filter(({ kind }) => kind === "capture").length, 0);
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  const cancelled = fixture({ signal: controller.signal });
  await assert.rejects(runCanonicalRound(cancelled.options), /stop/);
  assert.deepEqual(cancelled.events, []);
});

test("contradictory integration receipts are infrastructure errors", async () => {
  const f = fixture({ measurements: [{ buildPassed: false, resultMatched: true }] });
  await assert.rejects(runCanonicalRound(f.options));
});
