import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MULTI_AGENT_BENCHMARK } from "./results.mjs";
import { CANONICAL_MULTI_AGENT_PROTOCOL } from "./execution/canonical-preparation.mjs";
import {
  CANONICAL_CANDIDATE_POLICY,
  CANONICAL_PROJECT_VERSION,
} from "./execution/canonical-candidate.mjs";
import { CANONICAL_DIFF_POLICY } from "./grading/canonical-diff.mjs";
import {
  CANONICAL_SCORE_POLICY,
  canonicalRoundScore,
  scoreCanonicalRounds,
} from "./grading/canonical-score.mjs";
import { ROUND_POOL_POLICY } from "./execution/round-pool.mjs";
import { PROVIDER_RECOVERY_POLICY } from "./execution/provider-recovery.mjs";

export const CANONICAL_RUN_VERSION = "renderer-canonical-run-v1";
export const CANONICAL_RESULT_VERSION = "renderer-canonical-result-v1";
export const CANONICAL_RUN_POLICY = Object.freeze({
  version: "renderer-canonical-policy-v1",
  candidate: CANONICAL_CANDIDATE_POLICY,
  candidateBuild: "captured-complete-physical-inventory",
  diff: CANONICAL_DIFF_POLICY,
  score: CANONICAL_SCORE_POLICY,
  pool: ROUND_POOL_POLICY,
  providerRecovery: PROVIDER_RECOVERY_POLICY,
  maxEditingWaves: 4,
  restoration: "trusted-round-end-after-saving-candidate",
});

const stageNames = new Set([
  "original",
  "structural-correction",
  "build-correction",
  "image-correction",
]);
const terminalCategories = new Set([
  "cancelled",
  "infrastructure",
  "provider_failure",
  "authentication",
  "auth",
  "driver_exit",
  "runtime",
]);
const usageFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"];
const configurationFields = [
  "agents",
  "maxConcurrentAgents",
  "batchSize",
  "agentLifecycle",
  "model",
  "thinking",
  "harness",
  "harnessVersion",
  "runtime",
];
const sourceFields = ["sourceCommit", "verifierSha256", "runnerSha256"];
const authorizationFields = [
  "kind",
  "proofSha256",
  "sourceCommit",
  "runnerSha256",
  "verifierSha256",
  "agents",
];
const workloadFields = [
  "workloadSha256",
  "graphSha256",
  "scheduleSha256",
  "initial",
  "expectedFinal",
  "totalTasks",
  "originalEdits",
  "graphWidth",
  "plannedRounds",
  "plan",
  "preparationSha256",
];
const executionFields = [
  "participants",
  "registeredParticipants",
  "unregisteredParticipants",
  "closedParticipants",
  "deliveries",
  "repairDeliveries",
  "peakNativeObserved",
  "concurrencyMethod",
];
const roundFields = ["round", "structure", "build", "images", "score", "stages", "measurements"];
const resultFields = [
  "version",
  "benchmark",
  "protocol",
  "status",
  "source",
  "policy",
  "configuration",
  "workload",
  "authorization",
  "rounds",
  "score",
  "execution",
  "usage",
  "initialCheck",
  "restoration",
  "terminal",
  "durationMs",
];
const concurrencyMethod = "kernel-samples-at-participant-start";
const select = (value, fields) => Object.fromEntries(fields.map((field) => [field, value[field]]));
const hashDifference = (round, id) =>
  createHash("sha256")
    .update(JSON.stringify([round, id]))
    .digest("hex");

