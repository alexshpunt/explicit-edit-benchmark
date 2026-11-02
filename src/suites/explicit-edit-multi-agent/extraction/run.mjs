import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeTree, treeIdentity } from "../generation/generator.mjs";
import {
  captureCandidate,
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../execution/candidate-evidence.mjs";
import { measureExtractionCandidate } from "../grading/coherent-build.mjs";
import { gradeExtraction, gradeHeaderExtraction } from "./plan.mjs";
import { runExtractionWave } from "./wave.mjs";

/** Run one wave, then freeze and inspect the candidate after confirmed closure.
 * Injected drivers are diagnostic plumbing, not evidence of real model inference.
 * There is no initial build, repair delivery, grading loop or source restoration.
 */
export async function runExtraction(
  plan,
  outputPath,
  {
    createDriver,
    execute,
    expectedPixels,
    signal,
    measure = measureExtractionCandidate,
    usage,
  } = {},
) {
  assert.equal(treeIdentity(plan.initial), plan.initialIdentity);
  assert.equal(typeof createDriver, "function");
  assert.equal(typeof execute, "function");
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const workspace = path.join(output, "workspace");
  await writeTree(workspace, plan.initial);
  const paired = [
    "renderer-module-extraction-plan-v2",
    "renderer-module-extraction-plan-v3",
  ].includes(plan.version);
  const agents = plan.agents ?? Math.min(plan.tasks.length, 10);
  const report = {
    version: paired ? "renderer-module-extraction-run-v2" : "renderer-module-extraction-run-v1",
    ...(plan.headerProtection ? { headerProtection: plan.headerProtection } : {}),
    status: "running",
    initial: plan.initialIdentity,
    modules: paired ? plan.modules : plan.tasks.map(({ id, file }) => ({ id, file })),
    ...(paired
      ? { scope: plan.scope, agents, files: plan.tasks.map(({ id, file }) => ({ id, file })) }
      : {}),
    started: new Date().toISOString(),
    participants: /** @type {Awaited<ReturnType<typeof runExtractionWave>>["records"]} */ ([]),
    deliveries: /** @type {Awaited<ReturnType<typeof runExtractionWave>>["deliveries"]} */ ([]),
    extraction: null,
    integration: null,
  };
  // Several participants can report readiness/closure together. Serialize the
  // private report writes without serializing their editing assignments.
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
  try {
    const wave = await runExtractionWave(plan.tasks, {
      signal,
      agents,
      createDriver,
      execute,
      ...(usage ? { usage } : {}),
      onParticipant(record) {
        report.participants.push(record);
        return save();
      },
      onClosed() {
        return save();
      },
    });
    report.participants = wave.records;
    report.deliveries = wave.deliveries;
    assert.ok(wave.records.every(({ closed }) => closed));
    signal?.throwIfAborted();
    const state = await captureExtractionState(plan, workspace, output, { signal });
    report.extraction = state.extraction;
    await save();
    report.integration = await measure(
      state.candidate.source,
      path.join(output, "integration"),
      state.candidate.tree,
      { expectedPixels, signal, completeInventory: true },
    );
    await assertCandidateUnchanged(workspace, state.candidate, { signal });
    report.status = "complete";
    return report;
  } catch (error) {
    if (error.roundPool) {
      report.participants = error.roundPool.records;
      report.deliveries = error.roundPool.deliveries;
    }
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

/** Capture complete physical evidence after every participant has closed.
 * The same preservation checks apply to original and correction boundaries.
 */
export async function captureExtractionState(plan, workspace, evidence, { signal } = {}) {
  const candidate = await captureCandidate(workspace, path.join(evidence, "candidate"), {
    signal,
    includeAllFiles: true,
  });
  const entries = candidate.manifest.entries;
  const completeTree = Object.fromEntries(
    entries
      .filter(({ type, path }) => type === "file" && path !== null)
      .map(({ path, pathBytes }) => {
        const bytes = candidate.contents.get(pathBytes);
        const text = bytes.toString("utf8");
        return [path, Buffer.from(text).equals(bytes) ? text : bytes];
      }),
  );
  const expectedInventory = new Map();
  for (const file of Object.keys(plan.expected)) {
    expectedInventory.set(file, "file");
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++)
      expectedInventory.set(parts.slice(0, index).join("/"), "directory");
  }
  const physicalInventoryMatched =
    entries.length === expectedInventory.size &&
    entries.every(({ path, type }) => expectedInventory.get(path) === type);
  const paired = [
    "renderer-module-extraction-plan-v2",
    "renderer-module-extraction-plan-v3",
  ].includes(plan.version);
  const checked = (paired ? gradeExtraction : gradeHeaderExtraction)(plan, completeTree);
  const extraction = {
    ...checked,
    inventoryMatched: checked.inventoryMatched && physicalInventoryMatched,
    invalidEntries: candidate.invalid,
  };
  if (candidate.invalid.length || !physicalInventoryMatched) extraction.status = "fail";
  await assertCandidateUnchanged(workspace, candidate, { signal });
  // Ordinary regular-file inventory is already charged by structural assessment.
  // Keep physical-only entries visible even when regular files also differ.
  const physicalDiagnostics = entries
    .filter(
      ({ path, type }) =>
        path === null || (type !== "file" && expectedInventory.get(path) !== type),
    )
    .map(({ path, pathBytes, type }) => ({
      id: "preservation:physical-inventory",
      file: path ?? "main.cpp",
      kind: "physical-inventory",
      pathBytes,
      type,
      expectedType: expectedInventory.get(path) ?? null,
    }));
  return { candidate, completeTree, extraction, physicalDiagnostics };
}
