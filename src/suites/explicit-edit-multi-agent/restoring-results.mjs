import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MULTI_AGENT_BENCHMARK, validateAtomicParents, atomicDeliveryIds } from "./results.mjs";
import { ROUND_SCORE_POLICY, roundScore, scoreRounds } from "./grading/round-score.mjs";

export const RESTORING_MULTI_AGENT_PROTOCOL = "shared-project-restoring-v2";
export const RESTORING_MULTI_AGENT_VERSION = "2";
export const RESTORING_MULTI_AGENT_RESULT_VERSION = "renderer-multi-agent-result-v2";
export const RESTORING_MULTI_AGENT_POLICY = Object.freeze({
  version: "renderer-restoring-policy-v2",
  trialTimeoutMs: null,
  attemptTimeoutMs: null,
  oracleRecoveries: 5,
  workspace: "shared-live",
  participants: "maximum-occupancy-persistent-processes",
  assignment: "balanced-team-dependency-queues",
  grading: "original-atom-binary-final-shared-candidate",
  roundWeight: "equal-maxima-all-planned-rounds",
  primary: "final-attempt-first-retained",
  bonuses: "independent-build-and-repeated-pixels",
  integrity: ROUND_SCORE_POLICY.integrity,
  restoration: "canonical-end-current-round-after-pass-or-exhaustion",
  idle: "queue-notices-until-next-assignment-no-inference",
});

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const statuses = new Set(["complete", "driver_exit", "infrastructure", "cancelled"]);
const failureCategories = new Set([
  "provider_failure",
  "authentication",
  "driver_exit",
  "runtime",
  "infrastructure",
  "cancelled",
]);
const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"];
const outcomeKeys = [
  "passedAtoms",
  "totalAtoms",
  "buildPassed",
  "resultMatched",
  "integrityPassed",
];
const identityKeys = [
  "workloadSha256",
  "graphSha256",
  "scheduleSha256",
  "contractsSha256",
  "initial",
  "expectedFinal",
  "final",
  "verifierSha256",
  "runnerSha256",
  "plannedAtomsSha256",
];
const configurationKeys = [
  "agents",
  "batchSize",
  "graphWidth",
  "model",
  "thinking",
  "harness",
  "runtime",
];
const number = (value) =>
  assert.ok(Number.isFinite(value) && value >= 0, "Invalid nonnegative measurement");
const integer = (value, minimum = 0) =>
  assert.ok(Number.isSafeInteger(value) && value >= minimum, "Invalid integer measurement");