function object(value) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected canonical result object",
  );
  assert.ok(
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "Unexpected canonical object prototype",
  );
}
function keys(value, fields) {
  object(value);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...fields].sort(),
    "Unexpected canonical result fields",
  );
}
function integer(value, minimum = 0) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum, "Invalid canonical integer");
}
function measurement(value) {
  assert.ok(Number.isFinite(value) && value >= 0, "Invalid canonical measurement");
}
function digest(value, length = 64) {
  assert.ok(
    typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value),
    "Invalid canonical digest",
  );
}
function roundName(value) {
  assert.ok(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value),
    "Invalid canonical round identity",
  );
}
function label(value) {
  assert.ok(
    typeof value === "string" &&
      value.length <= 256 &&
      /^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/.test(value),
    "Invalid canonical public label",
  );
  assert.doesNotMatch(
    value,
    /(?:^|[/:])(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)|(?:^|[/:])(?:root|home)\//i,
    "Private canonical public label",
  );
  assert.ok(
    value.split("/").every((part) => part !== "." && part !== ".."),
    "Unsafe canonical public label",
  );
}
function identifiers(value, hashed) {
  assert.ok(Array.isArray(value), "Missing canonical difference evidence");
  assert.equal(new Set(value).size, value.length, "Repeated canonical difference identity");
  for (const id of value) {
    assert.ok(typeof id === "string" && id.length > 0, "Invalid canonical difference identity");
    if (hashed) digest(id);
  }
}
function outcome(value) {
  keys(value, ["firstPassed", "correctionUsed", "finalPassed"]);
  for (const field of Object.keys(value)) assert.equal(typeof value[field], "boolean");
}
function validateConfiguration(value) {
  keys(value, configurationFields);
  for (const field of ["agents", "maxConcurrentAgents", "batchSize"]) integer(value[field], 1);
  assert.equal(value.agentLifecycle, "round-ready-pool");
  if (value.model !== null) {
    label(value.model);
    assert.ok(value.model.includes("/"));
  }
  assert.ok(
    value.thinking === null ||
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinking),
  );
  assert.ok(
    value.harness === null ||
      ["baseline-agent", "pi-agent-ide-codemode", "pi-agent-ide-codemode-no-bash"].includes(
        value.harness,
      ),
  );
  if (value.harnessVersion !== null) {
    label(value.harnessVersion);
    assert.match(value.harnessVersion, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/);
  }
  if (value.runtime !== null) {
    keys(value.runtime, ["agent", "version", "platform", "architecture"]);
    assert.equal(value.runtime.agent, "pi");
    label(value.runtime.version);
    assert.match(value.runtime.version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/);
    assert.equal(value.runtime.platform, "linux");
    assert.equal(value.runtime.architecture, "x64");
  }
}
function validateUsage(value) {
  if (value === null) return;
  keys(value, usageFields);
  for (const field of usageFields) {
    if (value[field] === null) continue;
    measurement(value[field]);
    if (field !== "cost") integer(value[field]);
  }
}
function validatePlan(plan, plannedRounds) {
  assert.ok(Array.isArray(plan));
  assert.equal(plan.length, plannedRounds, "Canonical plan coverage differs");
  const seen = new Set();
  for (const item of plan) {
    keys(item, ["round", "totalHunks"]);
    roundName(item.round);
    integer(item.totalHunks, 1);
    assert.ok(!seen.has(item.round), "Repeated planned canonical round");
    seen.add(item.round);
  }
}
function validateInitial(value, status) {
  if (value === null) {
    assert.notEqual(status, "complete");
    return;
  }
  keys(value, ["buildPassed", "resultMatched"]);
  assert.equal(typeof value.buildPassed, "boolean");
  assert.equal(typeof value.resultMatched, "boolean");
  assert.ok(value.buildPassed || !value.resultMatched);
  if (status === "complete") assert.deepEqual(value, { buildPassed: true, resultMatched: true });
}
function validateTerminal(value, status) {
  if (status === "complete") {
    assert.equal(value, null);
    return;
  }
  keys(value, ["category"]);
  assert.ok(terminalCategories.has(value.category), "Unknown canonical stop category");
  assert.equal(value.category === "cancelled", status === "cancelled");
}

