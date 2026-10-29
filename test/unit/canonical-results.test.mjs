import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MULTI_AGENT_BENCHMARK } from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { CANONICAL_MULTI_AGENT_PROTOCOL } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-preparation.mjs";
import {
  canonicalRoundScore,
  scoreCanonicalRounds,
} from "../../src/suites/explicit-edit-multi-agent/grading/canonical-score.mjs";
import {
  CANONICAL_RUN_VERSION,
  CANONICAL_RUN_POLICY,
  canonicalMultiAgentResult,
  validateCanonicalResult,
} from "../../src/suites/explicit-edit-multi-agent/canonical-results.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const differenceHash = (round, id) => digest(JSON.stringify([round, id]));
const knownUsage = () => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: 0.01,
});
const passed = () => ({ firstPassed: true, correctionUsed: false, finalPassed: true });

function round(roundId, repaired = false, integrationRepairs = false) {
  const initial = repaired ? ["reference:1"] : [];
  const structure = {
    totalHunks: 2,
    initialDifferences: initial,
    correctionDifferences: repaired ? [] : null,
    laterDifferences: integrationRepairs
      ? [
          { stage: "build-correction", differences: [] },
          { stage: "image-correction", differences: [] },
        ]
      : [],
  };
  const build = integrationRepairs
    ? { firstPassed: false, correctionUsed: true, finalPassed: true }
    : passed();
  const images = integrationRepairs
    ? { firstPassed: false, correctionUsed: true, finalPassed: true }
    : passed();
  const stages = [
    { stage: "original", comparison: { totalHunks: 2, differenceIds: initial, expectedHunks: [] } },
    ...(repaired
      ? [{ stage: "structural-correction", comparison: { totalHunks: 2, differenceIds: [] } }]
      : []),
    ...(integrationRepairs
      ? [
          { stage: "build-correction", comparison: { totalHunks: 2, differenceIds: [] } },
          { stage: "image-correction", comparison: { totalHunks: 2, differenceIds: [] } },
        ]
      : []),
  ];
  const measurements = integrationRepairs
    ? [
        {
          stage: repaired ? "structural-correction" : "original",
          buildPassed: false,
          resultMatched: false,
        },
        { stage: "build-correction", buildPassed: true, resultMatched: false },
        { stage: "image-correction", buildPassed: true, resultMatched: true },
      ]
    : [
        {
          stage: repaired ? "structural-correction" : "original",
          buildPassed: true,
          resultMatched: true,
        },
      ];
  return {
    round: roundId,
    stages,
    measurements,
    structure,
    build,
    images,
    score: canonicalRoundScore({ structure, build, images }),
  };
}

