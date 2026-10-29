import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_SCORE_POLICY,
  canonicalStructuralScore,
  canonicalIntegrationFactor,
  canonicalRoundScore,
  scoreCanonicalRounds,
} from "../../src/suites/explicit-edit-multi-agent/grading/canonical-score.mjs";

const structure = (overrides = {}) => ({
  totalHunks: 10,
  initialDifferences: [],
  correctionDifferences: null,
  laterDifferences: [],
  ...overrides,
});
const pass = () => ({ firstPassed: true, correctionUsed: false, finalPassed: true });
const repaired = () => ({ firstPassed: false, correctionUsed: true, finalPassed: true });
const failed = () => ({ firstPassed: false, correctionUsed: true, finalPassed: false });
const round = (overrides = {}) => ({
  structure: structure(),
  build: pass(),
  images: pass(),
  ...overrides,
});

function stages(...names) {
  return names.map((stage) => ({ stage, differences: [] }));
}

test("structural scoring gives an unchanged agent zero and an exact first endpoint full credit", () => {
  const none = canonicalStructuralScore(
    structure({ totalHunks: 2, initialDifferences: ["reference:0", "reference:1"] }),
  );
  assert.equal(none.first.rawBalance, 0);
  assert.equal(none.first.normalized, 0);
  assert.equal(none.final.score, 0);
  const exact = canonicalStructuralScore(structure());
  assert.equal(exact.first.rawBalance, 10);
  assert.equal(exact.final.normalized, 1);
  assert.equal(exact.final.score, 100);
  assert.deepEqual(exact.initialDifferences, []);
});

test("one structural correction recovers half a point for each supplied disagreement resolved", () => {
  const result = canonicalStructuralScore(
    structure({ initialDifferences: ["c", "a", "b"], correctionDifferences: [] }),
  );
  assert.equal(result.first.score, 70);
  assert.equal(result.afterCorrection.rawBalance, 8.5);
  assert.equal(result.final.score, 85);
  assert.deepEqual(result.ledger[1].resolved, ["a", "b", "c"]);
  assert.deepEqual(result.ledger[1].unresolved, []);
});

test("each supplied unresolved correction incurs one additional point of penalty", () => {
  const result = canonicalStructuralScore(
    structure({ initialDifferences: ["a", "b", "c"], correctionDifferences: ["c"] }),
  );
  assert.equal(result.first.rawBalance, 7);
  assert.equal(result.final.rawBalance, 7);
  assert.deepEqual(result.ledger[1].resolved, ["a", "b"]);
  assert.deepEqual(result.ledger[1].unresolved, ["c"]);
  assert.equal(result.ledger[1].change, 0);
});

test("a correction cannot erase new damage behind the successful repair of an original mismatch", () => {
  const result = canonicalStructuralScore(
    structure({ initialDifferences: ["a"], correctionDifferences: ["b"] }),
  );
  assert.equal(result.final.rawBalance, 8.5);
  assert.equal(result.final.score, 85);
  assert.deepEqual(result.ledger[1].resolved, ["a"]);
  assert.deepEqual(result.ledger[1].introduced, ["b"]);
  assert.equal(result.ledger[1].change, -0.5);
});

test("negative raw balances survive before correction so clamping cannot manufacture recovery credit", () => {
  const result = canonicalStructuralScore(
    structure({ totalHunks: 1, initialDifferences: ["a", "b", "c"], correctionDifferences: [] }),
  );
  assert.equal(result.first.rawBalance, -2);
  assert.equal(result.first.score, 0);
  assert.equal(result.final.rawBalance, -0.5);
  assert.equal(result.final.score, 0);
});

test("later integration passes charge new regressions once and give no additional structural refunds", () => {
  const result = canonicalStructuralScore(
    structure({
      initialDifferences: ["a"],
      correctionDifferences: [],
      laterDifferences: [
        { stage: "build-correction", differences: ["a", "b"] },
        { stage: "image-correction", differences: ["b"] },
      ],
    }),
  );
  assert.equal(result.afterCorrection.rawBalance, 9.5);
  assert.equal(result.ledger[2].rawBalance, 7.5);
  assert.equal(result.ledger[3].rawBalance, 7.5);
  assert.equal(result.final.score, 75);
  assert.deepEqual(result.ledger[2].introduced, ["a", "b"]);
  assert.deepEqual(result.ledger[3].introduced, []);
  assert.deepEqual(result.ledger[3].resolved, ["a"]);
  assert.equal(result.ledger[3].change, 0);
});

test("the score does not mutate supplied mismatch arrays or integration checkpoints", () => {
  const input = structure({
    initialDifferences: ["b", "a"],
    correctionDifferences: ["a"],
    laterDifferences: [{ stage: "build-correction", differences: ["c", "a"] }],
  });
  const original = structuredClone(input);
  canonicalStructuralScore(input);
  assert.deepEqual(input, original);
});