const digest = (value) =>
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Invalid source identity");
function keys(value, fields) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected result object");
  assert.deepEqual(
    Object.keys(value).sort(),
    [...fields].sort(),
    "Unexpected restoring result fields",
  );
}
function safeLabel(value, nullable = false) {
  if (nullable && value === null) return;
  assert.ok(
    typeof value === "string" && /^[a-z0-9][a-z0-9._:+/@-]*$/i.test(value),
    "Invalid public identity",
  );
  assert.doesNotMatch(
    value,
    /(?:^|[/:])(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)|(?:^|[/:])(?:root|home)\//i,
    "Private public identity",
  );
}
function policy(value) {
  keys(value, [...Object.keys(RESTORING_MULTI_AGENT_POLICY), "buildWeight", "resultWeight"]);
  assert.deepEqual(
    Object.fromEntries(Object.keys(RESTORING_MULTI_AGENT_POLICY).map((key) => [key, value[key]])),
    RESTORING_MULTI_AGENT_POLICY,
    "Unsupported restoring methodology",
  );
  roundScore(
    {
      passedAtoms: 0,
      totalAtoms: 1,
      buildPassed: false,
      resultMatched: false,
      integrityPassed: true,
    },
    value,
  );
  return { ...value };
}
function configuration(value) {
  keys(value, configurationKeys);
  for (const field of ["agents", "batchSize", "graphWidth"]) integer(value[field], 1);
  for (const field of ["model", "thinking"]) safeLabel(value[field], true);
  if (value.harness !== null) {
    if (typeof value.harness === "string") safeLabel(value.harness);
    else {
      keys(value.harness, ["id", "kind", "version"]);
      for (const field of ["id", "kind", "version"]) safeLabel(value.harness[field]);
    }
  }
  if (value.runtime !== null) {
    keys(value.runtime, ["agent", "version", "platform", "architecture"]);
    for (const item of Object.values(value.runtime)) safeLabel(item);
  }
}
function plannedAtoms(value, totalRounds, totalAtoms) {
  assert.ok(Array.isArray(value) && value.length === totalRounds, "Incomplete planned denominator");
  let total = 0;
  for (const [index, item] of value.entries()) {
    keys(item, ["round", "totalAtoms"]);
    assert.equal(item.round, `round-${String(index + 1).padStart(3, "0")}`);
    integer(item.totalAtoms, 1);
    total += item.totalAtoms;
  }
  assert.equal(total, totalAtoms, "Original atom denominator differs");
}
function outcome(value, weights) {
  for (const field of ["buildPassed", "resultMatched", "integrityPassed"])
    assert.equal(typeof value[field], "boolean", "Missing independent candidate outcome");
  const measured = Object.fromEntries(outcomeKeys.map((key) => [key, value[key]]));
  return roundScore(measured, weights);
}
function passed(value) {
  return (
    value.passedAtoms === value.totalAtoms &&
    value.buildPassed &&
    value.resultMatched &&
    value.integrityPassed
  );
}
function comparisonKey(result) {
  const { final: _candidate, ...identity } = result.identity;
  return hash({
    protocol: result.protocol,
    identity,
    agents: result.configuration.agents,
    batchSize: result.configuration.batchSize,
    runtime: result.configuration.runtime,
    harness: result.configuration.harness,
    policy: result.policy,
  });
}

