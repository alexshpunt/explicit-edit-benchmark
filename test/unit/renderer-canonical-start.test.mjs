import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRunStart } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-run.mjs";
import {
  canonicalMultiAgentResult,
  CANONICAL_RUN_VERSION,
} from "../../src/suites/explicit-edit-multi-agent/canonical-results.mjs";
import { MULTI_AGENT_BENCHMARK } from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { CANONICAL_MULTI_AGENT_PROTOCOL } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-preparation.mjs";

function fixture() {
  const schedule = [1, 2, 3, 4].map((id) => ({
    id: `round-${String(id).padStart(3, "0")}`,
    assignments: [],
  }));
  return {
    initial: { "main.cpp": "initial" },
    schedule,
    atomicIntervals: {
      rounds: new Map(
        schedule.map((round, index) => [
          round.id,
          { expectedTree: { "main.cpp": `trusted-${index + 1}` } },
        ]),
      ),
    },
  };
}

test("a normal canonical run retains its full schedule and original trusted start", () => {
  const loaded = fixture();
  const result = canonicalRunStart(loaded);
  assert.deepEqual(result.schedule, loaded.schedule);
  assert.equal(result.initial, loaded.initial);
  assert.deepEqual(result.skippedRounds, []);
  assert.equal(result.mode, "measured");
});

test("starting at round four uses the exact trusted end of round three with no imported results", () => {
  const loaded = fixture(),
    original = structuredClone(loaded);
  const result = canonicalRunStart(loaded, 4);
  assert.deepEqual(
    result.schedule.map(({ id }) => id),
    ["round-004"],
  );
  assert.equal(result.initial, loaded.atomicIntervals.rounds.get("round-003").expectedTree);
  assert.deepEqual(result.skippedRounds, ["round-001", "round-002", "round-003"]);
  assert.equal(result.mode, "diagnostic-continuation");
  assert.deepEqual(loaded, original);
});

test("diagnostic starts cannot invent rounds or fall back to a different trusted baseline", () => {
  for (const value of [0, -1, 5, 1.5, "4", null, NaN, Infinity])
    assert.throws(() => canonicalRunStart(fixture(), value));
  const missing = fixture();
  missing.atomicIntervals.rounds.delete("round-003");
  assert.throws(() => canonicalRunStart(missing, 4));
});

test("a diagnostic continuation cannot masquerade as an exportable measured observation", () => {
  const { mode } = canonicalRunStart(fixture(), 4);
  const report = {
    version: CANONICAL_RUN_VERSION,
    benchmark: MULTI_AGENT_BENCHMARK,
    protocol: CANONICAL_MULTI_AGENT_PROTOCOL,
    mode,
  };
  assert.throws(
    () => canonicalMultiAgentResult(report),
    (error) =>
      error.code === "ERR_ASSERTION" && error.actual === mode && error.expected === "measured",
  );
});