/** Check captured wave order and derive integration outcomes from measurements. */
function validateRound(row, planned, hashed) {
  keys(row, roundFields);
  assert.equal(row.round, planned.round);
  keys(row.structure, [
    "totalHunks",
    "initialDifferences",
    "correctionDifferences",
    "laterDifferences",
  ]);
  const structure = row.structure;
  assert.equal(structure.totalHunks, planned.totalHunks);
  identifiers(structure.initialDifferences, hashed);
  if (structure.correctionDifferences !== null)
    identifiers(structure.correctionDifferences, hashed);
  assert.ok(Array.isArray(structure.laterDifferences));
  for (const item of structure.laterDifferences) {
    keys(item, ["stage", "differences"]);
    identifiers(item.differences, hashed);
  }
  outcome(row.build);
  if (row.images !== null) outcome(row.images);
  const computed = canonicalRoundScore(row);
  assert.deepEqual(row.score, computed, "Stored canonical round score differs");
  const names = [
    "original",
    ...(structure.correctionDifferences !== null ? ["structural-correction"] : []),
    ...structure.laterDifferences.map(({ stage }) => stage),
  ];
  assert.ok(names.length <= CANONICAL_RUN_POLICY.maxEditingWaves);
  assert.ok(Array.isArray(row.stages));
  assert.deepEqual(
    row.stages.map(({ stage }) => stage),
    names,
    "Canonical wave evidence differs",
  );
  const differences = [
    structure.initialDifferences,
    ...(structure.correctionDifferences !== null ? [structure.correctionDifferences] : []),
    ...structure.laterDifferences.map((item) => item.differences),
  ];
  for (const [index, item] of row.stages.entries()) {
    keys(item, ["stage", "differences"]);
    identifiers(item.differences, hashed);
    assert.deepEqual(item.differences, differences[index]);
  }
  assert.ok(Array.isArray(row.measurements));
  for (const item of row.measurements) {
    keys(item, ["stage", "buildPassed", "resultMatched"]);
    assert.equal(typeof item.buildPassed, "boolean");
    assert.equal(typeof item.resultMatched, "boolean");
    assert.ok(item.buildPassed || !item.resultMatched, "Image evidence requires a build");
  }
  let index = 0;
  const first = row.measurements[index++];
  assert.ok(first);
  assert.equal(
    first.stage,
    structure.correctionDifferences === null ? "original" : "structural-correction",
  );
  let current = first;
  let build = {
    firstPassed: first.buildPassed,
    correctionUsed: false,
    finalPassed: first.buildPassed,
  };
  if (!first.buildPassed) {
    current = row.measurements[index++];
    assert.ok(current);
    assert.equal(current.stage, "build-correction");
    build = { ...build, correctionUsed: true, finalPassed: current.buildPassed };
  }
  let images = current.buildPassed
    ? {
        firstPassed: current.resultMatched,
        correctionUsed: false,
        finalPassed: current.resultMatched,
      }
    : null;
  if (images && !images.firstPassed) {
    current = row.measurements[index++];
    assert.ok(current);
    assert.equal(current.stage, "image-correction");
    build = { ...build, finalPassed: current.buildPassed };
    images = { ...images, correctionUsed: true, finalPassed: current.resultMatched };
  }
  assert.equal(index, row.measurements.length, "Unexpected integration remeasurement");
  assert.deepEqual(row.build, build, "Build outcome differs from measured stages");
  assert.deepEqual(row.images, images, "Image outcome differs from measured stages");
  return computed;
}

function normalizeRound(row, planned) {
  const publicView = {
    round: row.round,
    structure: row.structure,
    build: row.build,
    images: row.images,
    score: row.score,
    stages: row.stages.map(({ stage, comparison }) => {
      assert.equal(comparison.totalHunks, planned.totalHunks);
      return { stage, differences: comparison.differenceIds };
    }),
    measurements: row.measurements.map((item) =>
      select(item, ["stage", "buildPassed", "resultMatched"]),
    ),
  };
  validateRound(publicView, planned, false);
  const ids = (values) => values.map((id) => hashDifference(row.round, id));
  const structure = {
    totalHunks: row.structure.totalHunks,
    initialDifferences: ids(row.structure.initialDifferences),
    correctionDifferences:
      row.structure.correctionDifferences === null
        ? null
        : ids(row.structure.correctionDifferences),
    laterDifferences: row.structure.laterDifferences.map(({ stage, differences }) => ({
      stage,
      differences: ids(differences),
    })),
  };
  const result = {
    round: row.round,
    structure,
    build: select(row.build, ["firstPassed", "correctionUsed", "finalPassed"]),
    images:
      row.images === null
        ? null
        : select(row.images, ["firstPassed", "correctionUsed", "finalPassed"]),
    stages: publicView.stages.map(({ stage, differences }) => ({
      stage,
      differences: ids(differences),
    })),
    measurements: publicView.measurements,
    score: canonicalRoundScore({ structure, build: row.build, images: row.images }),
  };
  validateRound(result, planned, true);
  return result;
}