function fixture({
  interrupted = false,
  allWaves = false,
  unbuildable = false,
  lateRegression = false,
} = {}) {
  const full = allWaves || unbuildable || lateRegression;
  const rounds = full
    ? [round("R001", true, true)]
    : interrupted
      ? [round("R001")]
      : [round("R001"), round("R002", true)];
  if (unbuildable || lateRegression) {
    const row = rounds[0];
    if (unbuildable) {
      row.stages.pop();
      row.structure.laterDifferences.pop();
      row.measurements.pop();
      row.measurements[1] = { stage: "build-correction", buildPassed: false, resultMatched: false };
      row.build = { firstPassed: false, correctionUsed: true, finalPassed: false };
      row.images = null;
    } else {
      row.stages.splice(2, 1);
      row.structure.laterDifferences.splice(0, 1);
      row.measurements = [
        { stage: "structural-correction", buildPassed: true, resultMatched: false },
        { stage: "image-correction", buildPassed: false, resultMatched: false },
      ];
      row.build = { firstPassed: true, correctionUsed: false, finalPassed: false };
      row.images = { firstPassed: false, correctionUsed: true, finalPassed: false };
    }
    row.score = canonicalRoundScore(row);
  }
  const plan = (full ? ["R001"] : ["R001", "R002"]).map((id) => ({ round: id, totalHunks: 2 }));
  const participants = [],
    executions = [],
    samples = [];
  for (const outcome of rounds)
    for (const { stage } of outcome.stages) {
      const session = participants.length,
        registeredMs = session * 10;
      participants.push({
        session,
        agent: 0,
        round: outcome.round,
        stage,
        created: true,
        closed: true,
        registeredMs,
        closedMs: registeredMs + 9,
        usage: knownUsage(),
        participant: {
          sessionId: `session-${session}`,
          lifetime: `lifetime-${session}`,
          process: {
            rootPid: 1000 + session * 3,
            rootStart: `${100 + session}`,
            namespace: `pid:[${2000 + session}]`,
            agentHostPid: 1001 + session * 3,
            agentStart: `${101 + session}`,
            agentPid: 2,
          },
        },
      });
      executions.push({
        round: outcome.round,
        stage,
        session,
        agent: 0,
        ids:
          stage === "original"
            ? [`original-${outcome.round}-0`, `original-${outcome.round}-1`]
            : [`work-${session}`],
        status: "settled",
        receipt: {},
      });
      samples.push({ atMs: registeredMs + 1, liveSessions: [session] });
    }
  const usage = Object.fromEntries(
    Object.keys(knownUsage()).map((key) => [
      key,
      participants.reduce((sum, item) => sum + item.usage[key], 0),
    ]),
  );
  const scope = {
    agents: 2,
    graphWidth: 2,
    workloadSha256: digest("workload"),
    graphSha256: digest("graph"),
    scheduleSha256: digest("schedule"),
    initial: digest("initial"),
    expectedFinal: digest("final"),
    totalTasks: 2,
    totalRounds: plan.length,
    totalAtoms: plan.length * 2,
    atomicInventorySha256: digest(
      JSON.stringify(
        plan.flatMap(({ round: id }) => [`original-${id}-0`, `original-${id}-1`]).sort(),
      ),
    ),
    contractHashes: {},
    atomic: {},
    plannedAtoms: plan.map(({ round: id }) => ({ round: id, totalAtoms: 2 })),
    roundEndpoints: plan.map(({ round: id }, index) => ({
      round: id,
      identity: digest(index === plan.length - 1 ? "final" : id),
    })),
    roundInventories: plan.map(({ round: id }) => ({
      round: id,
      sha256: digest(JSON.stringify([`original-${id}-0`, `original-${id}-1`].sort())),
    })),
  };
  const restoredRounds = rounds.map((outcome) => ({
    ...outcome,
    restoration: {
      identity: scope.roundEndpoints.find(({ round: id }) => id === outcome.round).identity,
      files: 1,
      restored: true,
    },
  }));
  return {
    version: CANONICAL_RUN_VERSION,
    benchmark: MULTI_AGENT_BENCHMARK,
    protocol: CANONICAL_MULTI_AGENT_PROTOCOL,
    mode: "measured",
    status: interrupted ? "cancelled" : "complete",
    sourceCommit: "a".repeat(40),
    sourceClean: true,
    verifierSha256: digest("verifier"),
    runnerSha256: digest("runner"),
    policy: CANONICAL_RUN_POLICY,
    configuration: {
      agents: 2,
      maxConcurrentAgents: 2,
      batchSize: 10,
      agentLifecycle: "round-ready-pool",
      model: "fixture/deterministic",
      thinking: "off",
      harness: "baseline-agent",
      harnessVersion: "1.3.0",
      runtime: { agent: "pi", version: "1.3.0", platform: "linux", architecture: "x64" },
    },
    scope,
    plan,
    rounds: restoredRounds,
    final: restoredRounds.at(-1)?.restoration.identity ?? scope.initial,
    participants,
    executions,
    deliveries: executions.length,
    repairs: executions.filter(({ stage }) => stage !== "original").length,
    agentsClosed: participants.map(({ closed }) => closed),
    concurrency: { method: "kernel-samples-at-participant-start", peakObserved: 1, samples },
    usage,
    preparation: {
      manifestSha256: digest("preparation"),
      canonicalVersion: "renderer-canonical-project-v2",
      canonicalizer: {},
      inventory: CANONICAL_RUN_POLICY.candidate,
    },
    authorization: {
      kind: "retained-task-feasibility",
      proofSha256: digest("proof"),
      sourceCommit: "b".repeat(40),
      runnerSha256: digest("old runner"),
      verifierSha256: digest("old verifier"),
      agents: 2,
    },
    score: scoreCanonicalRounds(restoredRounds, plan.length),
    initialCheck: { buildPassed: true, resultMatched: true },
    elapsedMs: 1000,
    terminal: interrupted
      ? { category: "cancelled", name: "AbortError", message: "fixture interruption" }
      : null,
  };
}

