import assert from "node:assert/strict";

export const CANONICAL_SCORE_POLICY = Object.freeze({
  version: "renderer-canonical-score-v1",
  correctionCredit: 0.5,
  unresolvedCorrectionPenalty: 1,
  newDifferencePenalty: 1,
  integration: Object.freeze({ unassisted: 1, corrected: 0.75, failed: 0.5 }),
});

const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const integrationStages = ["build-correction", "image-correction"];

function identifiers(value) {
  assert.ok(Array.isArray(value), "Difference evidence must be an array");
  const result = new Set();
  for (const id of value) {
    assert.ok(typeof id === "string" && id.length > 0, "Invalid difference identity");
    assert.ok(!result.has(id), "Repeated difference identity");
    result.add(id);
  }
  return [...result].sort(order);
}

function comparison(previous, current) {
  const before = new Set(previous);
  const after = new Set(current);
  return {
    resolved: previous.filter((id) => !after.has(id)),
    unresolved: previous.filter((id) => after.has(id)),
    introduced: current.filter((id) => !before.has(id)),
  };
}

function balance(ticks, totalHunks) {
  assert.ok(Number.isSafeInteger(ticks), "Structural balance exceeded exact half-point accounting");
  const normalized = Math.max(0, Math.min(1, ticks / (2 * totalHunks)));
  return { rawBalance: ticks / 2, normalized, score: 100 * normalized };
}

/** Count canonical mismatch IDs, independent of original tasks and their executors.
 * laterDifferences contains chronological {stage, differences} checkpoints for
 * actual build/image correction waves, not repeated read-only observations.
 * @param {{totalHunks: number, initialDifferences: string[], correctionDifferences?: string[] | null, laterDifferences?: unknown[]}} input
 */
export function canonicalStructuralScore({
  totalHunks,
  initialDifferences,
  correctionDifferences = null,
  laterDifferences = [],
}) {
  assert.ok(
    Number.isSafeInteger(totalHunks) &&
      totalHunks > 0 &&
      totalHunks <= Math.floor(Number.MAX_SAFE_INTEGER / 2),
    "Invalid canonical hunk denominator",
  );
  const initial = identifiers(initialDifferences);
  assert.ok(Array.isArray(laterDifferences), "Invalid integration checkpoint list");
  const correction = correctionDifferences === null ? null : identifiers(correctionDifferences);
  assert.ok(
    correction === null || initial.length > 0,
    "A successful structural pass cannot receive a correction",
  );
  assert.ok(
    initial.length === 0 || correction !== null || laterDifferences.length === 0,
    "Integration began before the structural correction finished",
  );
  const checkpoints = [];
  let previousStage = -1;
  for (const checkpoint of laterDifferences) {
    assert.ok(checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint));
    assert.ok(
      "stage" in checkpoint && typeof checkpoint.stage === "string",
      "Invalid integration checkpoint stage",
    );
    assert.ok("differences" in checkpoint, "Missing integration checkpoint differences");
    const stage = checkpoint.stage;
    const stageIndex = integrationStages.indexOf(stage);
    assert.ok(
      stageIndex > previousStage,
      "Integration checkpoints must follow the correction budgets",
    );
    previousStage = stageIndex;
    checkpoints.push({ stage, differences: identifiers(checkpoint.differences) });
  }
  let ticks = 2 * (totalHunks - initial.length);
  const first = balance(ticks, totalHunks);
  const ledger = [
    {
      stage: "initial",
      differences: initial,
      resolved: [],
      unresolved: [],
      introduced: initial,
      change: -initial.length,
      ...first,
    },
  ];
  let current = initial;
  if (correction !== null) {
    const delta = comparison(initial, correction);
    const change =
      CANONICAL_SCORE_POLICY.correctionCredit * delta.resolved.length -
      CANONICAL_SCORE_POLICY.unresolvedCorrectionPenalty * delta.unresolved.length -
      CANONICAL_SCORE_POLICY.newDifferencePenalty * delta.introduced.length;
    ticks += 2 * change;
    ledger.push({
      stage: "structural-correction",
      differences: correction,
      ...delta,
      change,
      ...balance(ticks, totalHunks),
    });
    current = correction;
  }
  const afterCorrection = balance(ticks, totalHunks);
  for (const checkpoint of checkpoints) {
    const delta = comparison(current, checkpoint.differences);
    // The structural refund budget is exhausted. Disappearing differences in an
    // integration repair do not restore credit; fresh regressions still cost it.
    const change = 0 - CANONICAL_SCORE_POLICY.newDifferencePenalty * delta.introduced.length;
    ticks += 2 * change;
    ledger.push({ ...checkpoint, ...delta, change, ...balance(ticks, totalHunks) });
    current = checkpoint.differences;
  }
  return {
    version: CANONICAL_SCORE_POLICY.version,
    totalHunks,
    initialDifferences: initial,
    correctionDifferences: correction,
    laterDifferences: checkpoints,
    correctionComplete: initial.length === 0 || correction !== null,
    ledger,
    first,
    afterCorrection,
    final: balance(ticks, totalHunks),
  };
}

