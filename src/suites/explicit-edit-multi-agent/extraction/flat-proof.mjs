import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { restoringSourceIdentity } from "../execution/restoring-identity.mjs";
import { writeTree } from "../generation/generator.mjs";
import { measureCoherentCandidate } from "../grading/coherent-build.mjs";
import { loadFlatCase } from "./flat-case.mjs";
import { flatPublicAssignments } from "./flat-assignments.mjs";
import { isolatedAnchors } from "./isolated-anchors.mjs";
import { runIsolatedExtraction } from "./isolated.mjs";
import { runFlatSequential } from "./flat-sequential.mjs";
import { revalidateFlatHints } from "./flat-live-hints.mjs";
import { extractionReference, prepareExtractionReference } from "./reference.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateFlatProof(manifest, proof, report, sourceIdentity) {
  assert.equal(proof.version, "renderer-flat-reference-proof-v1");
  assert.equal(proof.status, "pass");
  assert.equal(proof.planSha256, manifest.planSha256);
  assert.equal(sourceIdentity.sourceClean, true);
  assert.deepEqual(proof.sourceIdentity, sourceIdentity);
  assert.equal(report.version, "renderer-flat-reference-report-v1");
  assert.equal(report.status, "pass");
  assert.equal(report.initial, manifest.initial);
  assert.equal(report.expected, manifest.expected);
  for (const result of [report.monolith, report.extracted]) {
    assert.equal(result.buildPassed, true);
    assert.equal(result.resultMatched, true);
    assert.deepEqual(result.pixels, manifest.pixels);
  }
  assert.deepEqual(
    report.tasks,
    manifest.files.map(({ id, file }) => ({ id, file, status: "pass" })),
  );
  assert.equal(report.shared.status, "complete");
  assert.equal(report.shared.passed, true);
  assert.equal(report.shared.agents, 10);
  const sharedOrder = Array.from({ length: 10 }, (_, agent) =>
    manifest.files.filter((_file, index) => index % 10 === agent),
  ).flat();
  assert.deepEqual(
    report.shared.rounds,
    sharedOrder.map(({ id, file }) => ({ id, file, status: "pass" })),
  );
}

/** Reference proof runs one scripted participant at a time and no model calls. */
export async function verifyFlatCase(preparedPath, outputPath, { signal } = {}) {
  const sourceIdentity = await restoringSourceIdentity();
  assert.equal(sourceIdentity.sourceClean, true, "Flat reference requires a clean runner");
  const { manifest, plan } = await loadFlatCase(preparedPath);
  const assignments = await flatPublicAssignments(plan);
  assert.equal(assignments.size, plan.tasks.length);
  const anchored = isolatedAnchors(plan);
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const initial = path.join(output, "monolith-source"),
    expected = path.join(output, "extracted-source");
  await writeTree(initial, plan.initial);
  await writeTree(expected, plan.expected);
  const options = { expectedPixels: manifest.pixels, completeInventory: true, signal };
  const monolith = await measureCoherentCandidate(
    initial,
    path.join(output, "monolith"),
    plan.initial,
    options,
  );
  assert.ok(monolith.buildPassed && monolith.resultMatched, "Monolith render did not match");
  const extracted = await measureCoherentCandidate(
    expected,
    path.join(output, "extracted"),
    plan.expected,
    options,
  );
  assert.ok(extracted.buildPassed && extracted.resultMatched, "Extracted render did not match");
  const tools = path.join(output, "reference-tools");
  await prepareExtractionReference(tools);
  const reference = await runIsolatedExtraction(anchored.plan, path.join(output, "reference"), {
    signal,
    async createDrivers({ workspace }) {
      return {
        createDriver: (_agent, _session, options) => extractionReference(workspace, tools, options),
        execute: (driver, task) => driver.execute(task),
        async cleanup() {},
      };
    },
    async inspect(request) {
      return {
        runId: request.runId,
        sequence: request.sequence,
        candidateIdentity: request.candidateIdentity,
      };
    },
  });
  assert.ok(
    reference.passed && reference.tasks.length === plan.tasks.length,
    "Reference tasks failed",
  );
  const sharedOutput = path.join(output, "shared-reference");
  const sharedWorkspace = path.join(sharedOutput, "workspace");
  const shared = await runFlatSequential(anchored.plan, sharedOutput, {
    agents: 10,
    signal,
    expectedPixels: manifest.pixels,
    createDriver: (_agent, _session, options) =>
      extractionReference(sharedWorkspace, tools, options),
    async execute(driver, task, context) {
      const assignment = assignments.get(task.id);
      assert.ok(assignment);
      const hints = [
        ...assignment.hints,
        ...(anchored.hints.has(task.id) ? [anchored.hints.get(task.id)] : []),
      ];
      await revalidateFlatHints(sharedWorkspace, task, hints, { signal: context.signal });
      return driver.execute(task);
    },
    async inspect(request) {
      return {
        runId: request.runId,
        sequence: request.sequence,
        candidateIdentity: request.candidateIdentity,
      };
    },
  });
  assert.ok(shared.status === "complete" && shared.passed, "Shared sequential reference failed");
  assert.deepEqual(await restoringSourceIdentity(), sourceIdentity);
  const report = {
    version: "renderer-flat-reference-report-v1",
    status: "pass",
    initial: manifest.initial,
    expected: manifest.expected,
    monolith,
    shared: {
      status: shared.status,
      passed: shared.passed,
      agents: shared.agents,
      rounds: shared.rounds.map((round) => ({
        id: round.id,
        file: round.file,
        status: round.structure.status,
      })),
    },
    extracted,
    tasks: reference.tasks.map((task) => ({
      id: task.id,
      file: task.file,
      status: task.structure.status,
    })),
  };
  const reportBytes = JSON.stringify(report, null, 2) + "\n";
  const proof = {
    version: "renderer-flat-reference-proof-v1",
    status: "pass",
    planSha256: manifest.planSha256,
    sourceIdentity,
    reportSha256: hash(reportBytes),
  };
  validateFlatProof(manifest, proof, report, sourceIdentity);
  await writeFile(path.join(output, "report.json"), reportBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(output, "verification.json"), JSON.stringify(proof, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return proof;
}

export async function loadFlatProof(manifest, proofPath) {
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  const bytes = await readFile(path.join(path.dirname(path.resolve(proofPath)), "report.json"));
  assert.equal(hash(bytes), proof.reportSha256);
  validateFlatProof(
    manifest,
    proof,
    JSON.parse(bytes.toString("utf8")),
    await restoringSourceIdentity(),
  );
  return proof;
}