function stoppedStartupFixture() {
  const report = fixture({ interrupted: true });
  report.status = "error";
  report.rounds = [];
  report.final = report.scope.initial;
  report.score = scoreCanonicalRounds([], report.plan.length);
  report.participants = [
    {
      ...report.participants[0],
      participant: null,
      registeredMs: null,
      usage: null,
    },
  ];
  report.executions = [];
  report.agentsClosed = [true];
  report.concurrency = {
    method: "kernel-samples-at-participant-start",
    peakObserved: 0,
    samples: [],
  };
  report.deliveries = 0;
  report.repairs = 0;
  report.usage = null;
  report.terminal = { category: "driver_exit", name: "Error", message: "fixture startup exit" };
  return report;
}
function changed(base, mutate) {
  const copy = structuredClone(base);
  mutate(copy);
  return copy;
}

test("canonical export preserves separate first and final scores and hashes difference identities", () => {
  const report = fixture();
  const safe = canonicalMultiAgentResult(report);
  assert.equal(safe.score.score, 87.5);
  assert.equal(safe.score.firstStructuralScore, 75);
  assert.equal(safe.rounds[1].score.score, 75);
  assert.deepEqual(safe.rounds[1].structure.initialDifferences, [
    differenceHash("R002", "reference:1"),
  ]);
  assert.equal(validateCanonicalResult(JSON.parse(JSON.stringify(safe))), true);
  assert.deepEqual(report.rounds[1].structure.initialDifferences, ["reference:1"]);
});

test("four editing waves retain their independent correction factors", () => {
  const safe = canonicalMultiAgentResult(fixture({ allWaves: true }));
  assert.equal(safe.rounds[0].score.score, 42.1875);
  assert.equal(safe.rounds[0].score.build.factor, 0.75);
  assert.equal(safe.rounds[0].score.images.factor, 0.75);
  assert.deepEqual(
    safe.rounds[0].stages.map(({ stage }) => stage),
    ["original", "structural-correction", "build-correction", "image-correction"],
  );
});

test("unavailable images and later build regressions retain both failed factors", () => {
  for (const options of [{ unbuildable: true }, { lateRegression: true }]) {
    const safe = canonicalMultiAgentResult(fixture(options));
    assert.equal(safe.rounds[0].score.score, 18.75);
    assert.equal(safe.rounds[0].score.build.factor, 0.5);
    assert.equal(safe.rounds[0].score.images.factor, 0.5);
    assert.equal(validateCanonicalResult(safe), true);
  }
});

test("trusted native fixture factories may omit public model configuration", () => {
  const report = fixture();
  for (const key of ["model", "thinking", "harness", "harnessVersion", "runtime"])
    report.configuration[key] = null;
  const safe = canonicalMultiAgentResult(report);
  assert.equal(safe.configuration.model, null);
  assert.equal(safe.configuration.runtime, null);
});
test("interrupted export retains the entire planned denominator", () => {
  const safe = canonicalMultiAgentResult(fixture({ interrupted: true }));
  assert.equal(safe.score.score, 50);
  assert.equal(safe.score.observedRounds, 1);
  assert.equal(safe.score.plannedRounds, 2);
  assert.equal(safe.score.complete, false);
  assert.equal(safe.status, "cancelled");
});