/** The final outcome overrides earlier success; only a real used correction gets 0.75. */
export function canonicalIntegrationFactor(outcome) {
  assert.ok(outcome && typeof outcome === "object" && !Array.isArray(outcome));
  for (const key of ["firstPassed", "correctionUsed", "finalPassed"])
    assert.equal(typeof outcome[key], "boolean", "Missing integration outcome");
  assert.ok(
    !outcome.firstPassed || !outcome.correctionUsed,
    "An initially successful stage cannot use a correction",
  );
  assert.ok(
    outcome.firstPassed || outcome.correctionUsed || !outcome.finalPassed,
    "An unsuccessful stage cannot pass without a correction",
  );
  if (!outcome.finalPassed) return CANONICAL_SCORE_POLICY.integration.failed;
  return outcome.correctionUsed
    ? CANONICAL_SCORE_POLICY.integration.corrected
    : CANONICAL_SCORE_POLICY.integration.unassisted;
}

/** Recompute one completed round from its mismatch ledger and measured stage outcomes. */
export function canonicalRoundScore({ structure, build, images }) {
  const structural = canonicalStructuralScore(structure);
  assert.ok(structural.correctionComplete, "The structural correction has not finished");
  const buildFactor = canonicalIntegrationFactor(build);
  assert.ok(
    build.firstPassed || build.correctionUsed,
    "The failed build has not received its correction",
  );
  const stages = new Set(structural.laterDifferences.map(({ stage }) => stage));
  assert.equal(
    stages.has("build-correction"),
    build.correctionUsed,
    "Build correction snapshot is missing or unexpected",
  );
  let imageFactor;
  if (images === null) {
    assert.equal(build.finalPassed, false, "A buildable final candidate requires an image outcome");
    imageFactor = CANONICAL_SCORE_POLICY.integration.failed;
  } else {
    imageFactor = canonicalIntegrationFactor(images);
    assert.ok(
      !images.finalPassed || build.finalPassed,
      "Image success requires the final candidate to build",
    );
    if (build.finalPassed)
      assert.ok(
        images.firstPassed || images.correctionUsed,
        "The failed images have not received their correction",
      );
    else imageFactor = CANONICAL_SCORE_POLICY.integration.failed;
  }
  assert.equal(
    stages.has("image-correction"),
    images?.correctionUsed ?? false,
    "Image correction snapshot is missing or unexpected",
  );
  const normalized = structural.final.normalized * buildFactor * imageFactor;
  return {
    version: CANONICAL_SCORE_POLICY.version,
    structural,
    build: {
      firstPassed: build.firstPassed,
      correctionUsed: build.correctionUsed,
      finalPassed: build.finalPassed,
      factor: buildFactor,
    },
    images: {
      available: build.finalPassed,
      firstPassed: images?.firstPassed ?? null,
      correctionUsed: images?.correctionUsed ?? false,
      finalPassed: images?.finalPassed ?? false,
      factor: imageFactor,
    },
    normalized,
    score: 100 * normalized,
  };
}

/** Equal-round aggregation uses every planned round, including unobserved ones. */
export function scoreCanonicalRounds(rounds, plannedRounds) {
  assert.ok(
    Number.isSafeInteger(plannedRounds) && plannedRounds > 0,
    "Invalid planned canonical rounds",
  );
  assert.ok(Array.isArray(rounds) && rounds.length <= plannedRounds, "Excess canonical rounds");
  const seen = new Set();
  let finalSum = 0;
  let firstStructuralSum = 0;
  for (const outcome of rounds) {
    assert.ok(
      typeof outcome.round === "string" && outcome.round.length > 0,
      "Missing canonical round identity",
    );
    assert.ok(!seen.has(outcome.round), "Repeated canonical round identity");
    seen.add(outcome.round);
    const recomputed = canonicalRoundScore(outcome);
    finalSum += recomputed.normalized;
    firstStructuralSum += recomputed.structural.first.normalized;
  }
  return {
    version: CANONICAL_SCORE_POLICY.version,
    plannedRounds,
    observedRounds: rounds.length,
    complete: rounds.length === plannedRounds,
    normalized: finalSum / plannedRounds,
    score: (100 * finalSum) / plannedRounds,
    firstStructuralScore: (100 * firstStructuralSum) / plannedRounds,
  };
}