/** Validate safe restored-round evidence and recompute every score from its measurements. */
export function validateRestoringMultiAgentResult(result) {
  keys(result, [
    "schemaVersion",
    "benchmark",
    "protocol",
    "mode",
    "status",
    "identity",
    "configuration",
    "policy",
    "plannedAtoms",
    "rounds",
    "progress",
    "score",
    "execution",
    "terminal",
    "usage",
    "comparisonKey",
  ]);
  assert.equal(result.schemaVersion, RESTORING_MULTI_AGENT_RESULT_VERSION);
  assert.equal(result.benchmark, MULTI_AGENT_BENCHMARK);
  assert.equal(result.protocol, RESTORING_MULTI_AGENT_PROTOCOL);
  assert.ok(["reference", "measured"].includes(result.mode));
  assert.ok(statuses.has(result.status));
  keys(result.identity, identityKeys);
  for (const [field, value] of Object.entries(result.identity))
    if (!(field === "final" && value === null && result.status !== "complete")) digest(value);
  configuration(result.configuration);
  policy(result.policy);
  keys(result.progress, [
    "totalTasks",
    "totalRounds",
    "totalAtoms",
    "observedRounds",
    "observedAtoms",
    "completion",
  ]);
  const progress = result.progress;
  for (const field of ["totalTasks", "totalRounds", "totalAtoms"]) integer(progress[field], 1);
  integer(progress.observedRounds);
  integer(progress.observedAtoms);
  assert.ok(progress.observedRounds <= progress.totalRounds);
  assert.ok(progress.observedAtoms <= progress.totalAtoms);
  plannedAtoms(result.plannedAtoms, progress.totalRounds, progress.totalAtoms);
  assert.equal(hash(result.plannedAtoms), result.identity.plannedAtomsSha256);
  assert.ok(Array.isArray(result.rounds) && result.rounds.length === progress.observedRounds);
  const first = [],
    final = [];
  let observedAtoms = 0;
  for (const [index, round] of result.rounds.entries()) {
    keys(round, ["round", "attempts", "first", "final", "restoration"]);
    assert.equal(round.round, result.plannedAtoms[index].round, "Observed rounds are not a prefix");
    integer(round.attempts, 1);
    assert.ok(round.attempts <= RESTORING_MULTI_AGENT_POLICY.oracleRecoveries + 1);
    if (result.mode === "reference") assert.equal(round.attempts, 1);
    for (const field of ["first", "final"]) {
      const recomputed = outcome(round[field], result.policy);
      assert.deepEqual(round[field], recomputed, "Round score contradicts independent evidence");
      assert.equal(round[field].totalAtoms, result.plannedAtoms[index].totalAtoms);
    }
    if (round.attempts === 1) assert.deepEqual(round.first, round.final);
    else assert.ok(!passed(round.first), "Correction followed a successful first attempt");
    if (!passed(round.final))
      assert.equal(round.attempts, 6, "Editing exhaustion lacks five corrections");
    if (result.mode === "reference") assert.ok(passed(round.final), "Reference endpoint failed");
    keys(round.restoration, ["status", "identity"]);
    assert.equal(round.restoration.status, "pass");
    digest(round.restoration.identity);
    first.push({ round: round.round, ...round.first });
    final.push({ round: round.round, ...round.final });
    observedAtoms += round.final.totalAtoms;
  }
  assert.equal(progress.observedAtoms, observedAtoms);
  assert.equal(progress.completion, progress.observedRounds / progress.totalRounds);
  keys(result.score, ["first", "final"]);
  assert.deepEqual(result.score.first, scoreRounds(first, progress.totalRounds, result.policy));
  assert.deepEqual(result.score.final, scoreRounds(final, progress.totalRounds, result.policy));
  if (result.status === "complete") {
    assert.equal(progress.observedRounds, progress.totalRounds);
    assert.equal(result.identity.final, result.identity.expectedFinal);
    assert.equal(result.rounds.at(-1).restoration.identity, result.identity.expectedFinal);
    assert.equal(result.terminal, null);
  } else {
    keys(result.terminal, ["round", "category", "failureCategory"]);
    assert.ok(
      result.terminal.failureCategory === null ||
        failureCategories.has(result.terminal.failureCategory),
    );
    assert.equal(result.terminal.category, result.status);
    assert.ok(
      result.terminal.round === null ||
        result.plannedAtoms.some((item) => item.round === result.terminal.round),
    );
  }
  keys(result.execution, ["deliveries", "repairs", "elapsedMs", "agentsClosed"]);
  integer(result.execution.deliveries);
  integer(result.execution.repairs);
  assert.ok(result.execution.repairs <= result.execution.deliveries);
  number(result.execution.elapsedMs);
  assert.equal(typeof result.execution.agentsClosed, "boolean");
  if (result.status === "complete") assert.equal(result.execution.agentsClosed, true);
  if (result.usage !== null) {
    keys(result.usage, usageKeys);
    for (const value of Object.values(result.usage)) if (value !== null) number(value);
  }
  assert.equal(result.comparisonKey, comparisonKey(result), "Comparison identity differs");
  return result;
}