test("an infrastructure stop after all measured rounds still has no completed result", () => {
  const report = fixture();
  report.status = "error";
  report.terminal = { category: "infrastructure", name: "Error", message: "fixture late stop" };
  const safe = canonicalMultiAgentResult(report);
  assert.equal(safe.score.observedRounds, 2);
  assert.equal(safe.score.complete, false);
  assert.equal(validateCanonicalResult(safe), true);
});

test("unknown native usage remains unknown and finite SDK cost is preserved", () => {
  const report = fixture();
  for (const item of report.participants) item.usage.cost = null;
  report.usage.cost = null;
  const safe = canonicalMultiAgentResult(report);
  assert.equal(safe.usage.cost, null);
  assert.equal(safe.usage.totalTokens, report.deliveries * 15);
});

test("private source fragments, paths, commands and metadata never enter the safe payload", () => {
  const report = fixture();
  const canary = "private-canary-/home/operator/credential";
  report.extra = canary;
  report.scope.extra = canary;
  report.preparation.extra = canary;
  report.configuration.extra = canary;
  report.authorization.extra = canary;
  report.participants[0].participant.statePath = canary;
  report.executions[0].receipt = { stdout: canary, command: canary };
  report.rounds[0].stages[0].comparison.expectedHunks = [{ lines: [canary] }];
  report.rounds[1].stages[0].comparison.differenceIds = [canary];
  report.rounds[1].structure.initialDifferences = [canary];
  report.rounds[1].score = canonicalRoundScore(report.rounds[1]);
  report.score = scoreCanonicalRounds(report.rounds, report.scope.totalRounds);
  const safe = canonicalMultiAgentResult(report);
  assert.equal(JSON.stringify(safe).includes(canary), false);
  assert.equal(JSON.stringify(safe).includes("reference:1"), false);
  assert.deepEqual(safe.rounds[1].structure.initialDifferences, [differenceHash("R002", canary)]);
});

