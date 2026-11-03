import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { treeIdentity, writeTree } from "../generation/generator.mjs";
import {
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../execution/candidate-evidence.mjs";
import { extractCurrentFile } from "./edit.mjs";
import { captureExtractionState } from "./run.mjs";
import { prepareExtractionStructure } from "./structure.mjs";
import { runExtractionWave } from "./wave.mjs";

/** Diagnostic only: no shared candidate, recovery, build, render or benchmark score. */
export async function runIsolatedExtraction(
  plan,
  outputPath,
  { createDrivers, inspect, signal, taskId } = {},
) {
  assert.equal(treeIdentity(plan.initial), plan.initialIdentity);
  assert.equal(typeof createDrivers, "function");
  assert.equal(typeof inspect, "function");
  const tasks = taskId === undefined ? plan.tasks : plan.tasks.filter(({ id }) => id === taskId);
  assert.ok(tasks.length > 0, "Unknown or empty isolated task selection");
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  await mkdir(path.join(output, "tasks"), { mode: 0o700 });
  const report = {
    version: "renderer-module-extraction-isolated-v1",
    kind: "diagnostic",
    runId: randomUUID(),
    status: "running",
    initial: plan.initialIdentity,
    integration: { status: "not-run", reason: "partial-extraction" },
    tasks: [],
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
  try {
    for (const [sequence, task] of tasks.entries()) {
      signal?.throwIfAborted();
      const directory = path.join(output, "tasks", String(sequence).padStart(3, "0"));
      await mkdir(directory, { mode: 0o700 });
      const workspace = path.join(directory, "workspace");
      const expected = extractCurrentFile(plan.initial, task);
      const isolated = { ...plan, tasks: [task], expected };
      const assess = await prepareExtractionStructure(isolated);
      await writeTree(workspace, plan.initial);
      let drivers;
      try {
        drivers = await createDrivers({ task, workspace, directory, signal });
        const wave = await runExtractionWave([task], { ...drivers, agents: 1, signal });
        assert.ok(wave.records.every(({ closed }) => closed));
        const state = await captureExtractionState(isolated, workspace, directory, { signal });
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
          workspace: path.relative(output, workspace),
          evidence: path.relative(output, path.dirname(state.candidate.source)),
          candidateIdentity: state.candidate.identity,
          participants: wave.records,
          deliveries: wave.deliveries,
          structure,
          extraction: state.extraction,
          inspection: "awaiting",
        };
        report.tasks.push(row);
        await save();
        const request = Object.freeze({
          runId: report.runId,
          sequence,
          stage: "isolated-original",
          round: sequence,
          ids: [task.id],
          candidateIdentity: state.candidate.identity,
          evidence: path.dirname(state.candidate.source),
          report: path.join(output, "report.json"),
          signal,
        });
        const approval = await inspect(request);
        assert.equal(approval?.runId, report.runId);
        assert.equal(approval.sequence, sequence);
        assert.equal(approval.candidateIdentity, state.candidate.identity);
        await assertCandidateUnchanged(workspace, state.candidate, { signal });
        row.inspection = "approved";
        await save();
      } finally {
        try {
          if (drivers) await drivers.cleanup();
        } finally {
          releaseCandidateWorkspace(workspace);
        }
      }
    }
    report.status = "complete";
    report.passed = report.tasks.every(({ structure }) => structure.status === "pass");
    return report;
  } catch (error) {
    report.status = "interrupted";
    report.failure = { name: error.name, code: error.code ?? null, message: error.message };
    throw error;
  } finally {
    report.finished = new Date().toISOString();
    await save();
  }
}
