import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeTree, treeIdentity } from "../generation/generator.mjs";
import {
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../execution/candidate-evidence.mjs";
import { canonicalIntegrationNodes } from "../execution/canonical-diagnostics.mjs";
import { compilerDiagnostics } from "../grading/repair-diagnostics.mjs";
import { measureExtractionCandidate } from "../grading/coherent-build.mjs";
import { captureExtractionState } from "./run.mjs";
import { runExtractionWave } from "./wave.mjs";
import { EXTRACTION_RECOVERY_POLICY, extractionScore } from "./score.mjs";
import { recoveryResources } from "./recovery-resources.mjs";
import { selectRecoveryBatch } from "./recovery-schedule.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plain = (value) => JSON.parse(JSON.stringify(value));

function structuralTasks(plan, structure, compiler = []) {
  const failed = new Map(
    structure.files
      .filter(({ targetMatched, sourceMatched }) => !targetMatched || !sourceMatched)
      .map((file) => [file.id, file]),
  );
  const tasks = plan.tasks
    .filter(({ id }) => failed.has(id))
    .map((task) => ({
      ...task,
      recovery: {
        stage: "structural-correction",
        originalAgent: plan.tasks.findIndex(({ id }) => id === task.id) % plan.agents,
        verified: {
          targetMatched: failed.get(task.id).targetMatched,
          sourceMatched: failed.get(task.id).sourceMatched,
        },
        diagnostics: [
          ...structure.diagnostics.filter((item) => item.id === task.id || item.file === task.file),
          ...compiler.filter((item) => item.file === task.file),
        ],
      },
    }));
  const shared = new Set(
    structure.differenceIds.filter((id) => !plan.tasks.some((task) => task.id === id)),
  );
  if (shared.size)
    tasks.push({
      id: "repair-shared-project",
      file: "main.cpp",
      kind: "main-recovery",
      assignments: plan.tasks,
      initialSources: plan.initial,
      recovery: {
        stage: "structural-correction",
        originalAgent: tasks[0]?.recovery.originalAgent ?? 0,
        diagnostics: structure.diagnostics.filter((item) => shared.has(item.id)),
      },
    });
  return tasks;
}

/** Check all original queues at one barrier, then retain their live contexts for
 * one owner-addressed structural wave. Conflicting repairs use refreshed snapshots;
 * intermediate checks never create extra Score stages or integration attempts.
 */
export async function runExtractionRecovery(
  plan,
  outputPath,
  {
    createDriver,
    execute,
    expectedPixels,
    signal,
    measure = measureExtractionCandidate,
    assess,
    usage,
    continuation,
  } = {},
) {
  if (continuation !== undefined)
    throw Object.assign(
      new Error(
        "Recovery requires the original live participant contexts; closed saved runs cannot supply them",
      ),
      { code: "EXTRACTION_LIVE_CONTEXT_REQUIRED" },
    );
  assert.equal(plan.version, "renderer-module-extraction-plan-v2");
  assert.equal(plan.scope, "experimental-module-pairs");
  assert.equal(treeIdentity(plan.initial), plan.initialIdentity);
  assert.equal(typeof createDriver, "function");
  assert.equal(typeof execute, "function");
  const assessment =
    assess ?? (await (await import("./structure.mjs")).prepareExtractionStructure(plan));
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  await mkdir(path.join(output, "stages"), { mode: 0o700 });
  const workspace = path.join(output, "workspace");
  await writeTree(workspace, plan.initial);
  const report = {
    version: "renderer-module-extraction-run-v4",
    scope: plan.scope,
    policy: EXTRACTION_RECOVERY_POLICY,
    status: "running",
    initial: plan.initialIdentity,
    modules: plan.modules,
    agents: plan.agents,
    files: plan.tasks.map(({ id, file }) => ({ id, file })),
    started: new Date().toISOString(),
    participants: /** @type {Awaited<ReturnType<typeof runExtractionWave>>["records"]} */ ([]),
    deliveries: /** @type {Awaited<ReturnType<typeof runExtractionWave>>["deliveries"]} */ ([]),
    waves:
      /** @type {Array<{stage: string, agents: number, ids: string[], status: string, started: string, finished?: string}>} */ ([]),
    barriers: [],
    recoveryChecks: [],
    repairs: [],
    stages: [],
    first: null,
    structure: null,
    extraction: null,
    integration: null,
    score: null,
    passed: false,
  };
  let saving = Promise.resolve();
  const save = () => {
    const bytes = JSON.stringify(report, null, 2) + "\n";
    saving = saving.then(async () => {
      const pending = path.join(output, "report.pending.json");
      await writeFile(pending, bytes, { mode: 0o600 });
      await rename(pending, path.join(output, "report.json"));
    });
    return saving;
  };
  let activeStage = "original",
    poolStage = "original",
    activeSignal = signal;
  await save();

  async function capture(directory) {
    activeSignal?.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await captureExtractionState(plan, workspace, directory, {
      signal: activeSignal,
    });
    const structure = plain(await assessment(state.completeTree));
    if (state.physicalDiagnostics.length) {
      structure.inventoryMatched = false;
      structure.status = "fail";
      structure.differenceIds = [
        ...new Set([...structure.differenceIds, "preservation:physical-inventory"]),
      ].sort();
      structure.diagnostics.push(...state.physicalDiagnostics);
    }
    await assertCandidateUnchanged(workspace, state.candidate, { signal: activeSignal });
    return { ...state, structure, directory, compiler: [] };
  }

  async function boundary(stage) {
    const directory = path.join(output, "stages", stage);
    const state = await capture(directory);
    const integration = await measure(
      state.candidate.source,
      path.join(directory, "integration"),
      state.candidate.tree,
      { expectedPixels, signal: activeSignal, completeInventory: true },
    );
    await assertCandidateUnchanged(workspace, state.candidate, { signal: activeSignal });
    const stderr = await readFile(path.join(directory, "integration/compile.log"), "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    state.compiler = compilerDiagnostics(stderr, state.completeTree);
    const row = {
      stage,
      compiler: state.compiler,
      origin: "current-execution",
      differenceIds: state.structure.differenceIds,
      structure: state.structure,
      extraction: state.extraction,
      integration: plain(integration),
      candidateIdentity: state.candidate.identity,
      candidateManifestSha256: hash(
        await readFile(path.join(directory, "candidate/manifest.json")),
      ),
    };
    report.stages.push(row);
    report.structure = row.structure;
    report.extraction = row.extraction;
    report.integration = row.integration;
    report.score = extractionScore({ totalFiles: plan.tasks.length, stages: report.stages });
    if (stage === "original") report.first = { ...plain(row), score: plain(report.score) };
    await save();
    return state;
  }

  function startWave(stage, tasks, agents) {
    activeStage = stage;
    const wave = {
      stage,
      agents,
      ids: tasks.map(({ id }) => id),
      status: "running",
      started: new Date().toISOString(),
    };
    report.waves.push(wave);
    return wave;
  }
  function finishWave(wave) {
    wave.status = "complete";
    wave.finished = new Date().toISOString();
  }

  async function pool(stage, tasks, agents, afterOriginal) {
    poolStage = stage;
    activeSignal?.throwIfAborted();
    const directory = path.join(output, "stages", stage);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const result = await runExtractionWave(tasks, {
      agents,
      signal,
      ...(usage ? { usage } : {}),
      ...(afterOriginal ? { afterOriginal } : {}),
      createDriver: (agent, session, context) =>
        createDriver(agent, session, { ...context, stage, workspace, directory }),
      execute: (driver, task, context) =>
        execute(driver, task, {
          ...context,
          workspace,
          directory: path.join(output, "stages", context.stage),
        }),
      onParticipant(record) {
        report.participants.push({ ...record, stage });
        return save();
      },
      onClosed(record) {
        const previous = report.participants.find(
          (item) => item.stage === stage && item.session === record.session,
        );
        if (previous) Object.assign(previous, record);
        else report.participants.push({ ...record, stage });
        return save();
      },
      onDelivery(record) {
        const phase = taskPhase(record.stage, stage);
        const previous = report.deliveries.find(
          (item) => item.stage === phase && item.index === record.index,
        );
        if (previous) Object.assign(previous, record, { stage: phase });
        else report.deliveries.push({ ...record, stage: phase });
        return save();
      },
    });
    assert.ok(result.records.every(({ closed }) => closed));
    report.participants = report.participants
      .filter((item) => item.stage !== stage)
      .concat(result.records.map((record) => ({ ...record, stage })));
    return result;
  }
  // Single integration pools have the same lifetime origin and delivery phase.
  function taskPhase(phase, origin) {
    return origin === "original" ? phase : origin;
  }

  async function repairOwners(firstState, barrier) {
    const planned = structuralTasks(plan, firstState.structure, firstState.compiler);
    if (!planned.length) return false;
    const wave = startWave(
      "structural-correction",
      planned,
      new Set(planned.map((t) => t.recovery.originalAgent)).size,
    );
    report.repairs = planned.map((task) => ({
      id: task.id,
      owner: task.recovery.originalAgent,
      status: "pending",
    }));
    const pending = new Map(report.repairs.map((record) => [record.id, record]));
    let state = firstState;
    while (pending.size) {
      activeSignal?.throwIfAborted();
      await barrier.assertIdle();
      const fresh = new Map(
        structuralTasks(plan, state.structure, state.compiler).map((task) => [task.id, task]),
      );
      const skipped = [];
      for (const [id, record] of pending)
        if (!fresh.has(id)) {
          record.status = "skipped";
          skipped.push(id);
          pending.delete(id);
        }
      const footprints = await recoveryResources(state.completeTree, state.structure);
      const candidates = [...pending.values()].map((record) => {
        const task = fresh.get(record.id);
        task.recovery.originalAgent = record.owner;
        task.recovery.candidateIdentity = state.candidate.identity;
        const resources =
          task.kind === "main-recovery"
            ? [...new Set(["main.cpp", ...task.recovery.diagnostics.map((d) => d.file)])].map(
                (file) => ({ file }),
              )
            : footprints.get(task.id);
        return { id: record.id, owner: record.owner, resources, task, record };
      });
      const { ready, deferred } = selectRecoveryBatch(candidates);
      report.recoveryChecks.push({
        index: report.recoveryChecks.length,
        candidateIdentity: state.candidate.identity,
        differenceIds: state.structure.differenceIds,
        ready: ready.map((t) => t.id),
        deferred: deferred.map((t) => t.id),
        skipped,
      });
      await save();
      if (!ready.length) break;
      await assertCandidateUnchanged(workspace, state.candidate, { signal: activeSignal });
      releaseCandidateWorkspace(workspace);
      const results = await Promise.allSettled(
        ready.map(async ({ owner, task, record }) => {
          record.status = "running";
          try {
            await barrier.recover(owner, task);
            record.status = "settled";
          } catch (error) {
            record.status = "error";
            throw error;
          }
        }),
      );
      for (const { id } of ready) pending.delete(id);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      await save();
      // Every batch gets a fresh structural snapshot, including the last one.
      // Compiler diagnostics are deliberately empty until the next real build.
      state = await capture(
        path.join(output, "recovery-checks", `check-${report.recoveryChecks.length}`),
      );
    }
    await assertCandidateUnchanged(workspace, state.candidate, { signal: activeSignal });
    releaseCandidateWorkspace(workspace);
    finishWave(wave);
    return true;
  }

  function integrationTask(stage, state) {
    const [task] = canonicalIntegrationNodes(stage, { expectedPixels });
    return {
      ...task,
      kind: "integration-recovery",
      assignments: plan.tasks,
      initialSources: plan.initial,
      recovery: { stage, originalAgent: null, diagnostics: state.compiler },
    };
  }
  async function integrationWave(stage, state) {
    const tasks = [integrationTask(stage, state)];
    const wave = startWave(stage, tasks, 1);
    releaseCandidateWorkspace(workspace);
    await save();
    await pool(stage, tasks, 1);
    finishWave(wave);
    return boundary(stage);
  }

  try {
    const original = startWave("original", plan.tasks, plan.agents);
    let state;
    const lifecycle = { corrected: false };
    await pool("original", plan.tasks, plan.agents, async (barrier) => {
      activeSignal = barrier.signal;
      try {
        finishWave(original);
        report.barriers.push({ stage: "original", participants: plain(barrier.participants) });
        await save();
        state = await boundary("original");
        lifecycle.corrected = await repairOwners(state, barrier);
      } finally {
        activeSignal = signal;
      }
    });
    if (lifecycle.corrected) state = await boundary("structural-correction");
    else await assertCandidateUnchanged(workspace, state.candidate, { signal });
    if (!report.integration.buildPassed) state = await integrationWave("build-correction", state);
    if (report.integration.buildPassed && !report.integration.resultMatched)
      await integrationWave("image-correction", state);
    report.passed =
      report.structure.status === "pass" &&
      report.integration.buildPassed &&
      report.integration.resultMatched;
    report.status = "complete";
    return report;
  } catch (error) {
    if (error.roundPool) {
      report.participants = report.participants
        .filter((item) => item.stage !== poolStage)
        .concat(error.roundPool.records.map((record) => ({ ...record, stage: poolStage })));
      for (const record of error.roundPool.deliveries ?? []) {
        const phase = taskPhase(record.stage, poolStage);
        const previous = report.deliveries.find(
          (item) => item.stage === phase && item.index === record.index,
        );
        if (previous) Object.assign(previous, record, { stage: phase });
        else report.deliveries.push({ ...record, stage: phase });
      }
    }
    const wave = report.waves.find((item) => item.stage === activeStage);
    if (wave && wave.status === "running") wave.status = "interrupted";
    report.status = "interrupted";
    report.failure = {
      name: error.name,
      code: error.code ?? null,
      category: error.category ?? null,
      message: error.message,
    };
    throw error;
  } finally {
    report.finished = new Date().toISOString();
    releaseCandidateWorkspace(workspace);
    await save();
  }
}