function validateParticipant(item, cap, elapsedMs) {
  integer(item.session);
  integer(item.agent);
  assert.ok(item.agent < cap);
  roundName(item.round);
  assert.ok(stageNames.has(item.stage));
  assert.equal(item.created, true);
  assert.equal(typeof item.closed, "boolean");
  if (item.usage !== null) validateUsage(select(item.usage, usageFields));
  if (item.registeredMs === null) {
    assert.equal(item.participant, null, "Unregistered attempt has a native identity");
    assert.equal(item.closed, true, "Unregistered attempt has not been closed");
    measurement(item.closedMs);
    assert.ok(item.closedMs <= elapsedMs);
    return false;
  }
  measurement(item.registeredMs);
  assert.ok(item.registeredMs <= elapsedMs);
  if (item.closed) {
    measurement(item.closedMs);
    assert.ok(item.closedMs >= item.registeredMs && item.closedMs <= elapsedMs);
  } else assert.equal(item.closedMs, null);
  object(item.participant);
  for (const key of ["sessionId", "lifetime"])
    assert.ok(typeof item.participant[key] === "string" && item.participant[key].length > 0);
  const process = item.participant.process;
  object(process);
  for (const key of ["rootPid", "agentHostPid", "agentPid"]) integer(process[key], 1);
  for (const key of ["rootStart", "agentStart"])
    assert.ok(typeof process[key] === "string" && /^\d+$/.test(process[key]));
  assert.ok(typeof process.namespace === "string" && /^pid:\[\d+\]$/.test(process.namespace));
  return true;
}

function validateCohortLifetimes(report, planIndices) {
  const phases = new Map([...stageNames].map((stage, index) => [stage, index]));
  const cohorts = new Map();
  for (const item of report.participants) {
    const rank = planIndices.get(item.round) * stageNames.size + phases.get(item.stage);
    if (!cohorts.has(rank)) cohorts.set(rank, []);
    cohorts.get(rank).push(item);
  }
  let previousEnd = 0;
  let previousClosed = true;
  for (const [, items] of [...cohorts].sort(([a], [b]) => a - b)) {
    assert.ok(previousClosed, "A new editing cohort started before prior closure");
    for (const item of items)
      assert.ok(
        (item.registeredMs ?? item.closedMs) >= previousEnd,
        "Native lifetimes from distinct editing cohorts overlap",
      );
    previousClosed = items.every(({ closed }) => closed);
    previousEnd = Math.max(...items.map(({ closedMs }) => closedMs ?? report.elapsedMs));
  }
}

