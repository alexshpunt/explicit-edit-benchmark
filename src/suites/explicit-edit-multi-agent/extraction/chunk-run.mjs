import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeTree } from "../generation/generator.mjs";
import { measureExtractionCandidate } from "../grading/coherent-build.mjs";
import { compilerDiagnostics } from "../grading/repair-diagnostics.mjs";
import {
  STRUCTURAL_UNIT_POLICY,
  compareStructuralUnits,
  prepareStructuralUnits,
} from "../grading/structural-units.mjs";
import {
  STRUCTURAL_UNIT_SCORE_POLICY,
  structuralUnitScore,
} from "../grading/structural-unit-score.mjs";
import {
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../execution/candidate-evidence.mjs";
import { CHUNK_DELIVERY_DEADLINE_MS } from "../execution/chunk-delivery-deadline.mjs";
import { runFinalChunkTeams } from "../execution/chunk-final-teams.mjs";
import { chunkModelDrivers } from "../execution/chunk-model-drivers.mjs";
import { runChunkTeam } from "../execution/chunk-team.mjs";
import { restoringSourceIdentity } from "../execution/restoring-identity.mjs";
import {
  STRUCTURAL_UNIT_CORRECTION_POLICY,
  structuralUnitCorrections,
} from "../execution/structural-unit-corrections.mjs";
import {
  CHUNK_SECOND_TEAM_FILE,
  cleanChunkTree,
  cleanupChunkMarkers,
  prepareChunkCase,
} from "./chunk-case.mjs";
import { captureExtractionState } from "./run.mjs";

export const CHUNK_RUN_VERSION = "renderer-chunk-run-v1";
export const CHUNK_TEAM_AGENTS = 10;
export const CHUNK_ASSIGNMENT_BYTES = 2048;
export const CHUNK_RUN_POLICY = Object.freeze({
  version: "renderer-chunk-policy-v1",
  teams: Object.freeze({
    agents: CHUNK_TEAM_AGENTS,
    secondTeamFile: CHUNK_SECOND_TEAM_FILE,
    structuralCorrection: "fresh-team-sequential-assignments",
    integrationCorrection: "one-fresh-agent-per-stage",
  }),
  assignmentBytes: CHUNK_ASSIGNMENT_BYTES,
  delivery: Object.freeze({
    deadlineSeconds: CHUNK_DELIVERY_DEADLINE_MS / 1000,
    onTimeout: "retire-and-continue",
  }),
  schedule: "original-structural-build-result",
  units: STRUCTURAL_UNIT_POLICY,
  corrections: STRUCTURAL_UNIT_CORRECTION_POLICY,
  score: STRUCTURAL_UNIT_SCORE_POLICY,
});

const GENERAL_PROMPT = new URL("../prompts/general.txt", import.meta.url);
const hash = (data) => createHash("sha256").update(data).digest("hex");

/** The same general instructions precede the first assignment of every model session. */
export async function loadGeneralPrompt() {
  return readFile(GENERAL_PROMPT, "utf8");
}

/** Model execution and its reference proof require the same clean committed source. */
export async function chunkRunIdentity(manifest, general) {
  const source = await restoringSourceIdentity();
  assert.equal(source.sourceClean, true, "Chunk runs require clean committed source");
  return {
    source,
    planSha256: manifest.planSha256,
    generalSha256: hash(general),
    policy: CHUNK_RUN_POLICY.version,
  };
}

export function physicalUnits(diagnostics) {
  return diagnostics.map(({ file, pathBytes, type }) => ({
    file: file ?? `(path bytes ${pathBytes})`,
    scope: [],
    kind: "physical-entry",
    ordered: true,
    text: type === "file" ? "regular file" : type,
  }));
}

export function integrationPrompt(stage, state, pixels) {
  const details = (state.compiler ?? [])
    .slice(0, 30)
    .map(
      (item) =>
        `In ${item.file} at line ${item.line}, column ${item.column}, the compiler reports ${item.severity}: ${item.message}`,
    )
    .join("\n");
  const build =
    "Compile every C++ translation unit in the project with clang++, using C++17, no optimization, floating-point contraction disabled, pthread support and the support directory as an include path. Preserve unrelated project changes. Diagnose and repair the failure, then repeat the check.";
  if (stage === "build-correction")
    return [
      "The shared project failed its build check.",
      details || "No public source-located compiler diagnostics were available.",
      build,
    ].join("\n\n");
  return [
    state.integration.buildPassed
      ? "The shared project built but its rendered images did not match. Diagnose and fix the image failure while preserving unrelated project changes."
      : "The shared project still fails to build, so the images could not be checked. Restore the build and rendered results while preserving unrelated project changes.",
    details,
    build,
    `Run the renderer twice, each time passing a distinct output prefix. Each run must produce two deterministic 32 by 32 RGBA float images. The expected SHA-256 of scene zero is ${pixels[0]}. The expected SHA-256 of scene one is ${pixels[1]}. Verify both scenes and both runs after the repair.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Run every editing stage of one chunk observation. Pools supply participants:
 * native model sessions for observations, scripted writers for the reference.
 */
async function runChunkObservation({ setup, output, pools, identity, general, signal }) {
  const { originalPlan, plan, manifest, tree, markers, sourceMarkers, prose, batches } = setup;
  const workspace = path.join(output, "workspace");
  await mkdir(output, { mode: 0o700 });
  await writeTree(workspace, tree);
  const prepared = await prepareStructuralUnits(cleanChunkTree(tree, setup), originalPlan.expected);
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const report = {
    version: CHUNK_RUN_VERSION,
    policy: CHUNK_RUN_POLICY,
    mode: pools.mode,
    identity,
    status: "running",
    started: new Date().toISOString(),
    totalUnits: prepared.totalUnits,
    startIdentity: prepared.startIdentity,
    referenceIdentity: prepared.referenceIdentity,
    generalSha256: hash(general),
    phases: /** @type {any[]} */ ([]),
    participants: /** @type {any[]} */ ([]),
    deliveries: /** @type {any[]} */ ([]),
    captures: /** @type {any[]} */ ([]),
    stages: /** @type {any[]} */ ([]),
    attempts: /** @type {any[]} */ ([]),
    score: null,
    passed: false,
  };
  let saving = Promise.resolve();
  const save = () => {
    const bytes = JSON.stringify(report, null, 2) + "\n";
    saving = saving.then(async () => {
      await writeFile(path.join(output, "report.pending.json"), bytes, { mode: 0o600 });
      await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
    });
    return saving;
  };
  const event = (type, data) =>
    appendFileSync(
      path.join(output, "events.jsonl"),
      JSON.stringify({ time: new Date().toISOString(), type, ...data }) + "\n",
      { mode: 0o600 },
    );
  await save();

  // Assignments for one source file wait until earlier batches have created its markers.
  let inFlight = 0,
    change = Promise.withResolvers();
  const wake = () => {
    const previous = change;
    change = Promise.withResolvers();
    previous.resolve();
  };
  async function waitForChange(observed, abortSignal) {
    const cancelled = Promise.withResolvers();
    const abort = () => cancelled.reject(abortSignal.reason);
    abortSignal.addEventListener("abort", abort, { once: true });
    if (abortSignal.aborted) abort();
    try {
      await Promise.race([observed, cancelled.promise]);
    } finally {
      abortSignal.removeEventListener("abort", abort);
    }
  }
  async function resolveBatch(task, batch, abortSignal) {
    for (;;) {
      abortSignal.throwIfAborted();
      const observed = change.promise;
      const [source, destination] = await Promise.all([
        readFile(path.join(workspace, "main.cpp"), "utf8"),
        readFile(path.join(workspace, task.file), "utf8"),
      ]);
      try {
        for (const fragment of batch.fragments) {
          const marker = markers.get(fragment.id),
            at = destination.indexOf(marker);
          assert.ok(
            at >= 0 && at === destination.lastIndexOf(marker),
            "Destination marker is missing or ambiguous",
          );
        }
        const shown = prose.render(task, batch.fragments, {
          currentSource: source,
          completed: new Set(),
          markers,
          sourceMarkers,
        });
        prose.validate(source, shown);
        return shown.prompt;
      } catch (error) {
        if (error?.code !== "ERR_ASSERTION") throw error;
        if (!inFlight) return { blocked: error.message };
        await waitForChange(observed, abortSignal);
      }
    }
  }
  const drivers = {
    other: pools.create("other"),
    math: pools.create("math"),
    repair: pools.create("structural-correction"),
  };
  const notifications = (name) => ({
    onDelivery: (item) => event(`${name}-worker`, item),
    onParticipant(record) {
      report.participants.push({ phase: name, ...record });
      return save();
    },
    onClosed(record) {
      const row = report.participants.find(
        (item) => item.phase === name && item.session === record.session,
      );
      if (row) Object.assign(row, record);
      else report.participants.push({ phase: name, ...record });
      return save();
    },
  });
  const team = (name) => {
    const pool = drivers[name];
    async function execute(driver, batch, context) {
      const task = byId.get(batch.taskId),
        shown = await resolveBatch(task, batch, context.signal);
      if (
        typeof shown === "string" &&
        Buffer.byteLength(shown) > CHUNK_ASSIGNMENT_BYTES &&
        batch.fragments.length > 1
      ) {
        const middle = Math.ceil(batch.fragments.length / 2);
        context.defer({
          ...batch,
          id: batch.id + "-b",
          fragments: batch.fragments.slice(middle),
        });
        return execute(
          driver,
          { ...batch, id: batch.id + "-a", fragments: batch.fragments.slice(0, middle) },
          context,
        );
      }
      const row = {
        phase: name,
        group: context.group,
        index: context.index,
        taskId: task.id,
        batchId: batch.id,
        agent: context.agent,
        session: context.session,
        status: "running",
      };
      report.deliveries.push(row);
      event("batch-start", row);
      if (typeof shown !== "string") {
        row.status = "blocked";
        row.reason = shown.blocked;
        event("batch-blocked", row);
        void save();
        return { blocked: true };
      }
      row.bytes = Buffer.byteLength(shown);
      row.units = batch.fragments.length;
      inFlight++;
      try {
        const result = await pool.execute(driver, shown, { ...context, task, batch });
        if (result.status === "timed-out") {
          row.status = "timed-out";
          return { timedOut: true };
        }
        row.receipt = result.receipt;
        row.status = "settled";
        return row.receipt;
      } catch (error) {
        row.status = "error";
        throw error;
      } finally {
        inFlight--;
        event("batch-end", row);
        wake();
        void save();
      }
    }
    return { ...pool, ...notifications(name), agents: CHUNK_TEAM_AGENTS, execute };
  };

  let currentCandidate = null,
    markersCleaned = false;
  async function releaseChecked(abortSignal) {
    if (!currentCandidate) return;
    await assertCandidateUnchanged(workspace, currentCandidate, { signal: abortSignal });
    releaseCandidateWorkspace(workspace);
    currentCandidate = null;
  }
  async function capture({ stage, assessStructure, measureIntegration, index, signal: abort }) {
    abort.throwIfAborted();
    if (!markersCleaned) {
      await cp(workspace, path.join(output, "before-marker-cleanup"), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      report.remainingMarkers = await cleanupChunkMarkers(workspace, setup);
      markersCleaned = true;
      await save();
    }
    await releaseChecked(abort);
    const directory = path.join(output, "captures", `${String(index).padStart(4, "0")}-${stage}`);
    const row = {
      index,
      stage,
      assessStructure,
      measureIntegration,
      directory: path.relative(output, directory),
      status: "running",
    };
    report.captures.push(row);
    await save();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await captureExtractionState(originalPlan, workspace, directory, {
      signal: abort,
      gradeStrict: false,
    });
    currentCandidate = state.candidate;
    let structure, corrections;
    if (assessStructure) {
      structure = await compareStructuralUnits(prepared, state.completeTree, {
        extraUnits: physicalUnits(state.physicalDiagnostics),
      });
      corrections = structuralUnitCorrections(prepared, structure);
      structure.fileDifferenceIds = corrections.map(({ id }) => id);
    }
    await assertCandidateUnchanged(workspace, state.candidate, { signal: abort });
    let integration,
      compiler = [];
    if (measureIntegration) {
      integration = await measureExtractionCandidate(
        state.candidate.source,
        path.join(directory, "integration"),
        state.candidate.tree,
        { expectedPixels: manifest.pixels, signal: abort, completeInventory: true },
      );
      await assertCandidateUnchanged(workspace, state.candidate, { signal: abort });
      const log = await readFile(path.join(directory, "integration", "compile.log"), "utf8").catch(
        (error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        },
      );
      compiler = compilerDiagnostics(log, state.completeTree);
    }
    row.status = "complete";
    row.candidateIdentity = state.candidate.identity;
    if (structure) row.differenceIds = structure.differenceIds;
    await save();
    return {
      structure,
      corrections,
      integration,
      compiler,
      directory: row.directory,
      candidateIdentity: state.candidate.identity,
    };
  }
  async function teamCompleted(name, phase) {
    report.phases.push({
      name,
      status: phase.status,
      records: phase.records,
      timeouts: phase.timeouts,
      unissued: phase.unissued,
    });
    await save();
  }
  async function update({ stages, attempts }) {
    report.stages = stages.map(
      ({ stage, structure, integration, directory, candidateIdentity, compiler }) => ({
        stage,
        structure,
        integration,
        directory,
        candidateIdentity,
        compiler,
      }),
    );
    report.attempts = structuredClone(attempts);
    await save();
  }
  async function repairStructural({ id, state, participant, signal: abort }) {
    const assignment = state.corrections.find((item) => item.id === id);
    assert.ok(assignment, "Unknown structural correction assignment");
    await releaseChecked(abort);
    const row = {
      phase: "structural-correction",
      assignment: id,
      file: assignment.file,
      differences: assignment.differenceIds.length,
      agent: participant.agent,
      session: participant.session,
      status: "running",
    };
    report.deliveries.push(row);
    await save();
    event("repair-start", row);
    try {
      const result = await drivers.repair.execute(participant.driver, assignment.prompt, {
        signal: abort,
        session: participant.session,
        retire: participant.retire,
      });
      if (result.status === "timed-out") {
        row.status = "timed-out";
        return { timedOut: true };
      }
      row.receipt = result.receipt;
      row.status = "settled";
    } catch (error) {
      row.status = "error";
      throw error;
    } finally {
      event("repair-end", row);
      await save();
    }
  }
  const repairTeam = {
    ...drivers.repair,
    ...notifications("structural-correction"),
    agents: CHUNK_TEAM_AGENTS,
    async execute() {
      throw new Error("Structural correction assignments are issued by the recovery schedule");
    },
  };
  async function repairIntegration({ stage, state, signal: abort }) {
    const prompt = integrationPrompt(stage, state, manifest.pixels);
    await releaseChecked(abort);
    const pool = pools.create(stage);
    let failure;
    try {
      const result = await runChunkTeam([{ id: stage, batches: [{ id: stage }] }], {
        ...pool,
        ...notifications(stage),
        agents: 1,
        signal: abort,
        async execute(driver, _batch, context) {
          const row = {
            phase: stage,
            agent: context.agent,
            session: context.session,
            status: "running",
          };
          report.deliveries.push(row);
          await save();
          event("repair-start", row);
          try {
            const outcome = await pool.execute(driver, prompt, context);
            if (outcome.status === "timed-out") {
              row.status = "timed-out";
              return { timedOut: true };
            }
            row.receipt = outcome.receipt;
            row.status = "settled";
          } catch (error) {
            row.status = "error";
            throw error;
          } finally {
            event("repair-end", row);
            await save();
          }
        },
      });
      await teamCompleted(stage, result);
      if (result.timeouts.length) return { timedOut: true };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await pool.cleanup().catch((error) => {
        if (!failure) throw error;
        report.cleanupFailure = { name: error.name, message: error.message };
      });
    }
  }

  try {
    const tasks = (filter) =>
      plan.tasks.filter(filter).map((task) => ({ id: task.id, batches: batches.get(task.id) }));
    const mathTasks = tasks((task) => task.file === CHUNK_SECOND_TEAM_FILE);
    assert.equal(mathTasks.length, 1);
    const result = await runFinalChunkTeams({
      otherTasks: tasks((task) => task.file !== CHUNK_SECOND_TEAM_FILE),
      mathTasks,
      other: team("other"),
      math: team("math"),
      repairTeam,
      totalFiles: prepared.totalUnits,
      capture,
      repairStructural,
      repairIntegration,
      score: structuralUnitScore,
      onUpdate: update,
      onTeamCompleted: teamCompleted,
      signal,
    });
    assert.equal(result.math.records.length, CHUNK_TEAM_AGENTS);
    report.score = result.recovery.score;
    const final = report.stages.at(-1);
    report.passed =
      final.structure.differenceIds.length === 0 &&
      final.integration.buildPassed &&
      final.integration.resultMatched;
    report.status = "complete";
  } catch (error) {
    report.status = "interrupted";
    for (const row of report.captures) if (row.status === "running") row.status = "interrupted";
    report.failure = { name: error.name, message: error.message, category: error.category ?? null };
    if (error.roundPool) report.interruptedPool = error.roundPool;
    event("failure", report.failure);
    throw error;
  } finally {
    releaseCandidateWorkspace(workspace);
    for (const pool of Object.values(drivers)) {
      try {
        await pool.cleanup();
      } catch (error) {
        report.status = "interrupted";
        report.passed = false;
        report.score = null;
        report.cleanupFailure = { name: error.name, message: error.message };
      }
    }
    report.finished = new Date().toISOString();
    await save();
  }
  return report;
}

function replaceUnique(content, needle, replacement) {
  const at = content.indexOf(needle);
  assert.ok(at >= 0 && at === content.lastIndexOf(needle), "Reference marker missing or duplicate");
  return content.slice(0, at) + replacement + content.slice(at + needle.length);
}

/** Scripted participants move exactly the assigned fragments and never correct anything. */
function referencePools(workspace, { sourceMarkers, rawMarkers }) {
  const moved = new Set();
  let serial = 0,
    active = 0,
    maxActive = 0;
  return {
    mode: "scripted-reference",
    stats: () => ({ moved: moved.size, maxActive }),
    create: () => ({
      async createDriver() {
        const id = ++serial;
        return {
          closed: false,
          ready: Promise.resolve(),
          async assertIdle() {
            return { sessionId: `reference-${id}`, messageCount: 0 };
          },
          async terminate() {
            this.closed = true;
          },
        };
      },
      async execute(_driver, _prompt, context) {
        assert.ok(context?.batch?.fragments, "The scripted reference received a correction");
        active++;
        maxActive = Math.max(active, maxActive);
        try {
          await sleep(context.index % 7 === 0 ? 5 : context.index % 3);
          const { task, batch } = context;
          // Synchronous reads and writes keep each scripted delivery atomic in the event loop.
          let source = readFileSync(path.join(workspace, "main.cpp"), "utf8"),
            destination = readFileSync(path.join(workspace, task.file), "utf8");
          for (const fragment of batch.fragments) {
            assert.ok(!moved.has(fragment.id));
            source = replaceUnique(source, sourceMarkers.get(fragment.id) + fragment.text, "");
            destination = replaceUnique(destination, rawMarkers.get(fragment.id), fragment.text);
            moved.add(fragment.id);
          }
          // Agents have no such guarantee. Renames keep concurrent controller reads whole.
          for (const [file, content] of [
            ["main.cpp", source],
            [task.file, destination],
          ]) {
            const target = path.join(workspace, file);
            writeFileSync(target + ".reference-write", content);
            renameSync(target + ".reference-write", target);
          }
          return { status: "settled", receipt: { units: batch.fragments.length } };
        } finally {
          active--;
        }
      },
      async cleanup() {},
    }),
  };
}

/** Model-free proof that the measured route reaches the trusted endpoint with Score 100. */
export async function verifyChunkCase(casePath, outputPath, { signal } = {}) {
  const output = path.resolve(outputPath);
  const setup = await prepareChunkCase(casePath);
  const general = await loadGeneralPrompt();
  const identity = await chunkRunIdentity(setup.manifest, general);
  const pools = referencePools(path.join(output, "workspace"), setup);
  const report = await runChunkObservation({ setup, output, pools, identity, general, signal });
  const fragments = setup.plan.tasks.reduce((sum, task) => sum + task.fragments.length, 0);
  const stats = pools.stats();
  assert.deepEqual(await chunkRunIdentity(setup.manifest, general), identity);
  const summary = {
    version: CHUNK_RUN_VERSION,
    identity,
    status:
      report.passed &&
      report.score.score === 100 &&
      stats.moved === fragments &&
      stats.maxActive === CHUNK_TEAM_AGENTS &&
      report.attempts.length === 0
        ? "pass"
        : "fail",
    totalUnits: report.totalUnits,
    fragments,
    moved: stats.moved,
    maxActive: stats.maxActive,
    remainingMarkers: report.remainingMarkers,
    score: report.score.score,
    finalDifferences: report.stages.at(-1).structure.differenceIds.length,
    buildPassed: report.stages.at(-1).integration.buildPassed,
    resultMatched: report.stages.at(-1).integration.resultMatched,
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}

/** Spend model credit on one observation. The proof must come from the same clean source. */
export async function runChunkModel(casePath, outputPath, config, { proofPath, signal } = {}) {
  const output = path.resolve(outputPath);
  const setup = await prepareChunkCase(casePath);
  const general = await loadGeneralPrompt();
  const identity = await chunkRunIdentity(setup.manifest, general);
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  assert.equal(proof.version, CHUNK_RUN_VERSION, "The reference proof uses another runner");
  assert.equal(proof.status, "pass", "The reference proof did not pass");
  assert.deepEqual(proof.identity, identity, "The reference proof belongs to other source");
  const workspace = path.join(output, "workspace");
  const pools = {
    mode: "model",
    create: (phase) => chunkModelDrivers(path.join(output, phase), workspace, config, general),
  };
  return runChunkObservation({ setup, output, pools, identity, general, signal });
}

/** Recompute the current policy from a saved run's original and final candidates.
 * No participant runs. Missing final integration evidence is measured again.
 */
export async function rescoreChunkRun(casePath, runPath, outputPath, { signal } = {}) {
  const run = path.resolve(runPath),
    output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const setup = await prepareChunkCase(casePath);
  const report = JSON.parse(await readFile(path.join(run, "report.json"), "utf8"));
  const prepared = await prepareStructuralUnits(
    cleanChunkTree(setup.tree, setup),
    setup.originalPlan.expected,
  );
  const captures = new Map(report.captures.map((row) => [row.stage, row]));
  const recorded = new Map(report.stages.map((row) => [row.stage, row]));
  for (const stage of ["original", "final"]) assert.ok(captures.has(stage), `Missing ${stage}`);
  async function assess(stage, { integration }) {
    const workspace = path.join(output, stage, "workspace"),
      directory = path.join(output, stage, "capture");
    await cp(path.join(run, captures.get(stage).directory, "candidate", "source"), workspace, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const state = await captureExtractionState(setup.originalPlan, workspace, directory, {
        signal,
        gradeStrict: false,
      });
      const structure = await compareStructuralUnits(prepared, state.completeTree, {
        extraUnits: physicalUnits(state.physicalDiagnostics),
      });
      const measured = integration
        ? await measureExtractionCandidate(
            state.candidate.source,
            path.join(directory, "integration"),
            state.candidate.tree,
            { expectedPixels: setup.manifest.pixels, signal, completeInventory: true },
          )
        : null;
      return { identity: state.candidate.identity, structure, integration: measured };
    } finally {
      releaseCandidateWorkspace(workspace);
    }
  }
  const initial = await assess("original", { integration: false });
  assert.equal(initial.identity, captures.get("original").candidateIdentity);
  const finalRow = recorded.get("final");
  const final = await assess("final", { integration: !finalRow?.integration });
  const corrected = report.attempts.some(({ stage }) =>
    ["build-correction", "image-correction"].includes(stage),
  );
  const expectedFinal =
    captures.get("final").candidateIdentity ??
    (corrected ? null : captures.get("build-check")?.candidateIdentity);
  assert.ok(expectedFinal, "The saved run does not identify its final candidate");
  assert.equal(final.identity, expectedFinal, "Saved final candidate differs from its record");
  const buildCheck = recorded.get("build-check")?.integration;
  assert.ok(buildCheck, "The saved run has no build check");
  const recheck = recorded.get("build-recheck")?.integration;
  const before = recheck ?? buildCheck;
  const finalIntegration = finalRow?.integration ?? final.integration;
  const score = structuralUnitScore({
    initial: initial.structure,
    final: final.structure,
    buildFirstPassed: buildCheck.buildPassed,
    preRecoveryBuildPassed: before.buildPassed,
    firstImageMatched: before.buildPassed ? before.resultMatched : null,
    resultRecoveryAttempted: !before.buildPassed || before.resultMatched === false,
    finalBuildPassed: finalIntegration.buildPassed,
    finalImageMatched: finalIntegration.buildPassed ? finalIntegration.resultMatched : null,
  });
  const result = {
    version: CHUNK_RUN_VERSION,
    run: path.basename(run),
    runVersion: report.version,
    initial: { identity: initial.identity, structure: initial.structure },
    final: { identity: final.identity, structure: final.structure, integration: finalIntegration },
    score,
  };
  await writeFile(path.join(output, "rescore.json"), JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return result;
}

/** One small model delivery that checks credentials, tools and workspace writes. */
export async function chunkModelSmoke(outputPath, config) {
  const output = path.resolve(outputPath);
  await mkdir(path.join(output, "workspace"), { recursive: true, mode: 0o700 });
  const pool = chunkModelDrivers(
    path.join(output, "agent"),
    path.join(output, "workspace"),
    config,
    "",
  );
  let driver;
  try {
    driver = await pool.createDriver("smoke", 0, {});
    const receipt = await pool.execute(
      driver,
      "Create a file named readiness.txt containing exactly the single word ready. Then finish.",
      { session: 0 },
    );
    assert.equal(receipt.status, "settled");
    assert.equal(
      (await readFile(path.join(output, "workspace", "readiness.txt"), "utf8")).trim(),
      "ready",
    );
    return { status: "pass" };
  } finally {
    if (driver && !driver.closed) await driver.terminate();
    await pool.cleanup();
  }
}
