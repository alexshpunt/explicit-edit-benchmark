import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MULTI_AGENT_BENCHMARK } from "../results.mjs";
import { writeTree } from "../generation/generator.mjs";
import { encodeSourceBytes } from "../cpp/source-bytes.mjs";
import { coherentTaskPrompt } from "../tasks/coherent-tasks.mjs";
import { measureCoherentCandidate } from "../grading/coherent-build.mjs";
import { STRUCTURAL_UNIT_POLICY, prepareStructuralUnits } from "../grading/structural-units.mjs";
import {
  STRUCTURAL_UNIT_SCORE_POLICY,
  structuralUnitRunScore,
} from "../grading/structural-unit-score.mjs";
import {
  CANONICAL_MULTI_AGENT_PROTOCOL,
  loadCanonicalPreparation,
} from "./canonical-preparation.mjs";
import { CANONICAL_CANDIDATE_POLICY, capturedUnitInput } from "./canonical-candidate.mjs";
import {
  canonicalAssignmentPrompt,
  canonicalIntegrationNodes,
  prepareCanonicalFeedback,
} from "./canonical-diagnostics.mjs";
import { runCanonicalRound } from "./canonical-round.mjs";
import { ROUND_POOL_DEADLINE_POLICY, ROUND_POOL_POLICY, runRoundPool } from "./round-pool.mjs";
import {
  PROVIDER_RECOVERY_POLICY,
  admitProviderDelivery,
  createProviderRecovery,
} from "./provider-recovery.mjs";
import { startPiParticipant, finalizedUsage } from "./pi-baseline.mjs";
import { resolvePiParticipantProfile } from "./pi-profile.mjs";
import { restoringSourceIdentity } from "./restoring-identity.mjs";
import {
  captureCandidate,
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "./candidate-evidence.mjs";
import { restoreCanonicalSource } from "./canonical-restore.mjs";
import { CHUNK_DELIVERY_DEADLINE_MS, executeChunkDelivery } from "./chunk-delivery-deadline.mjs";
import {
  STRUCTURAL_UNIT_CORRECTION_POLICY,
  structuralUnitCorrections,
} from "./structural-unit-corrections.mjs";

/** Restoring runs scored by structural unit differences. Version 1 reports keep
 * their text-hunk policy and are exported by canonical-results.mjs only.
 */
export const CANONICAL_UNIT_RUN_VERSION = "renderer-canonical-run-v2";
export const CANONICAL_UNIT_RUN_POLICY = Object.freeze({
  version: "renderer-canonical-policy-v2",
  candidate: CANONICAL_CANDIDATE_POLICY,
  candidateBuild: "captured-complete-physical-inventory",
  units: STRUCTURAL_UNIT_POLICY,
  corrections: STRUCTURAL_UNIT_CORRECTION_POLICY,
  score: STRUCTURAL_UNIT_SCORE_POLICY,
  pool: ROUND_POOL_POLICY,
  deadline: ROUND_POOL_DEADLINE_POLICY,
  delivery: Object.freeze({
    deadlineSeconds: CHUNK_DELIVERY_DEADLINE_MS / 1000,
    onTimeout: "retire-and-continue",
  }),
  providerRecovery: PROVIDER_RECOVERY_POLICY,
  schedule: "original-structural-build-result",
  maxEditingWaves: 4,
  restoration: "trusted-round-end-after-saving-candidate",
});

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const usageFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"];

function aggregateUsage(participants) {
  if (!participants.length || participants.every(({ usage }) => usage === null)) return null;
  return Object.fromEntries(
    usageFields.map((key) => [
      key,
      participants.every(({ usage }) => Number.isFinite(usage?.[key]))
        ? participants.reduce((sum, { usage }) => sum + usage[key], 0)
        : null,
    ]),
  );
}

/** Check the complete trusted byte inventory without reparsing cached endpoints. */
function assertTrustedCapture(candidate, tree) {
  const directories = new Set();
  const files = Object.entries(tree);
  assert.equal(candidate.contents.size, files.length, "Trusted regular file inventory differs");
  for (const [file, value] of files) {
    const bytes = Buffer.isBuffer(value) ? value : encodeSourceBytes(value);
    assert.deepEqual(candidate.contents.get(encodeSourceBytes(file).toString("base64")), bytes);
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      directories.add(parts.slice(0, depth).join("/"));
  }
  assert.equal(candidate.manifest.entries.length, files.length + directories.size);
  for (const entry of candidate.manifest.entries) {
    if (entry.type === "directory") assert.ok(directories.has(entry.path));
    else assert.equal(entry.type, "file", "Trusted source contains an unexpected physical entry");
  }
}

/** One kernel sample is a lower bound at registration time, not a wrapper count.
 * Every inspected process was already registered when the sample began.
 */
async function sampleNativeConcurrency(participants, atMs) {
  const eligible = participants.filter(
    ({ closed, participant }) => !closed && participant?.process,
  );
  const liveSessions = [];
  for (const entry of eligible) {
    const identity = entry.participant.process;
    try {
      const stat = await readFile(`/proc/${identity.agentHostPid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      if (["Z", "X"].includes(fields[0])) continue;
      assert.equal(fields[19], identity.agentStart, "Native process lifetime changed");
      assert.equal(await readlink(`/proc/${identity.agentHostPid}/ns/pid`), identity.namespace);
      liveSessions.push(entry.session);
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return { atMs, liveSessions };
}

/** Select a trusted start without importing historical measurements or changing the plan. */
export function canonicalRunStart(loaded, fromRound = 1) {
  assert.ok(
    Number.isSafeInteger(fromRound) && fromRound >= 1 && fromRound <= loaded.schedule.length,
    "Invalid canonical starting round",
  );
  const skippedRounds = loaded.schedule.slice(0, fromRound - 1).map(({ id }) => id);
  const initial = skippedRounds.length
    ? loaded.atomicIntervals.rounds.get(skippedRounds.at(-1))?.expectedTree
    : loaded.initial;
  assert.ok(initial && typeof initial === "object", "Missing trusted starting endpoint");
  return {
    initial,
    schedule: loaded.schedule.slice(fromRound - 1),
    skippedRounds,
    mode: skippedRounds.length ? "diagnostic-continuation" : "measured",
  };
}

/** Run the separate canonical-diff protocol. Configuration authorizes inference;
 * retained references authorize only the original workload's feasibility. All
 * grading happens after complete native namespace closure, never between packets.
 */
export async function runCanonical(
  preparationPath,
  outputPath,
  {
    canonicalPath,
    agents,
    configPath,
    createDriver,
    maxConcurrentAgents,
    batchSize = 10,
    fromRound = 1,
    referenceProofPath,
    allowModelCalls = false,
    signal: externalSignal,
    log = console.log,
    onCase = async () => {},
  } = {},
) {
  assert.ok(canonicalPath, "A validated canonical preparation is required");
  assert.ok(
    Boolean(configPath) !== Boolean(createDriver),
    "Choose exactly one participant factory",
  );
  assert.equal(typeof allowModelCalls, "boolean");
  assert.ok(!configPath || allowModelCalls, "Model execution requires explicit authorization");
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, "Invalid canonical packet size");
  externalSignal?.throwIfAborted();
  const source = await restoringSourceIdentity();
  assert.equal(source.sourceClean, true, "Canonical execution requires clean committed source");
  if (configPath) {
    assert.ok(referenceProofPath, "Model execution requires a scripted reference proof");
    const proof = JSON.parse(await readFile(referenceProofPath, "utf8"));
    assert.equal(proof.version, CANONICAL_UNIT_RUN_VERSION, "The reference proof uses another run");
    assert.equal(proof.status, "pass", "The reference proof did not pass");
    assert.equal(
      proof.sourceCommit,
      source.sourceCommit,
      "The reference proof is for other source",
    );
  }
  const loaded = await loadCanonicalPreparation(preparationPath, canonicalPath, {
    agents,
    signal: externalSignal,
  });
  const start = canonicalRunStart(loaded, fromRound);
  const privateConfig = configPath ? JSON.parse(await readFile(configPath, "utf8")) : {};
  const {
    agentLifecycle,
    maxConcurrentAgents: configuredCap,
    cppCorrectionCommand,
    ...config
  } = privateConfig;
  assert.equal(
    cppCorrectionCommand,
    undefined,
    "Unit-scored restoring has no source correction command",
  );
  assert.ok(
    agentLifecycle === undefined || agentLifecycle === "round-ready-pool",
    "Canonical execution requires the round-ready lifecycle",
  );
  const cap = maxConcurrentAgents ?? configuredCap ?? 30;
  assert.ok(Number.isSafeInteger(cap) && cap > 0, "Invalid canonical native process limit");
  const profile = configPath ? await resolvePiParticipantProfile(config) : null;
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal.reason);
  const signal = controller.signal;
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const output = path.resolve(outputPath),
    workspace = path.join(output, "workspace");
  await mkdir(output, { mode: 0o700 });
  for (const file of ["participants", "rounds", "boundaries"])
    await mkdir(path.join(output, file), { mode: 0o700 });
  // Every planned round is prepared from its trusted start, including skipped rounds.
  const preparedRounds = new Map();
  let roundStart = loaded.initial;
  for (const round of loaded.schedule) {
    signal.throwIfAborted();
    const expectedTree = loaded.atomicIntervals.rounds.get(round.id).expectedTree;
    preparedRounds.set(round.id, await prepareStructuralUnits(roundStart, expectedTree));
    roundStart = expectedTree;
  }
  const plan = loaded.schedule.map(({ id }) => ({
    round: id,
    totalUnits: preparedRounds.get(id).totalUnits,
  }));
  const report = {
    ...source,
    version: CANONICAL_UNIT_RUN_VERSION,
    benchmark: MULTI_AGENT_BENCHMARK,
    protocol: CANONICAL_MULTI_AGENT_PROTOCOL,
    mode: start.mode,
    ...(start.skippedRounds.length
      ? {
          continuation: {
            fromRound,
            skippedRounds: start.skippedRounds,
            priorResultsImported: false,
            freshParticipantHistories: true,
          },
        }
      : {}),
    status: "running",
    policy: CANONICAL_UNIT_RUN_POLICY,
    configuration: {
      agents: loaded.agents,
      maxConcurrentAgents: cap,
      batchSize,
      agentLifecycle: "round-ready-pool",
      model: configPath ? config.model : null,
      thinking: configPath ? config.thinking : null,
      harness: profile ? (profile.baseline ? "baseline-agent" : profile.harness.id) : null,
      harnessVersion: profile
        ? profile.baseline
          ? profile.version
          : profile.harness.version
        : null,
      runtime: profile
        ? {
            agent: "pi",
            version: profile.version,
            platform: process.platform,
            architecture: process.arch,
          }
        : null,
    },
    scope: loaded.canonical.manifest.scope,
    preparation: {
      manifestSha256: digest(JSON.stringify(loaded.canonical.manifest) + "\n"),
      canonicalVersion: loaded.canonical.manifest.canonicalVersion,
      canonicalizer: loaded.canonical.manifest.canonicalizer,
      inventory: loaded.canonical.manifest.inventory,
    },
    authorization: loaded.authorization,
    plan,
    rounds: [],
    participants: [],
    executions: [],
    providerRecovery: [],
    checks: [],
    deliveries: 0,
    repairs: 0,
    usage: null,
    agentsClosed: [],
    concurrency: { method: "kernel-samples-at-participant-start", peakObserved: 0, samples: [] },
    score: structuralUnitRunScore([], plan.length),
    initialCheck: null,
    terminal: null,
    final: start.skippedRounds.length
      ? loaded.canonical.manifest.rounds[fromRound - 2].endSourceIdentity
      : loaded.manifest.initial,
  };
  const recovery = createProviderRecovery({
    onEvent(event) {
      const row = { ...event, atMs: elapsed() };
      appendFileSync(path.join(output, "provider-recovery.jsonl"), JSON.stringify(row) + "\n", {
        mode: 0o600,
      });
      report.providerRecovery.push(row);
      log(`RECOVERY ${event.type}`);
    },
  });
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(async () => {
      await writeFile(
        path.join(output, "report.pending.json"),
        JSON.stringify(report, null, 2) + "\n",
        { mode: 0o600 },
      );
      await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
    });
    return saving;
  };
  /** @type {Awaited<ReturnType<typeof captureCandidate>> | undefined} */
  let boundary;
  let nextSession = 0;
  async function releaseBoundary() {
    if (boundary) await assertCandidateUnchanged(workspace, boundary, { signal });
    releaseCandidateWorkspace(workspace);
    boundary = undefined;
  }
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await save();
    await writeTree(workspace, start.initial);
    boundary = await captureCandidate(workspace, path.join(output, "initial-candidate"), {
      signal,
      includeAllFiles: true,
    });
    assertTrustedCapture(boundary, start.initial);
    const initial = await measureCoherentCandidate(
      boundary.source,
      path.join(output, "initial-verification"),
      boundary.tree,
      { expectedPixels: loaded.manifest.pixels, signal, completeInventory: true },
    );
    await assertCandidateUnchanged(workspace, boundary, { signal });
    report.initialCheck = {
      buildPassed: initial.buildPassed,
      resultMatched: initial.resultMatched,
    };
    assert.ok(
      initial.buildPassed && initial.resultMatched,
      "Trusted initial source failed integration verification",
    );
    await save();
    for (const round of start.schedule) {
      signal.throwIfAborted();
      const interval = loaded.atomicIntervals.rounds.get(round.id);
      const roundOutput = path.join(output, "rounds", round.id);
      await mkdir(roundOutput, { mode: 0o700 });
      const prepared = preparedRounds.get(round.id);
      const outcome = await runCanonicalRound({
        prepared,
        signal,
        executeWave: async ({ stage, comparison }) => {
          const nodes =
            stage === "original"
              ? interval.nodes.map((node) => ({
                  ...node,
                  prompt: coherentTaskPrompt("", node.operations),
                }))
              : stage === "structural-correction"
                ? structuralUnitCorrections(prepared, comparison).map(({ id, prompt }) => ({
                    id,
                    kind: "unit-correction",
                    dependencies: [],
                    prompt,
                  }))
                : canonicalIntegrationNodes(stage, { expectedPixels: loaded.manifest.pixels });
          await releaseBoundary();
          const sessions = new Map();
          const records = new Map();
          const feedbackDirectories = new Map();
          log(`EDIT ${round.id}/${stage}`);
          await runRoundPool(nodes, {
            maxAgents: cap,
            batchSize,
            signal,
            usage: (driver) =>
              Array.isArray(driver.events) ? finalizedUsage(driver.events) : null,
            createDriver: async (agent, localSession, { signal: participantSignal }) => {
              const session = nextSession++;
              sessions.set(localSession, session);
              const state = path.join(output, "participants", `session-${session}`);
              const feedbackDirectory = path.join(output, "feedback", `session-${session}`);
              await mkdir(feedbackDirectory, { recursive: true, mode: 0o700 });
              feedbackDirectories.set(localSession, feedbackDirectory);
              const driver = createDriver
                ? await createDriver(workspace, state, agent, {
                    session,
                    round: round.id,
                    stage,
                    signal: participantSignal,
                    feedbackDirectory,
                    onRecovery: (request) => recovery.wait(request),
                    onProviderFailure: (error) => recovery.stop(error),
                  })
                : await startPiParticipant(workspace, state, config, {
                    signal: participantSignal,
                    feedbackDirectory,
                    onRecovery: (request) => recovery.wait(request),
                    onProviderFailure: (error) => recovery.stop(error),
                    eventsFile: state + "-events.jsonl",
                    enforceProcessBoundary: true,
                  });
              const entry = {
                session,
                agent,
                round: round.id,
                stage,
                created: true,
                closed: false,
                participant: null,
                registeredMs: null,
                closedMs: null,
                usage: null,
              };
              records.set(localSession, entry);
              report.participants.push(entry);
              return driver;
            },
            onParticipant: async (record) => {
              const entry = records.get(record.session);
              entry.participant = record.participant;
              entry.registeredMs = elapsed();
              const sample = await sampleNativeConcurrency(report.participants, entry.registeredMs);
              report.concurrency.samples.push(sample);
              report.concurrency.peakObserved = Math.max(
                report.concurrency.peakObserved,
                sample.liveSessions.length,
              );
              assert.ok(
                report.concurrency.peakObserved <= cap,
                "Native process occupancy exceeded its bound",
              );
              await onCase({ kind: "participant", ...entry });
            },
            onClosed: async (record) => {
              const entry = records.get(record.session);
              if (!entry) return;
              entry.closed = record.closed;
              entry.closedMs = elapsed();
              entry.usage = record.usage;
              report.agentsClosed = report.participants.map(({ closed }) => closed);
              await onCase({ kind: "closed", ...entry });
            },
            onDelivery: async (event) => {
              const session = sessions.get(event.session);
              if (event.event === "start") {
                report.executions.push({ round: round.id, stage, ...event, session });
                report.deliveries++;
                if (stage !== "original") report.repairs++;
              } else {
                const row = report.executions.findLast(
                  (item) => item.session === session && item.status === "running",
                );
                assert.ok(row, "Missing canonical delivery receipt");
                Object.assign(row, event, { session });
              }
              await save();
            },
            executeBatch: async (driver, members, { session, signal: deliverySignal }) => {
              await admitProviderDelivery(recovery, { signal: deliverySignal });
              const packet = await prepareCanonicalFeedback(
                members,
                feedbackDirectories.get(session),
              );
              const delivery = await executeChunkDelivery(
                driver,
                canonicalAssignmentPrompt(packet),
                { signal: deliverySignal },
              );
              return delivery.status === "timed-out" ? { timedOut: true } : delivery.receipt;
            },
          });
          assert.ok(
            [...records.values()].every(({ closed }) => closed),
            "Grading cannot begin with live participants",
          );
          await save();
        },
        capture: async ({ stage }) => {
          const evidence = path.join(roundOutput, stage);
          await mkdir(evidence, { mode: 0o700 });
          const captured = await captureCandidate(workspace, path.join(evidence, "candidate"), {
            signal,
            includeAllFiles: true,
          });
          boundary = captured;
          const units = capturedUnitInput(captured);
          await assertCandidateUnchanged(workspace, captured, { signal });
          return { units, captured, evidence };
        },
        measure: async ({ captured, evidence }) => {
          await assertCandidateUnchanged(workspace, captured, { signal });
          const measured = await measureCoherentCandidate(
            captured.source,
            path.join(evidence, "integration"),
            captured.tree,
            { expectedPixels: loaded.manifest.pixels, signal, completeInventory: true },
          );
          await assertCandidateUnchanged(workspace, captured, { signal });
          return measured;
        },
        onStage: async (row, { candidate }) => {
          report.checks.push({
            round: round.id,
            stage: row.stage,
            totalUnits: prepared.totalUnits,
            disagreements: row.structure ? row.structure.differenceIds.length : null,
            buildPassed: row.integration?.buildPassed ?? null,
            resultMatched: row.integration?.resultMatched ?? null,
          });
          if (row.structure)
            await writeFile(
              path.join(candidate.evidence, "comparison.json"),
              JSON.stringify(row.structure) + "\n",
              { flag: "wx", mode: 0o600 },
            );
          await onCase({ kind: "captured", round: round.id, stage: row.stage });
          await save();
        },
      });
      const result = { round: round.id, ...outcome };
      report.rounds.push(result);
      report.score = structuralUnitRunScore(
        report.rounds.map(({ score }) => score),
        plan.length,
      );
      await save();
      await releaseBoundary();
      result.restoration = await restoreCanonicalSource(workspace, interval.expectedTree, {
        signal,
      });
      report.final = result.restoration.identity;
      boundary = await captureCandidate(workspace, path.join(output, "boundaries", round.id), {
        signal,
        includeAllFiles: true,
      });
      assertTrustedCapture(boundary, interval.expectedTree);
      await onCase({ kind: "restored", round: round.id, identity: report.final });
      log(`CHECK ${round.id}: ${outcome.score.score.toFixed(3)}%`);
      await save();
    }
    report.status = "complete";
  } catch (error) {
    controller.abort(error);
    report.status =
      externalSignal?.aborted || error?.name === "AbortError" || error?.category === "cancelled"
        ? "cancelled"
        : "error";
    report.terminal = {
      category: error?.category ?? (report.status === "cancelled" ? "cancelled" : "infrastructure"),
      name: error?.name ?? (report.status === "cancelled" ? "AbortError" : "Error"),
      message: error?.message ?? String(error),
    };
  } finally {
    releaseCandidateWorkspace(workspace);
    externalSignal?.removeEventListener("abort", abort);
    report.agentsClosed = report.participants.map(({ closed }) => closed);
    report.usage = aggregateUsage(report.participants);
    report.score = structuralUnitRunScore(
      report.rounds.map(({ score }) => score),
      plan.length,
    );
    report.elapsedMs = elapsed();
    await save();
  }
  return report;
}

/** Scripted participants for a model-free proof of the unit-scored route. The first
 * original delivery of each round writes the round's trusted endpoint; every other
 * delivery leaves the project unchanged. Operation feasibility comes from the
 * retained proof that the preparation already validated.
 */
function endpointReferenceDrivers(loaded) {
  const written = new Set();
  let serial = 0;
  return async (workspace, _state, _agent, { round, stage }) => {
    const id = ++serial;
    return {
      closed: false,
      ready: Promise.resolve(),
      async assertIdle() {
        return { sessionId: `endpoint-reference-${id}`, messageCount: 0 };
      },
      async execute() {
        assert.equal(stage, "original", "The scripted reference received a correction");
        if (written.has(round)) return { scripted: "unchanged" };
        written.add(round);
        await restoreCanonicalSource(
          workspace,
          loaded.atomicIntervals.rounds.get(round).expectedTree,
        );
        return { scripted: "endpoint" };
      },
      async terminate() {
        this.closed = true;
      },
    };
  };
}

/** Model-free reference run: every round must reach Score 100 without corrections. */
export async function verifyCanonical(preparationPath, outputPath, options = {}) {
  const { canonicalPath, agents, signal } = options;
  const loaded = await loadCanonicalPreparation(preparationPath, canonicalPath, {
    agents,
    signal,
  });
  const report = await runCanonical(preparationPath, outputPath, {
    ...options,
    createDriver: endpointReferenceDrivers(loaded),
  });
  const summary = {
    version: CANONICAL_UNIT_RUN_VERSION,
    reference: "scripted-trusted-endpoint-writer",
    sourceCommit: report.sourceCommit,
    sourceClean: report.sourceClean,
    status:
      report.status === "complete" &&
      report.score.score === 100 &&
      report.rounds.every(({ attempts }) => attempts.length === 0)
        ? "pass"
        : "fail",
    rounds: report.rounds.length,
    totalUnits: report.plan.reduce((sum, { totalUnits }) => sum + totalUnits, 0),
    score: report.score.score,
    terminal: report.terminal,
  };
  await writeFile(
    path.join(path.resolve(outputPath), "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return summary;
}