function executionEvidence(report) {
  assert.ok(Array.isArray(report.participants));
  assert.ok(Array.isArray(report.executions));
  assert.ok(Array.isArray(report.agentsClosed));
  const bySession = new Map(),
    lifetimes = new Set(),
    sessionIds = new Set(),
    processes = new Set();
  const planIndices = new Map(report.plan.map(({ round }, index) => [round, index]));
  for (const item of report.participants) {
    const registered = validateParticipant(
      item,
      report.configuration.maxConcurrentAgents,
      report.elapsedMs,
    );
    assert.ok(planIndices.has(item.round));
    assert.ok(
      planIndices.get(item.round) <= report.rounds.length,
      "Participant skipped an unobserved round",
    );
    assert.ok(!bySession.has(item.session), "Repeated global participant session");
    bySession.set(item.session, item);
    if (!registered) {
      assert.notEqual(report.status, "complete");
      assert.equal(
        planIndices.get(item.round),
        report.rounds.length,
        "An unregistered attempt cannot belong to a finalized round",
      );
      continue;
    }
    const finalized = report.rounds[planIndices.get(item.round)];
    if (finalized) {
      assert.equal(item.closed, true, "A finalized round retains a live participant");
      assert.ok(
        finalized.stages.some(({ stage }) => stage === item.stage),
        "Participant belongs to an unmeasured wave of a finalized round",
      );
    }
    assert.ok(!lifetimes.has(item.participant.lifetime), "Participant lifetime was reused");
    assert.ok(!sessionIds.has(item.participant.sessionId), "Participant history was reused");
    const process = JSON.stringify([
      item.participant.process.agentHostPid,
      item.participant.process.agentStart,
    ]);
    assert.ok(!processes.has(process), "Native process identity was reused");
    lifetimes.add(item.participant.lifetime);
    sessionIds.add(item.participant.sessionId);
    processes.add(process);
  }
  assert.deepEqual(
    report.agentsClosed,
    report.participants.map(({ closed }) => closed),
  );
  validateCohortLifetimes(report, planIndices);
  const work = new Set(),
    cohorts = new Set();
  let repairs = 0;
  for (const item of report.executions) {
    const participant = bySession.get(item.session);
    assert.ok(participant?.participant, "Delivery has no identified native participant");
    assert.equal(item.agent, participant.agent);
    assert.equal(item.round, participant.round);
    assert.equal(item.stage, participant.stage);
    assert.ok(planIndices.has(item.round));
    assert.ok(
      planIndices.get(item.round) <= report.rounds.length,
      "Delivery skipped an unobserved round",
    );
    assert.ok(["running", "settled", "cancelled", "error"].includes(item.status));
    if (report.status === "complete") assert.equal(item.status, "settled");
    assert.ok(Array.isArray(item.ids) && item.ids.length > 0);
    assert.ok(
      item.ids.length <= report.configuration.batchSize,
      "Delivery exceeds its configured packet size",
    );
    for (const id of item.ids) {
      assert.ok(typeof id === "string" && id.length > 0);
      const identity = JSON.stringify([item.round, item.stage, id]);
      assert.ok(!work.has(identity), "Work was delivered more than once");
      work.add(identity);
    }
    cohorts.add(JSON.stringify([item.round, item.stage]));
    if (item.stage !== "original") repairs++;
  }
  for (const [index, row] of report.rounds.entries()) {
    for (const { stage } of row.stages)
      assert.ok(
        cohorts.has(JSON.stringify([row.round, stage])),
        "Measured editing wave has no delivery",
      );
    const deliveries = report.executions.filter((item) => item.round === row.round);
    assert.ok(
      deliveries.every((item) => item.status === "settled"),
      "A finalized round has an unsettled delivery",
    );
    const original = deliveries
      .filter((item) => item.stage === "original")
      .flatMap(({ ids }) => ids);
    assert.equal(original.length, report.scope.plannedAtoms[index].totalAtoms);
    assert.equal(
      createHash("sha256")
        .update(JSON.stringify([...original].sort()))
        .digest("hex"),
      report.scope.roundInventories[index].sha256,
      "Delivered original work inventory differs",
    );
  }
  if (report.status === "complete") {
    assert.equal(
      new Set(report.executions.map(({ session }) => session)).size,
      report.participants.length,
    );
    const original = report.executions
      .filter((item) => item.stage === "original")
      .flatMap(({ ids }) => ids);
    assert.equal(new Set(original).size, original.length);
    assert.equal(
      createHash("sha256")
        .update(JSON.stringify([...original].sort()))
        .digest("hex"),
      report.scope.atomicInventorySha256,
    );
  }
  assert.equal(report.deliveries, report.executions.length);
  assert.equal(report.repairs, repairs);
  keys(report.concurrency, ["method", "peakObserved", "samples"]);
  assert.equal(report.concurrency.method, concurrencyMethod);
  assert.ok(Array.isArray(report.concurrency.samples));
  let peak = 0;
  for (const sample of report.concurrency.samples) {
    keys(sample, ["atMs", "liveSessions"]);
    measurement(sample.atMs);
    assert.ok(sample.atMs <= report.elapsedMs);
    assert.ok(Array.isArray(sample.liveSessions));
    assert.equal(new Set(sample.liveSessions).size, sample.liveSessions.length);
    const namespaces = new Set();
    for (const session of sample.liveSessions) {
      integer(session);
      const item = bySession.get(session);
      assert.ok(item?.participant, "Concurrency sample contains an unidentified participant");
      assert.ok(
        sample.atMs >= item.registeredMs &&
          (item.closedMs === null || sample.atMs <= item.closedMs),
      );
      assert.ok(
        !namespaces.has(item.participant.process.namespace),
        "Concurrency sample duplicates a native namespace",
      );
      namespaces.add(item.participant.process.namespace);
    }
    peak = Math.max(peak, sample.liveSessions.length);
  }
  assert.equal(report.concurrency.peakObserved, peak);
  assert.ok(peak <= report.configuration.maxConcurrentAgents);
  const usages = report.participants.map(({ usage }) =>
    usage === null ? null : select(usage, usageFields),
  );
  const expectedUsage = usages.every((usage) => usage === null)
    ? null
    : Object.fromEntries(
        usageFields.map((field) => [
          field,
          usages.every((usage) => usage !== null && usage[field] !== null)
            ? usages.reduce((sum, usage) => sum + usage[field], 0)
            : null,
        ]),
      );
  assert.deepEqual(
    report.usage === null ? null : select(report.usage, usageFields),
    expectedUsage,
    "Native usage accounting differs",
  );
  return {
    participants: report.participants.length,
    registeredParticipants: lifetimes.size,
    unregisteredParticipants: report.participants.length - lifetimes.size,
    closedParticipants: report.participants.filter(({ closed }) => closed).length,
    deliveries: report.deliveries,
    repairDeliveries: repairs,
    peakNativeObserved: peak,
    concurrencyMethod,
  };
}

