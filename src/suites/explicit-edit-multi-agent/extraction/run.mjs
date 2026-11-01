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
import { gradeHeaderExtraction } from "./plan.mjs";
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
  const report = {
    version: "renderer-module-extraction-run-v1",
    status: "running",
    initial: plan.initialIdentity,
    modules: plan.tasks.map(({ id, file }) => ({ id, file })),
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
    const candidate = await captureCandidate(workspace, path.join(output, "candidate"), {
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
          return [path, Buffer.from(text).equals(bytes) ? text : null];
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
    const extraction = gradeHeaderExtraction(plan, completeTree);
    report.extraction = {
      ...extraction,
      inventoryMatched: extraction.inventoryMatched && physicalInventoryMatched,
      invalidEntries: candidate.invalid,
    };
    if (candidate.invalid.length || !physicalInventoryMatched) report.extraction.status = "fail";
    await assertCandidateUnchanged(workspace, candidate, { signal });
    await save();
    report.integration = await measure(
      candidate.source,
      path.join(output, "integration"),
      candidate.tree,
      { expectedPixels, signal, completeInventory: true },
    );
    await assertCandidateUnchanged(workspace, candidate, { signal });
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
