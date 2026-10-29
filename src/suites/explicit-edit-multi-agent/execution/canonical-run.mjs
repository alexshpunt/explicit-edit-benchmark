import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MULTI_AGENT_BENCHMARK } from "../results.mjs";
import { CANONICAL_RUN_VERSION, CANONICAL_RUN_POLICY } from "../canonical-results.mjs";
import { writeTree } from "../generation/generator.mjs";
import { encodeSourceBytes } from "../cpp/source-bytes.mjs";
import { scoreCanonicalRounds } from "../grading/canonical-score.mjs";
import { measureCoherentCandidate } from "../grading/coherent-build.mjs";
import { compilerDiagnostics } from "../grading/repair-diagnostics.mjs";
import {
  CANONICAL_MULTI_AGENT_PROTOCOL,
  loadCanonicalPreparation,
} from "./canonical-preparation.mjs";
import { canonicalizeCapturedCandidate } from "./canonical-candidate.mjs";
import {
  canonicalAssignmentPrompt,
  canonicalCorrectionNodes,
  canonicalIntegrationNodes,
} from "./canonical-diagnostics.mjs";
import { runCanonicalRound } from "./canonical-round.mjs";
import { runRoundPool } from "./round-pool.mjs";
import { startPiParticipant, finalizedUsage } from "./pi-baseline.mjs";
import { resolvePiParticipantProfile } from "./pi-profile.mjs";
import { restoringSourceIdentity } from "./restoring-identity.mjs";
import {
  captureCandidate,
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "./candidate-evidence.mjs";
import { restoreCanonicalSource } from "./canonical-restore.mjs";

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
  const loaded = await loadCanonicalPreparation(preparationPath, canonicalPath, {
    agents,
    signal: externalSignal,
  });
  const privateConfig = configPath ? JSON.parse(await readFile(configPath, "utf8")) : {};
  const { agentLifecycle, maxConcurrentAgents: configuredCap, ...config } = privateConfig;
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
  const plan = loaded.canonical.manifest.rounds.map(({ round, totalHunks }) => ({
    round,
    totalHunks,
  }));
  const report = {
    ...source,
    version: CANONICAL_RUN_VERSION,
    benchmark: MULTI_AGENT_BENCHMARK,
    protocol: CANONICAL_MULTI_AGENT_PROTOCOL,
    mode: "measured",
    status: "running",
    policy: CANONICAL_RUN_POLICY,
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
    checks: [],
    deliveries: 0,
    repairs: 0,
    usage: null,
    agentsClosed: [],
    concurrency: { method: "kernel-samples-at-participant-start", peakObserved: 0, samples: [] },
    score: scoreCanonicalRounds([], plan.length),
    initialCheck: null,
    terminal: null,
    final: loaded.manifest.initial,
  };
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
  /** @type {Awaited<ReturnType<typeof captureCandidate>> | undefined} */
  let lastCaptured;
  let nextSession = 0;
  const publicTasks = new Map(loaded.taskList.map((task) => [task.id, task]));
  const requirements = [];
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
    await writeTree(workspace, loaded.initial);
    boundary = await captureCandidate(workspace, path.join(output, "initial-candidate"), {
      signal,
      includeAllFiles: true,
    });
    assertTrustedCapture(boundary, loaded.initial);
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
    for (const round of loaded.schedule) {
      signal.throwIfAborted();
      const interval = loaded.atomicIntervals.rounds.get(round.id);
      for (const { task } of round.assignments)
        requirements.push({ id: task, prompt: publicTasks.get(task).prompt });
      const roundOutput = path.join(output, "rounds", round.id);
      await mkdir(roundOutput, { mode: 0o700 });
      const prepared = loaded.canonical.rounds.get(round.id).preparedDiff;
      const outcome = await runCanonicalRound({
        prepared,
        signal,
        executeWave: async ({ stage, comparison, integration }) => {
          await releaseBoundary();
          const nodes =
            stage === "original"
              ? interval.nodes
              : stage === "structural-correction"
                ? canonicalCorrectionNodes(comparison)
                : canonicalIntegrationNodes(stage, {
                    diagnostics: compilerDiagnostics(
                      integration?.failure?.cause?.stderr,
                      lastCaptured?.lexicalTree ?? {},
                    ),
                    requirements,
                  });
          const sessions = new Map();
          const records = new Map();
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
              const driver = createDriver
                ? await createDriver(workspace, state, agent, {
                    session,
                    round: round.id,
                    stage,
                    signal: participantSignal,
                  })
                : await startPiParticipant(workspace, state, config, {
                    signal: participantSignal,
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
            executeBatch: (driver, members, { signal: deliverySignal }) =>
              driver.execute(canonicalAssignmentPrompt(members), {
                completion: "turn",
                signal: deliverySignal,
              }),
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
          lastCaptured = captured;
          const snapshot = await canonicalizeCapturedCandidate(captured);
          await assertCandidateUnchanged(workspace, captured, { signal });
          await writeFile(path.join(evidence, "canonical.json"), JSON.stringify(snapshot) + "\n", {
            flag: "wx",
            mode: 0o600,
          });
          return { snapshot, captured, evidence };
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
            totalHunks: row.comparison.totalHunks,
            passedHunks: row.comparison.passedHunks,
            disagreements: row.comparison.differenceIds.length,
          });
          await writeFile(
            path.join(candidate.evidence, "comparison.json"),
            JSON.stringify(row.comparison) + "\n",
            { flag: "wx", mode: 0o600 },
          );
          await onCase({ kind: "captured", round: round.id, stage: row.stage });
          await save();
        },
      });
      const result = { round: round.id, ...outcome };
      report.rounds.push(result);
      report.score = scoreCanonicalRounds(report.rounds, plan.length);
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
    report.score = scoreCanonicalRounds(report.rounds, plan.length);
    report.elapsedMs = elapsed();
    await save();
  }
  return report;
}
