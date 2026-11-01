import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plain = (value) => JSON.parse(JSON.stringify(value));

function structuralTasks(plan, structure, compiler) {
  const failed = new Set(
    structure.files
      .filter(({ targetMatched, sourceMatched }) => !targetMatched || !sourceMatched)
      .map(({ id }) => id),
  );
  const tasks = plan.tasks
    .filter(({ id }) => failed.has(id))
    .map((task) => ({
      ...task,
      recovery: {
        stage: "structural-correction",
        originalAgent: plan.tasks.findIndex(({ id }) => id === task.id) % plan.agents,
        diagnostics: [
          ...structure.diagnostics.filter((item) => item.id === task.id || item.file === task.file),
          ...compiler.filter((item) => item.file === task.file),
        ],
      },
    }));
  if (structure.differenceIds.some((id) => !plan.tasks.some((task) => task.id === id)))
    tasks.push({
      id: "repair-shared-project",
      file: "main.cpp",
      kind: "main-recovery",
      assignments: plan.tasks,
      initialSources: plan.initial,
      recovery: {
        stage: "structural-correction",
        originalAgent: null,
        diagnostics: [
          ...structure.diagnostics,
          ...compiler.filter((item) => item.file === "main.cpp"),
        ],
      },
    });
  assert.ok(tasks.length > 0, "Structural differences require a complete repair assignment");
  return tasks;
}

/** Execute original work and at most one correction at each budgeted boundary.
 * A continuation supplies captured model work and its already measured integration;
 * the controller copies that candidate unchanged and never repairs project source.
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
  if (continuation)
    await cp(continuation.source, workspace, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
  else await writeTree(workspace, plan.initial);
  const report = {
    version: "renderer-module-extraction-run-v3",
    scope: plan.scope,
    policy: EXTRACTION_RECOVERY_POLICY,
    status: "running",
    initial: plan.initialIdentity,
    modules: plan.modules,
    agents: plan.agents,
    files: plan.tasks.map(({ id, file }) => ({ id, file })),
    ...(continuation ? { continuation: continuation.binding } : {}),
    started: new Date().toISOString(),
    participants: /** @type {Awaited<ReturnType<typeof runExtractionWave>>["records"]} */ ([]),
    deliveries: /** @type {Awaited<ReturnType<typeof runExtractionWave>>["deliveries"]} */ ([]),
    waves:
      /** @type {Array<{stage: string, agents: number, ids: string[], status: string, started: string, finished?: string}>} */ ([]),
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
  await save();
  let activeStage = "original";
  async function boundary(stage, inherited = false) {
    signal?.throwIfAborted();
    const directory = path.join(output, "stages", stage);
    if (inherited) await mkdir(directory, { mode: 0o700 });
    const state = await captureExtractionState(plan, workspace, directory, { signal });
    if (inherited) assert.equal(state.candidate.identity, continuation.binding.candidateIdentity);
    const structure = plain(await assessment(state.completeTree));
    if (
      (!state.extraction.inventoryMatched || state.candidate.invalid.length) &&
      structure.inventoryMatched
    ) {
      structure.inventoryMatched = false;
      structure.status = "fail";
      structure.differenceIds = [
        ...new Set([...structure.differenceIds, "preservation:physical-inventory"]),
      ].sort();
      structure.diagnostics.push({
        id: "preservation:physical-inventory",
        file: "main.cpp",
        kind: "inventory",
      });
    }
    await assertCandidateUnchanged(workspace, state.candidate, { signal });
    const integration = inherited
      ? continuation.integration
      : await measure(
          state.candidate.source,
          path.join(directory, "integration"),
          state.candidate.tree,
          {
            expectedPixels,
            signal,
            completeInventory: true,
          },
        );
    await assertCandidateUnchanged(workspace, state.candidate, { signal });
    const integrationEvidence = inherited
      ? continuation.integrationEvidence
      : path.join(directory, "integration");
    const stderr = await readFile(path.join(integrationEvidence, "compile.log"), "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    const compiler = compilerDiagnostics(stderr, state.completeTree);
    const row = {
      stage,
      compiler,
      origin: inherited ? "source-observation" : "current-execution",
      differenceIds: structure.differenceIds,
      structure,
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
    return { directory, completeTree: state.completeTree, compiler };
  }
  async function wave(stage, tasks, agents) {
    activeStage = stage;
    signal?.throwIfAborted();
    releaseCandidateWorkspace(workspace);
    const directory = path.join(output, "stages", stage);
    await mkdir(directory, { mode: 0o700 });
    const waveRecord = {
      stage,
      agents,
      ids: tasks.map(({ id }) => id),
      status: "running",
      started: new Date().toISOString(),
    };
    report.waves.push(waveRecord);
    await save();
    const result = await runExtractionWave(tasks, {
      agents,
      signal,
      ...(usage ? { usage } : {}),
      createDriver: (agent, session, context) =>
        createDriver(agent, session, { ...context, stage, workspace, directory }),
      execute: (driver, task, context) =>
        execute(driver, task, { ...context, stage, workspace, directory }),
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
        const previous = report.deliveries.find(
          (item) => item.stage === stage && item.index === record.index,
        );
        if (previous) Object.assign(previous, record);
        else report.deliveries.push({ ...record, stage });
        return save();
      },
    });
    assert.ok(result.records.every(({ closed }) => closed));
    report.participants = report.participants
      .filter((item) => item.stage !== stage)
      .concat(result.records.map((record) => ({ ...record, stage })));
    report.deliveries = report.deliveries
      .filter((item) => item.stage !== stage)
      .concat(result.deliveries.map((record) => ({ ...record, stage })));
    waveRecord.status = "complete";
    waveRecord.finished = new Date().toISOString();
    return boundary(stage);
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
  try {
    let state;
    if (continuation) state = await boundary("original", true);
    else state = await wave("original", plan.tasks, plan.agents);
    if (report.structure.differenceIds.length) {
      const tasks = structuralTasks(plan, report.structure, state.compiler);
      state = await wave("structural-correction", tasks, Math.min(plan.agents, tasks.length));
    }
    if (!report.integration.buildPassed)
      state = await wave("build-correction", [integrationTask("build-correction", state)], 1);
    if (report.integration.buildPassed && !report.integration.resultMatched)
      await wave("image-correction", [integrationTask("image-correction", state)], 1);
    report.passed =
      report.structure.status === "pass" &&
      report.integration.buildPassed &&
      report.integration.resultMatched;
    report.status = "complete";
    return report;
  } catch (error) {
    if (error.roundPool) {
      report.participants = report.participants
        .filter((item) => item.stage !== activeStage)
        .concat(error.roundPool.records.map((record) => ({ ...record, stage: activeStage })));
      report.deliveries = report.deliveries
        .filter((item) => item.stage !== activeStage)
        .concat(
          (error.roundPool.deliveries ?? []).map((record) => ({ ...record, stage: activeStage })),
        );
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