/** Export no prompts, source tokens, diagnostic text, paths or native events. */
export function restoringMultiAgentResult(raw) {
  assert.equal(raw.version, "renderer-concurrent-restoring-run-v2");
  assert.equal(raw.benchmark, MULTI_AGENT_BENCHMARK);
  assert.equal(raw.protocol, RESTORING_MULTI_AGENT_PROTOCOL);
  assert.ok(statuses.has(raw.status), "Only terminal restoring runs can be exported");
  assert.ok(Array.isArray(raw.schedule) && raw.schedule.length > 0);
  assert.equal(hash(raw.schedule), raw.scheduleSha256, "Schedule identity differs");
  assert.equal(raw.totalRounds, raw.schedule.length);
  plannedAtoms(raw.plannedAtoms, raw.totalRounds, raw.totalAtoms);
  const config = Object.fromEntries(configurationKeys.map((key) => [key, raw[key] ?? null]));
  if (config.runtime)
    config.runtime = Object.fromEntries(
      ["agent", "version", "platform", "architecture"].map((key) => [key, raw.runtime[key]]),
    );
  configuration(config);
  const tasks = new Set();
  for (const [index, round] of raw.schedule.entries()) {
    assert.equal(round.id, raw.plannedAtoms[index].round);
    assert.ok(Array.isArray(round.assignments) && round.assignments.length > 0);
    for (const assignment of round.assignments) {
      integer(assignment.agent);
      assert.ok(assignment.agent < raw.agents);
      assert.ok(typeof assignment.task === "string" && /^task-\d{3,}$/.test(assignment.task));
      assert.ok(!tasks.has(assignment.task), "Repeated scheduled task");
      tasks.add(assignment.task);
    }
  }
  assert.equal(tasks.size, raw.totalTasks);
  keys(raw.contractHashes, ["initial", ...raw.schedule.map((item) => item.id)]);
  for (const value of Object.values(raw.contractHashes)) digest(value);
  for (const [field, identityField] of [
    ["roundEndpoints", "identity"],
    ["roundInventories", "sha256"],
  ]) {
    assert.ok(Array.isArray(raw[field]) && raw[field].length === raw.totalRounds);
    for (const [index, entry] of raw[field].entries()) {
      keys(entry, ["round", identityField]);
      assert.equal(entry.round, raw.plannedAtoms[index].round);
      digest(entry[identityField]);
    }
  }
  assert.ok(Array.isArray(raw.rounds));
  const rounds = raw.rounds.map((round, index) => {
    assert.equal(round.round, raw.plannedAtoms[index]?.round, "Observed rounds are not a prefix");
    assert.ok(Array.isArray(round.attempts) && round.attempts.length > 0);
    assert.equal(round.restoration?.identity, raw.roundEndpoints[index].identity);
    assert.equal(round.firstAttempt, 1);
    assert.equal(round.finalAttempt, round.attempts.length);
    for (const [attemptIndex, attempt] of round.attempts.entries()) {
      assert.equal(attempt.attempt, attemptIndex + 1);
      assert.equal(attempt.totalAtoms, raw.plannedAtoms[index].totalAtoms);
      outcome(attempt, raw.policy);
      if (attemptIndex < round.attempts.length - 1)
        assert.ok(!passed(attempt), "Corrections followed joint success");
    }
    return {
      round: round.round,
      attempts: round.attempts.length,
      first: outcome(round.attempts[0], raw.policy),
      final: outcome(round.attempts.at(-1), raw.policy),
      restoration: { status: round.restoration?.status, identity: round.restoration?.identity },
    };
  });
  assert.ok(Array.isArray(raw.executions));
  let previous = -1;
  const initialCoverage = new Map(),
    delivered = new Set();
  for (const delivery of raw.executions) {
    const position = raw.schedule.findIndex((item) => item.id === delivery.round);
    assert.ok(position >= 0 && position <= rounds.length, "Delivery exceeded current round");
    integer(delivery.attempt, 1);
    assert.ok(delivery.attempt <= 6);
    const order = position * 6 + delivery.attempt;
    assert.ok(order >= previous, "Delivery moved to an earlier attempt");
    previous = order;
    integer(delivery.agent);
    assert.ok(delivery.agent < raw.agents);
    const availableParents = raw.schedule
      .slice(0, position + 1)
      .flatMap((item) => item.assignments.map((assignment) => assignment.task));
    validateAtomicParents(
      delivery,
      delivery.tasks,
      raw.schedule[position].assignments.map((item) => item.task),
      { availableParents, batchSize: raw.batchSize },
    );
    assert.ok(["settled", "error"].includes(delivery.status));
    if (delivery.deliveryKind)
      assert.ok(delivery.attempt > 1 && delivery.atomicId.startsWith(`repair-${delivery.round}-`));
    for (const id of delivery.repairIds ?? atomicDeliveryIds(delivery)) {
      const key = `${delivery.round}:${delivery.attempt}:${id}`;
      assert.ok(!delivered.has(key), "Duplicate atomic delivery");
      delivered.add(key);
    }
    if (position < rounds.length) {
      assert.ok(delivery.attempt <= rounds[position].attempts);
      const receipt = delivery.receipt ?? {};
      assert.ok(
        delivery.status === "settled" &&
          !receipt.providerFailure &&
          !receipt.timedOut &&
          !receipt.eventErrors &&
          (receipt.exitCode == null || receipt.exitCode === 0),
        "Observed round contains an unsettled delivery",
      );
    }
    if (delivery.attempt === 1) {
      assert.ok(!delivery.deliveryKind, "Initial delivery claims repair work");
      const ids = initialCoverage.get(delivery.round) ?? new Set();
      for (const id of atomicDeliveryIds(delivery)) {
        assert.ok(!ids.has(id));
        ids.add(id);
      }
      initialCoverage.set(delivery.round, ids);
    }
  }
  for (const round of rounds) {
    assert.equal(
      initialCoverage.get(round.round)?.size,
      round.final.totalAtoms,
      "Original atom delivery coverage differs",
    );
    const inventory = raw.roundInventories[rounds.indexOf(round)].sha256;
    assert.equal(hash([...initialCoverage.get(round.round)].sort()), inventory);
    for (let attempt = 1; attempt <= round.attempts; attempt++)
      assert.ok(
        raw.executions.some((item) => item.round === round.round && item.attempt === attempt),
        "Measured attempt lacks deliveries",
      );
  }
  assert.equal(raw.deliveries, raw.executions.length);
  assert.equal(raw.repairs, raw.executions.filter((item) => item.attempt > 1).length);
  const identity = Object.fromEntries(
    [
      "workloadSha256",
      "graphSha256",
      "scheduleSha256",
      "initial",
      "expectedFinal",
      "final",
      "verifierSha256",
      "runnerSha256",
    ].map((key) => [key, raw[key]]),
  );
  identity.contractsSha256 = hash(
    ["initial", ...raw.schedule.map((item) => item.id)].map((id) => [id, raw.contractHashes[id]]),
  );
  identity.plannedAtomsSha256 = hash(raw.plannedAtoms);
  const result = {
    schemaVersion: RESTORING_MULTI_AGENT_RESULT_VERSION,
    benchmark: raw.benchmark,
    protocol: raw.protocol,
    mode: raw.mode,
    status: raw.status,
    identity,
    configuration: config,
    policy: policy(raw.policy),
    plannedAtoms: raw.plannedAtoms.map((item) => ({ ...item })),
    rounds,
    progress: {
      totalTasks: raw.totalTasks,
      totalRounds: raw.totalRounds,
      totalAtoms: raw.totalAtoms,
      observedRounds: rounds.length,
      observedAtoms: rounds.reduce((sum, item) => sum + item.final.totalAtoms, 0),
      completion: rounds.length / raw.totalRounds,
    },
    score: {
      first: scoreRounds(
        rounds.map((item) => ({ round: item.round, ...item.first })),
        raw.totalRounds,
        raw.policy,
      ),
      final: scoreRounds(
        rounds.map((item) => ({ round: item.round, ...item.final })),
        raw.totalRounds,
        raw.policy,
      ),
    },
    execution: {
      deliveries: raw.deliveries,
      repairs: raw.repairs,
      elapsedMs: raw.elapsedMs,
      agentsClosed:
        Array.isArray(raw.agentsClosed) &&
        raw.agentsClosed.length === raw.agents &&
        raw.agentsClosed.every((value) => value === true),
    },
    terminal:
      raw.status === "complete"
        ? null
        : {
            round: raw.terminal?.id ?? null,
            category: raw.status,
            failureCategory: failureCategories.has(raw.terminal?.category)
              ? raw.terminal.category
              : null,
          },
    usage: raw.usage
      ? Object.fromEntries(usageKeys.map((key) => [key, raw.usage[key] ?? null]))
      : null,
    comparisonKey: "",
  };
  result.comparisonKey = comparisonKey(result);
  return validateRestoringMultiAgentResult(result);
}