test("structural evidence rejects invalid denominators, duplicate IDs and invalid correction sequences", () => {
  for (const totalHunks of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => canonicalStructuralScore(structure({ totalHunks })));
  }
  for (const initialDifferences of [null, new Set(["a"]), [""], [1], ["a", "a"]]) {
    assert.throws(() => canonicalStructuralScore(structure({ initialDifferences })));
  }
  assert.throws(() => canonicalStructuralScore(structure({ correctionDifferences: [] })));
  assert.throws(() =>
    canonicalStructuralScore(
      structure({ initialDifferences: ["a"], correctionDifferences: ["b", "b"] }),
    ),
  );
  assert.throws(() =>
    canonicalStructuralScore(
      structure({ initialDifferences: ["a"], laterDifferences: stages("build-correction") }),
    ),
  );
  for (const laterDifferences of [
    stages("unknown"),
    stages("build-correction", "build-correction"),
    stages("image-correction", "build-correction"),
    [{ stage: "build-correction", differences: ["a", "a"] }],
  ]) {
    assert.throws(() => canonicalStructuralScore(structure({ laterDifferences })));
  }
});

test("integration factors separate unassisted success, corrected success and final failure", () => {
  assert.equal(canonicalIntegrationFactor(pass()), 1);
  assert.equal(canonicalIntegrationFactor(repaired()), 0.75);
  assert.equal(canonicalIntegrationFactor(failed()), 0.5);
  assert.equal(
    canonicalIntegrationFactor({ firstPassed: true, correctionUsed: false, finalPassed: false }),
    0.5,
  );
  for (const invalid of [
    null,
    {},
    { ...pass(), firstPassed: 1 },
    { firstPassed: false, correctionUsed: false, finalPassed: true },
    { firstPassed: true, correctionUsed: true, finalPassed: true },
  ]) {
    assert.throws(() => canonicalIntegrationFactor(invalid));
  }
});

test("a final unbuildable candidate receives both the failed-build and unavailable-image factors", () => {
  const result = canonicalRoundScore(
    round({
      structure: structure({ laterDifferences: stages("build-correction") }),
      build: failed(),
      images: null,
    }),
  );
  assert.equal(result.build.factor, 0.5);
  assert.equal(result.images.factor, 0.5);
  assert.equal(result.images.available, false);
  assert.equal(result.normalized, 0.25);
  assert.equal(result.score, 25);
});

test("corrected build and corrected images multiply their independent three-quarter factors", () => {
  const result = canonicalRoundScore(
    round({
      structure: structure({ laterDifferences: stages("build-correction", "image-correction") }),
      build: repaired(),
      images: repaired(),
    }),
  );
  assert.equal(result.build.factor, 0.75);
  assert.equal(result.images.factor, 0.75);
  assert.equal(result.normalized, 0.5625);
  assert.equal(result.score, 56.25);
});

test("a later broken build cannot retain an earlier success or claim successful final images", () => {
  const build = { firstPassed: true, correctionUsed: false, finalPassed: false };
  const images = { firstPassed: false, correctionUsed: true, finalPassed: false };
  const result = canonicalRoundScore(
    round({
      structure: structure({ laterDifferences: stages("image-correction") }),
      build,
      images,
    }),
  );
  assert.equal(result.normalized, 0.25);
  assert.equal(result.images.available, false);
  assert.throws(() => canonicalRoundScore(round({ build, images: pass() })));
});

test("completed round evidence requires each correction's structural checkpoint and all applicable outcomes", () => {
  assert.throws(() =>
    canonicalRoundScore(round({ structure: structure({ initialDifferences: ["a"] }) })),
  );
  assert.throws(() => canonicalRoundScore(round({ images: null })));
  assert.throws(() => canonicalRoundScore(round({ build: repaired() })));
  assert.throws(() =>
    canonicalRoundScore(
      round({ structure: structure({ laterDifferences: stages("build-correction") }) }),
    ),
  );
  assert.throws(() =>
    canonicalRoundScore(
      round({
        build: { firstPassed: false, correctionUsed: false, finalPassed: false },
        images: null,
      }),
    ),
  );
});

test("round scores retain the full planned denominator without weighting by hunk counts", () => {
  const rows = [
    { round: "round-001", ...round({ structure: structure({ totalHunks: 1 }) }) },
    {
      round: "round-002",
      ...round({
        structure: structure({
          totalHunks: 100,
          initialDifferences: ["a"],
          correctionDifferences: [],
        }),
      }),
    },
  ];
  const result = scoreCanonicalRounds(rows, 4);
  assert.equal(result.observedRounds, 2);
  assert.equal(result.complete, false);
  assert.equal(result.score, 49.875);
  assert.equal(result.firstStructuralScore, 49.75);
  const complete = scoreCanonicalRounds(rows, 2);
  assert.equal(complete.complete, true);
  assert.equal(complete.score, 99.75);
  assert.equal(result.version, CANONICAL_SCORE_POLICY.version);
});

test("aggregation rejects duplicate, excess or malformed round records and recomputes claimed scores", () => {
  for (const plannedRounds of [0, -1, 1.5, Infinity])
    assert.throws(() => scoreCanonicalRounds([], plannedRounds));
  const row = { round: "round-001", ...round() };
  assert.throws(() => scoreCanonicalRounds([row, row], 2));
  assert.throws(() => scoreCanonicalRounds([row, { ...row, round: "round-002" }], 1));
  assert.throws(() => scoreCanonicalRounds([{ ...row, round: "" }], 1));
  assert.equal(scoreCanonicalRounds([{ ...row, score: 0, normalized: 0 }], 1).score, 100);
  assert.equal(scoreCanonicalRounds([], 3).score, 0);
});