test("the producer rejects a stored round or run score that differs from its evidence", () => {
  const report = fixture();
  for (const mutate of [
    (r) => {
      r.rounds[0].score.score = 99;
    },
    (r) => {
      r.score.normalized = 0.1;
    },
    (r) => {
      r.score.firstStructuralScore = 1;
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("the producer rejects missing, repeated and contradictory stage evidence", () => {
  const report = fixture({ allWaves: true });
  for (const mutate of [
    (r) => {
      r.rounds[0].stages.splice(1, 1);
    },
    (r) => {
      r.rounds[0].stages.push(r.rounds[0].stages[1]);
    },
    (r) => {
      r.rounds[0].stages[0].comparison.differenceIds = [];
    },
    (r) => {
      r.rounds[0].measurements[0].buildPassed = true;
    },
    (r) => {
      r.rounds[0].measurements[1].resultMatched = true;
    },
    (r) => {
      r.rounds[0].measurements[2].buildPassed = false;
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("standalone validation recomputes every public score and ledger", () => {
  const safe = canonicalMultiAgentResult(fixture());
  for (const mutate of [
    (r) => {
      r.rounds[1].score.structural.ledger[1].change = 1;
    },
    (r) => {
      r.rounds[1].score.normalized = 1;
    },
    (r) => {
      r.score.score = 100;
    },
    (r) => {
      r.rounds[1].structure.initialDifferences = [];
    },
    (r) => {
      r.rounds[1].stages[1].differences = [digest("extra")];
    },
  ])
    assert.throws(() => validateCanonicalResult(changed(safe, mutate)));
});

test("standalone results reject unknown fields at each public boundary", () => {
  const safe = canonicalMultiAgentResult(fixture());
  for (const mutate of [
    (r) => {
      r.prompt = "unexpected";
    },
    (r) => {
      r.configuration.authFile = "unexpected";
    },
    (r) => {
      r.source.path = "unexpected";
    },
    (r) => {
      r.workload.plan[0].source = "unexpected";
    },
    (r) => {
      r.rounds[0].measurements[0].stderr = "unexpected";
    },
    (r) => {
      r.execution.pid = 123;
    },
    (r) => {
      r.usage.raw = "unexpected";
    },
    (r) => {
      r.authorization.referenceConcurrency = {};
    },
  ])
    assert.throws(() => validateCanonicalResult(changed(safe, mutate)));
});

test("legacy or changed protocols and policies are never relabelled as canonical results", () => {
  const report = fixture();
  for (const mutate of [
    (r) => {
      r.version = "renderer-concurrent-restoring-run-v2";
    },
    (r) => {
      r.protocol = "other-protocol";
    },
    (r) => {
      r.policy.maxEditingWaves = 5;
    },
    (r) => {
      r.policy.diff.context = 4;
    },
    (r) => {
      r.sourceClean = false;
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("delivery packets cannot exceed the configured batch size", () => {
  const report = fixture();
  report.configuration.batchSize = 1;
  assert.equal(report.executions[0].ids.length, 2);
  assert.throws(() => canonicalMultiAgentResult(report));
});

test("complete exports require each trusted restoration receipt and the final endpoint identity", () => {
  const report = fixture();
  for (const mutate of [
    (r) => {
      delete r.rounds[0].restoration;
    },
    (r) => {
      r.rounds[1].restoration.restored = false;
    },
    (r) => {
      r.rounds[0].restoration.identity = digest("untrusted round endpoint");
    },
    (r) => {
      delete r.final;
    },
    (r) => {
      r.final = r.scope.initial;
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("a final restoration failure preserves measured evidence without completing the result", () => {
  const report = fixture();
  report.status = "error";
  report.terminal = {
    category: "infrastructure",
    name: "Error",
    message: "fixture restoration stop",
  };
  delete report.rounds.at(-1).restoration;
  report.final = report.scope.roundEndpoints.at(-2).identity;
  const safe = canonicalMultiAgentResult(report);
  assert.equal(safe.status, "error");
  assert.equal(safe.score.observedRounds, report.scope.totalRounds);
  assert.equal(safe.score.plannedRounds, report.scope.totalRounds);
  assert.equal(safe.score.score, 87.5);
  assert.equal(safe.score.complete, false);
  assert.equal(validateCanonicalResult(safe), true);
});

test("planned round order and denominators cannot be changed in exports", () => {
  const report = fixture();
  for (const mutate of [
    (r) => {
      r.plan[0].totalHunks = 0;
    },
    (r) => {
      r.plan[1].round = r.plan[0].round;
    },
    (r) => {
      r.rounds.reverse();
    },
    (r) => {
      r.rounds[0].structure.totalHunks = 3;
    },
    (r) => {
      r.scope.totalRounds = 1;
    },
    (r) => {
      r.scope.totalAtoms = 1;
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("complete results require every recorded namespace to be closed", () => {
  const report = fixture();
  for (const mutate of [
    (r) => {
      r.participants[0].closed = false;
      r.participants[0].closedMs = null;
      r.agentsClosed[0] = false;
    },
    (r) => {
      r.agentsClosed[0] = false;
    },
    (r) => {
      r.participants[1].participant.lifetime = r.participants[0].participant.lifetime;
    },
    (r) => {
      r.participants[1].participant.sessionId = r.participants[0].participant.sessionId;
    },
    (r) => {
      delete r.participants[0].participant.process.agentStart;
    },
    (r) => {
      r.terminal = { category: "infrastructure", name: "Error", message: "fixture" };
    },
    (r) => {
      r.status = "running";
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("kernel concurrency samples must reference real unique recorded sessions under the cap", () => {
  const report = fixture();
  for (const mutate of [
    (r) => {
      r.concurrency.samples[0].liveSessions = [0, 0];
    },
    (r) => {
      r.concurrency.samples[0].liveSessions = [99];
    },
    (r) => {
      r.concurrency.peakObserved = 2;
    },
    (r) => {
      r.concurrency.samples[0].atMs = 100;
    },
    (r) => {
      r.configuration.maxConcurrentAgents = 0;
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("delivery accounting binds global sessions, phases and work identities", () => {
  const report = fixture();
  for (const mutate of [
    (r) => {
      r.deliveries++;
    },
    (r) => {
      r.repairs++;
    },
    (r) => {
      r.executions[0].session = 99;
    },
    (r) => {
      r.executions[0].stage = "image-correction";
    },
    (r) => {
      r.executions[0].status = "running";
    },
    (r) => {
      r.executions[0].ids.push(r.executions[0].ids[0]);
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("public numeric measurements and identity labels reject non-finite or private values", () => {
  const safe = canonicalMultiAgentResult(fixture());
  for (const mutate of [
    (r) => {
      r.durationMs = Infinity;
    },
    (r) => {
      r.usage.input = NaN;
    },
    (r) => {
      r.usage.cost = -1;
    },
    (r) => {
      r.configuration.model = "/home/operator/key";
    },
    (r) => {
      r.configuration.model = "provider/sk-secret";
    },
    (r) => {
      r.rounds[1].structure.initialDifferences = ["raw-source-name.cpp"];
    },
    (r) => {
      r.execution.closedParticipants--;
    },
  ])
    assert.throws(() => validateCanonicalResult(changed(safe, mutate)));
});

test("a closed native startup without registration exports as a stopped attempt", () => {
  const report = stoppedStartupFixture();
  const safe = canonicalMultiAgentResult(report);
  assert.equal(validateCanonicalResult(safe), true);
  assert.equal(safe.status, "error");
  assert.equal(safe.score.complete, false);
  assert.equal(safe.execution.participants, 1);
  assert.equal(safe.execution.closedParticipants, 1);
  assert.equal(safe.execution.registeredParticipants, 0);
  assert.equal(safe.execution.unregisteredParticipants, 1);
  assert.equal(safe.execution.deliveries, 0);
  assert.equal(safe.terminal.category, "driver_exit");
});

test("unregistered startup attempts cannot bind deliveries or concurrency samples", () => {
  const report = stoppedStartupFixture();
  for (const mutate of [
    (r) => {
      r.participants[0].registeredMs = 1;
    },
    (r) => {
      r.participants[0].closed = false;
      r.participants[0].closedMs = null;
      r.agentsClosed[0] = false;
    },
    (r) => {
      r.concurrency.samples = [{ atMs: 1, liveSessions: [0] }];
      r.concurrency.peakObserved = 1;
    },
    (r) => {
      r.executions = [
        {
          round: "R001",
          stage: "original",
          session: 0,
          agent: 0,
          ids: ["original-R001-0"],
          status: "error",
          receipt: {},
        },
      ];
      r.deliveries = 1;
    },
    (r) => {
      const measured = fixture({ interrupted: true });
      r.rounds = measured.rounds;
      r.final = measured.final;
      r.score = measured.score;
    },
  ])
    assert.throws(() => canonicalMultiAgentResult(changed(report, mutate)));
});

test("standalone participant counts preserve registered and unregistered attempts", () => {
  const safe = canonicalMultiAgentResult(stoppedStartupFixture());
  for (const mutate of [
    (r) => {
      r.execution.registeredParticipants++;
    },
    (r) => {
      r.execution.unregisteredParticipants--;
    },
    (r) => {
      r.execution.closedParticipants--;
    },
    (r) => {
      r.execution.peakNativeObserved = 1;
    },
    (r) => {
      r.execution.deliveries = 1;
    },
  ])
    assert.throws(() => validateCanonicalResult(changed(safe, mutate)));
  const complete = canonicalMultiAgentResult(fixture());
  assert.equal(complete.execution.registeredParticipants, complete.execution.participants);
  assert.equal(complete.execution.unregisteredParticipants, 0);
  assert.throws(() =>
    validateCanonicalResult(
      changed(complete, (r) => {
        r.execution.registeredParticipants--;
        r.execution.unregisteredParticipants++;
      }),
    ),
  );
});

test("legitimate native lifetimes within one editing cohort may overlap", () => {
  const report = fixture({ interrupted: true });
  const extra = structuredClone(report.participants[0]);
  extra.session = 1;
  extra.agent = 1;
  extra.registeredMs = 1;
  extra.closedMs = 8;
  extra.participant = {
    sessionId: "session-extra",
    lifetime: "lifetime-extra",
    process: {
      rootPid: 3000,
      rootStart: "300",
      namespace: "pid:[3000]",
      agentHostPid: 3001,
      agentStart: "301",
      agentPid: 2,
    },
  };
  report.participants.push(extra);
  const second = structuredClone(report.executions[0]);
  second.session = 1;
  second.agent = 1;
  second.ids = [report.executions[0].ids.pop()];
  report.executions.push(second);
  report.configuration.batchSize = 1;
  report.deliveries = 2;
  report.agentsClosed = [true, true];
  report.concurrency.samples.push({ atMs: 2, liveSessions: [0, 1] });
  report.concurrency.peakObserved = 2;
  report.usage = Object.fromEntries(
    Object.entries(knownUsage()).map(([key, value]) => [key, value * 2]),
  );
  const safe = canonicalMultiAgentResult(report);
  assert.equal(safe.execution.peakNativeObserved, 2);
  assert.equal(safe.execution.registeredParticipants, 2);
  assert.equal(validateCanonicalResult(safe), true);
});

test("a stopped result cannot be promoted after its final restoration failed", () => {
  const report = fixture();
  report.status = "error";
  report.terminal = {
    category: "infrastructure",
    name: "Error",
    message: "fixture restoration stop",
  };
  delete report.rounds.at(-1).restoration;
  report.final = report.scope.roundEndpoints.at(-2).identity;
  const safe = canonicalMultiAgentResult(report);
  assert.equal(safe.restoration.completedRounds, 1);
  assert.equal(safe.restoration.finalIdentity, report.final);
  assert.equal(safe.score.observedRounds, 2);
  assert.throws(() =>
    validateCanonicalResult(
      changed(safe, (r) => {
        r.status = "complete";
        r.terminal = null;
        r.score = { ...r.score, complete: true };
      }),
    ),
  );
  const complete = canonicalMultiAgentResult(fixture());
  for (const mutate of [
    (r) => {
      r.restoration.completedRounds--;
    },
    (r) => {
      r.restoration.finalIdentity = r.workload.initial;
    },
    (r) => {
      r.restoration.privatePath = "unexpected";
    },
  ])
    assert.throws(() => validateCanonicalResult(changed(complete, mutate)));
});

test("a correction cohort cannot overlap the original cohort in its own round", () => {
  const report = fixture({ allWaves: true });
  report.participants[1].registeredMs = 1;
  report.participants[1].closedMs = 19;
  assert.throws(() => canonicalMultiAgentResult(report));
});

test("a finalized round cannot retain a live participant in a stopped report", () => {
  const report = fixture({ interrupted: true });
  report.participants[0].closed = false;
  report.participants[0].closedMs = null;
  report.agentsClosed[0] = false;
  assert.throws(() => canonicalMultiAgentResult(report));
});
test("native lifetimes from separate round or correction cohorts cannot overlap", () => {
  const report = fixture();
  report.participants[1].registeredMs = 1;
  report.participants[1].closedMs = 20;
  assert.throws(() => canonicalMultiAgentResult(report));
});
