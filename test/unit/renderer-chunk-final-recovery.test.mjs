import assert from "node:assert/strict";
import test from "node:test";
import { runFinalChunkRecovery } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-final-recovery.mjs";

const structure = (differenceIds) => ({ differenceIds });
const integration = (buildPassed, resultMatched) => ({ buildPassed, resultMatched });

function setup({ initial = ["a", "b"], checks, final = [] }) {
  const events = [],
    attempts = [],
    snapshots = [];
  let index = 0;
  const options = {
    totalFiles: 19,
    async capture({ stage, assessStructure, measureIntegration }) {
      events.push(`capture:${stage}`);
      const result = {};
      if (assessStructure) result.structure = structure(stage === "original" ? initial : final);
      if (measureIntegration) result.integration = checks[index++];
      snapshots.push({ stage, assessStructure, measureIntegration });
      return result;
    },
    async structuralWave(run) {
      events.push("wave");
      await run();
    },
    async repairStructural({ id }) {
      events.push(`repair:${id}`);
    },
    async repairIntegration({ stage }) {
      events.push(`repair:${stage}`);
    },
    async onUpdate(state) {
      attempts.push(structuredClone(state.attempts));
    },
    score(input) {
      return input;
    },
  };
  return { options, events, attempts, snapshots };
}

test("structural assignments use one initial snapshot and no intermediate verification", async () => {
  const f = setup({ checks: [integration(true, true), integration(true, true)] });
  const result = await runFinalChunkRecovery(f.options);
  assert.deepEqual(f.events, [
    "capture:original",
    "wave",
    "repair:a",
    "repair:b",
    "capture:build-check",
    "capture:final",
  ]);
  assert.deepEqual(
    f.snapshots.filter((x) => x.assessStructure).map((x) => x.stage),
    ["original", "final"],
  );
  assert.deepEqual(result.score.initialDifferences, ["a", "b"]);
});

test("a corrected build with matching images does not spend result recovery", async () => {
  const f = setup({
    initial: [],
    checks: [integration(false, false), integration(true, true), integration(true, true)],
  });
  const result = await runFinalChunkRecovery(f.options);
  assert.deepEqual(f.events, [
    "capture:original",
    "capture:build-check",
    "repair:build-correction",
    "capture:build-recheck",
    "capture:final",
  ]);
  assert.equal(result.score.buildFirstPassed, false);
  assert.equal(result.score.firstImageMatched, true);
});
test("a twice-failed build gets one final result-recovery opportunity", async () => {
  const f = setup({
    initial: [],
    checks: [integration(false, false), integration(false, false), integration(true, true)],
  });
  const result = await runFinalChunkRecovery(f.options);
  assert.deepEqual(f.events, [
    "capture:original",
    "capture:build-check",
    "repair:build-correction",
    "capture:build-recheck",
    "repair:image-correction",
    "capture:final",
  ]);
  assert.equal(result.score.buildFirstPassed, false);
  assert.equal(result.score.firstImageMatched, null);
  assert.equal(result.score.finalImageMatched, true);
});

test("failed final build closes the budget without another attempt", async () => {
  const f = setup({
    initial: [],
    checks: [integration(false, false), integration(false, false), integration(false, false)],
  });
  const result = await runFinalChunkRecovery(f.options);
  assert.equal(f.events.filter((x) => x === "repair:image-correction").length, 1);
  assert.equal(result.score.finalBuildPassed, false);
});

test("a failed image check invokes exactly one result correction", async () => {
  const f = setup({ initial: [], checks: [integration(true, false), integration(true, true)] });
  const result = await runFinalChunkRecovery(f.options);
  assert.deepEqual(f.events, [
    "capture:original",
    "capture:build-check",
    "repair:image-correction",
    "capture:final",
  ]);
  assert.equal(result.score.firstImageMatched, false);
});

test("a timed-out structural repair is recorded and remaining repairs continue", async () => {
  const f = setup({ checks: [integration(true, true), integration(true, true)] });
  f.options.repairStructural = async ({ id }) => {
    f.events.push(`repair:${id}`);
    return id === "a" ? { timedOut: true } : undefined;
  };
  const result = await runFinalChunkRecovery(f.options);
  assert.deepEqual(
    result.attempts.map(({ status }) => status),
    ["timed-out", "settled"],
  );
  assert.deepEqual(f.events, [
    "capture:original",
    "wave",
    "repair:a",
    "repair:b",
    "capture:build-check",
    "capture:final",
  ]);
});

test("a timed-out build repair retains partial edits and advances to verification", async () => {
  const f = setup({
    initial: [],
    checks: [integration(false, false), integration(false, false), integration(true, true)],
  });
  f.options.repairIntegration = async ({ stage }) => {
    f.events.push(`repair:${stage}`);
    return stage === "build-correction" ? { timedOut: true } : undefined;
  };
  const result = await runFinalChunkRecovery(f.options);
  assert.deepEqual(
    result.attempts.map(({ status }) => status),
    ["timed-out", "settled"],
  );
  assert.equal(result.score.finalBuildPassed, true);
});

test("unissued repairs from an exhausted team are not marked successful", async () => {
  const f = setup({ checks: [integration(true, true), integration(true, true)] });
  f.options.repairStructural = async () => ({ unissued: true });
  const result = await runFinalChunkRecovery(f.options);
  assert.deepEqual(
    result.attempts.map(({ status }) => status),
    ["unissued", "unissued"],
  );
});
test("a cancelled repair never computes final score", async () => {
  const f = setup({ checks: [] });
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.repairStructural = async () => {
    controller.abort(Error("cancelled"));
  };
  f.options.score = () => assert.fail("must not score");
  await assert.rejects(runFinalChunkRecovery(f.options), /cancelled/);
  assert.equal(f.attempts.at(-1)[0].status, "error");
});