function restorationEvidence(report) {
  let finalIdentity = report.scope.initial;
  let completedRounds = 0;
  for (const [index, row] of report.rounds.entries()) {
    if (row.restoration === undefined) {
      assert.notEqual(report.status, "complete", "A complete round has no restoration receipt");
      assert.equal(index, report.rounds.length - 1, "An earlier round was not restored");
      continue;
    }
    keys(row.restoration, ["identity", "files", "restored"]);
    assert.equal(row.restoration.restored, true);
    integer(row.restoration.files, 1);
    digest(row.restoration.identity);
    assert.equal(
      row.restoration.identity,
      report.scope.roundEndpoints[index].identity,
      "Restoration differs from the trusted round endpoint",
    );
    finalIdentity = row.restoration.identity;
    completedRounds++;
  }
  digest(report.final);
  assert.equal(report.final, finalIdentity, "Final source differs from restoration evidence");
  if (report.status === "complete") assert.equal(finalIdentity, report.scope.expectedFinal);
  return { completedRounds, finalIdentity };
}

function validateRestoration(value, workload, observedRounds, status) {
  keys(value, ["completedRounds", "finalIdentity"]);
  integer(value.completedRounds);
  digest(value.finalIdentity);
  assert.ok(value.completedRounds <= observedRounds);
  assert.ok(observedRounds - value.completedRounds <= 1);
  if (value.completedRounds === 0) assert.equal(value.finalIdentity, workload.initial);
  if (value.completedRounds === workload.plannedRounds)
    assert.equal(value.finalIdentity, workload.expectedFinal);
  if (status === "complete") {
    assert.equal(value.completedRounds, workload.plannedRounds);
    assert.equal(value.finalIdentity, workload.expectedFinal);
  }
}
function aggregate(rounds, planned, status) {
  const score = scoreCanonicalRounds(rounds, planned);
  return { ...score, complete: status === "complete" && score.complete };
}

