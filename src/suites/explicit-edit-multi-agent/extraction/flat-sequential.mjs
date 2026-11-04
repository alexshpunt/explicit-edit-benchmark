import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../execution/candidate-evidence.mjs";
import { treeIdentity, writeTree } from "../generation/generator.mjs";
import { measureExtractionCandidate } from "../grading/coherent-build.mjs";
import { flatExpected } from "./flat-plan.mjs";
import { captureExtractionState } from "./run.mjs";
import { prepareExtractionStructure } from "./structure.mjs";
import { runExtractionWave } from "./wave.mjs";

/** Keep fixed agent contexts but serialize deliveries and inspect each candidate. */
export async function runFlatSequential(
  plan,
  outputPath,
  {
    agents = 10,
    createDriver,
    execute,
    inspect,
    expectedPixels,
    measure = measureExtractionCandidate,
    usage,
    signal,
  } = {},
) {
  assert.equal(treeIdentity(plan.initial), plan.initialIdentity);
  assert.equal(typeof createDriver, "function");
  assert.equal(typeof execute, "function");
  assert.equal(typeof inspect, "function");
  assert.ok(
    Number.isSafeInteger(agents) && agents > 0 && agents <= 10 && agents <= plan.tasks.length,
  );
  const output = path.resolve(outputPath),
    workspace = path.join(output, "workspace");
  await mkdir(output, { mode: 0o700 });
  await writeTree(workspace, plan.initial);
  const report = {
    version: "renderer-flat-sequential-run-v1",
    runId: randomUUID(),
    status: "running",
    initial: plan.initialIdentity,
    agents,
    rounds: [],
    participants: [],
    deliveries: [],
    deliveryEvents: [],
    integration: null,
    started: new Date().toISOString(),
  };
  const save = async () => {
    await writeFile(
      path.join(output, "report.pending.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
  };
  await save();
  const candidates = [];
  const completed = [];
  let currentAgent = 0;
  async function inspectCompleted(task, context) {
    const index = completed.length;
    const tasks = [...completed, task];
    const partial = { ...plan, tasks, expected: flatExpected(plan.initial, tasks) };
    const directory = path.join(output, "rounds", String(index).padStart(3, "0"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await captureExtractionState(partial, workspace, directory, {
      signal: context.signal,
      gradeStrict: false,
    });
    const assess = await prepareExtractionStructure(partial, { sorted: true });
    const structure = await assess(state.completeTree);
    if (state.physicalDiagnostics.length) {
      structure.status = "fail";
      structure.inventoryMatched = false;
      structure.differenceIds.push("preservation:physical-inventory");
      structure.diagnostics.push(...state.physicalDiagnostics);
    }
    const row = {
      id: task.id,
      file: task.file,
      candidateIdentity: state.candidate.identity,
      evidence: path.relative(output, path.dirname(state.candidate.source)),
      structure,
      inspection: "awaiting",
    };
    report.rounds.push(row);
    await save();
    const request = Object.freeze({
      runId: report.runId,
      sequence: index,
      stage: "flat-original",
      round: index,
      ids: [task.id],
      candidateIdentity: state.candidate.identity,
      evidence: path.dirname(state.candidate.source),
      report: path.join(output, "report.json"),
      signal: context.signal,
    });
    const approval = await inspect(request);
    assert.equal(approval?.runId, report.runId);
    assert.equal(approval.sequence, index);
    assert.equal(approval.candidateIdentity, state.candidate.identity);
    await assertCandidateUnchanged(workspace, state.candidate, { signal: context.signal });
    row.inspection = "approved";
    await save();
    candidates.push(state.candidate);
    completed.push(task);
  }
  try {
    for (let agent = 0; agent < agents; agent++) {
      currentAgent = agent;
      const group = plan.tasks.filter((_task, index) => index % agents === agent);
      const wave = await runExtractionWave(group, {
        agents: 1,
        createDriver: (_slot, _session, context) => createDriver(agent, agent, context),
        signal,
        ...(usage ? { usage } : {}),
        async onDelivery(event) {
          report.deliveryEvents.push({ ...event, agent, session: agent });
          await save();
        },
        execute: (driver, task, context) =>
          execute(driver, task, { ...context, agent, session: agent, workspace }),
        async beforeRound(context) {
          if (context.round > 0) await inspectCompleted(group[context.round - 1], context);
        },
        async afterOriginal(context) {
          await inspectCompleted(group.at(-1), context);
        },
      });
      assert.ok(wave.records.every(({ closed }) => closed));
      report.participants.push(
        ...wave.records.map((record) => ({ ...record, agent, session: agent })),
      );
      const firstDelivery = report.deliveries.length;
      report.deliveries.push(
        ...wave.deliveries.map((delivery, index) => ({
          ...delivery,
          index: firstDelivery + index,
          agent,
          session: agent,
        })),
      );
      await save();
    }
    assert.equal(report.rounds.length, plan.tasks.length);
    const finalCandidate = candidates.at(-1);
    assert.ok(finalCandidate);
    if (report.rounds.at(-1).structure.status === "pass") {
      report.integration = await measure(
        finalCandidate.source,
        path.join(output, "integration"),
        finalCandidate.tree,
        { expectedPixels, signal, completeInventory: true },
      );
      await assertCandidateUnchanged(workspace, finalCandidate, { signal });
    }
    report.status = "complete";
    report.passed =
      report.rounds.at(-1).structure.status === "pass" &&
      report.integration?.buildPassed === true &&
      report.integration.resultMatched === true;
    return report;
  } catch (error) {
    if (error.roundPool) {
      report.participants.push(
        ...error.roundPool.records.map((record) => ({
          ...record,
          agent: currentAgent,
          session: currentAgent,
        })),
      );
      const firstDelivery = report.deliveries.length;
      report.deliveries.push(
        ...(error.roundPool.deliveries ?? []).map((delivery, index) => ({
          ...delivery,
          index: firstDelivery + index,
          agent: currentAgent,
          session: currentAgent,
        })),
      );
    }
    report.status = "interrupted";
    report.failure = { name: error.name, code: error.code ?? null, message: error.message };
    throw error;
  } finally {
    report.finished = new Date().toISOString();
    releaseCandidateWorkspace(workspace);
    await save();
  }
}