/** Project one stopped run into a standalone result. Source fragments and native
 * host identities remain private. SDK cost is a usage estimate, not a billing receipt.
 */
export function canonicalMultiAgentResult(report) {
  assert.equal(
    report.version,
    CANONICAL_RUN_VERSION,
    "Only text-hunk canonical runs can be exported; unit-scored runs keep their private report",
  );
  assert.equal(report.benchmark, MULTI_AGENT_BENCHMARK);
  assert.equal(report.protocol, CANONICAL_MULTI_AGENT_PROTOCOL);
  assert.equal(report.mode, "measured");
  assert.equal(report.sourceClean, true, "Canonical execution requires committed source");
  assert.ok(
    ["complete", "cancelled", "error"].includes(report.status),
    "Canonical run has not stopped",
  );
  assert.deepEqual(report.policy, CANONICAL_RUN_POLICY);
  measurement(report.elapsedMs);
  const scope = report.scope;
  integer(scope.totalRounds, 1);
  validatePlan(report.plan, scope.totalRounds);
  assert.ok(Array.isArray(report.rounds) && report.rounds.length <= report.plan.length);
  for (const field of ["plannedAtoms", "roundEndpoints", "roundInventories"])
    assert.deepEqual(
      scope[field].map(({ round }) => round),
      report.plan.map(({ round }) => round),
    );
  assert.equal(
    scope.plannedAtoms.reduce((sum, row) => {
      integer(row.totalAtoms, 1);
      return sum + row.totalAtoms;
    }, 0),
    scope.totalAtoms,
  );
  digest(scope.atomicInventorySha256);
  for (const item of scope.roundEndpoints) digest(item.identity);
  for (const item of scope.roundInventories) digest(item.sha256);
  assert.equal(scope.roundEndpoints.at(-1).identity, scope.expectedFinal);
  assert.equal(scope.agents, report.configuration.agents);
  assert.equal(scope.agents, report.authorization.agents);
  assert.equal(report.preparation.canonicalVersion, CANONICAL_PROJECT_VERSION);
  assert.deepEqual(report.preparation.inventory, CANONICAL_CANDIDATE_POLICY);
  const rounds = report.rounds.map((row, index) => normalizeRound(row, report.plan[index]));
  assert.deepEqual(
    report.score,
    scoreCanonicalRounds(report.rounds, scope.totalRounds),
    "Stored canonical run score differs",
  );
  const configuration = select(report.configuration, configurationFields);
  if (configuration.runtime !== null)
    configuration.runtime = select(configuration.runtime, [
      "agent",
      "version",
      "platform",
      "architecture",
    ]);
  validateConfiguration(configuration);
  const usage = report.usage === null ? null : select(report.usage, usageFields);
  validateUsage(usage);
  const terminal = report.terminal === null ? null : { category: report.terminal.category };
  const result = {
    version: CANONICAL_RESULT_VERSION,
    benchmark: MULTI_AGENT_BENCHMARK,
    protocol: CANONICAL_MULTI_AGENT_PROTOCOL,
    status: report.status,
    source: select(report, sourceFields),
    policy: CANONICAL_RUN_POLICY,
    configuration,
    workload: {
      ...select(scope, [
        "workloadSha256",
        "graphSha256",
        "scheduleSha256",
        "initial",
        "expectedFinal",
        "totalTasks",
        "graphWidth",
      ]),
      originalEdits: scope.totalAtoms,
      plannedRounds: scope.totalRounds,
      plan: report.plan.map((item) => select(item, ["round", "totalHunks"])),
      preparationSha256: report.preparation.manifestSha256,
    },
    authorization: select(report.authorization, authorizationFields),
    rounds,
    score: aggregate(rounds, scope.totalRounds, report.status),
    execution: executionEvidence(report),
    usage,
    initialCheck:
      report.initialCheck === null
        ? null
        : select(report.initialCheck, ["buildPassed", "resultMatched"]),
    restoration: restorationEvidence(report),
    terminal,
    durationMs: report.elapsedMs,
  };
  validateCanonicalResult(result);
  return result;
}

/** Validate a standalone canonical result without private source or trajectory data.
 * Returns true. Every score is recomputed from hashed difference and stage evidence.
 */
export function validateCanonicalResult(result) {
  keys(result, resultFields);
  assert.equal(result.version, CANONICAL_RESULT_VERSION);
  assert.equal(result.benchmark, MULTI_AGENT_BENCHMARK);
  assert.equal(result.protocol, CANONICAL_MULTI_AGENT_PROTOCOL);
  assert.ok(["complete", "cancelled", "error"].includes(result.status));
  keys(result.source, sourceFields);
  digest(result.source.sourceCommit, 40);
  digest(result.source.verifierSha256);
  digest(result.source.runnerSha256);
  assert.deepEqual(result.policy, CANONICAL_RUN_POLICY);
  validateConfiguration(result.configuration);
  keys(result.workload, workloadFields);
  const workload = result.workload;
  for (const field of [
    "workloadSha256",
    "graphSha256",
    "scheduleSha256",
    "initial",
    "expectedFinal",
    "preparationSha256",
  ])
    digest(workload[field]);
  for (const field of ["totalTasks", "originalEdits", "graphWidth", "plannedRounds"])
    integer(workload[field], 1);
  validatePlan(workload.plan, workload.plannedRounds);
  keys(result.authorization, authorizationFields);
  assert.equal(result.authorization.kind, "retained-task-feasibility");
  digest(result.authorization.sourceCommit, 40);
  for (const field of ["proofSha256", "runnerSha256", "verifierSha256"])
    digest(result.authorization[field]);
  assert.equal(result.authorization.agents, result.configuration.agents);
  assert.ok(Array.isArray(result.rounds) && result.rounds.length <= workload.plannedRounds);
  for (const [index, row] of result.rounds.entries())
    validateRound(row, workload.plan[index], true);
  assert.deepEqual(
    result.score,
    aggregate(result.rounds, workload.plannedRounds, result.status),
    "Canonical aggregate differs",
  );
  if (result.status === "complete") assert.equal(result.rounds.length, workload.plannedRounds);
  keys(result.execution, executionFields);
  for (const field of executionFields.filter((field) => field !== "concurrencyMethod"))
    integer(result.execution[field]);
  const execution = result.execution;
  assert.equal(execution.concurrencyMethod, concurrencyMethod);
  assert.equal(
    execution.registeredParticipants + execution.unregisteredParticipants,
    execution.participants,
  );
  assert.ok(execution.closedParticipants <= execution.participants);
  assert.ok(execution.closedParticipants >= execution.unregisteredParticipants);
  if (execution.registeredParticipants === 0) assert.equal(execution.deliveries, 0);
  assert.ok(execution.repairDeliveries <= execution.deliveries);
  assert.ok(
    execution.peakNativeObserved <=
      Math.min(execution.registeredParticipants, result.configuration.maxConcurrentAgents),
  );
  const waves = result.rounds.reduce((sum, row) => sum + row.stages.length, 0);
  assert.ok(execution.deliveries >= waves);
  assert.ok(execution.repairDeliveries >= waves - result.rounds.length);
  assert.ok(execution.deliveries - execution.repairDeliveries >= result.rounds.length);
  assert.ok(execution.registeredParticipants >= waves);
  if (result.status === "complete") {
    assert.equal(execution.closedParticipants, execution.participants);
    assert.equal(execution.unregisteredParticipants, 0);
    assert.ok(execution.peakNativeObserved > 0);
  }
  validateRestoration(result.restoration, workload, result.rounds.length, result.status);
  validateUsage(result.usage);
  validateInitial(result.initialCheck, result.status);
  validateTerminal(result.terminal, result.status);
  measurement(result.durationMs);
  return true;
}
