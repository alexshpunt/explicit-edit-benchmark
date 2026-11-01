import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  captureCandidate,
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../execution/candidate-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Validate settled, static whole-file ownership independently of source grading. */
export function validateExtractionDeliveries(files, agents, report) {
  assert.ok(Number.isSafeInteger(agents) && agents >= 1 && agents <= 10);
  assert.equal(report.participants.length, agents);
  assert.equal(report.deliveries.length, files.length);
  const byAgent = new Map(
    report.participants.map((participant) => [participant.agent, participant]),
  );
  assert.equal(byAgent.size, agents);
  assert.equal(new Set(report.participants.map(({ session }) => session)).size, agents);
  for (let agent = 0; agent < agents; agent++) {
    assert.ok(byAgent.has(agent));
    assert.equal(byAgent.get(agent).closed, true);
  }
  const delivered = new Set();
  for (const delivery of report.deliveries) {
    assert.equal(delivery.status, "settled");
    assert.equal(delivery.ids.length, 1);
    const index = files.findIndex((file) => file.id === delivery.ids[0]);
    assert.ok(index >= 0 && !delivered.has(delivery.ids[0]));
    delivered.add(delivery.ids[0]);
    assert.equal(delivery.agent, index % agents);
    assert.equal(delivery.session, byAgent.get(delivery.agent).session);
  }
}

/** Capture a separately pinned failed original. Never mutate or reseal its evidence. */
export async function loadExtractionContinuation(
  plan,
  sourceRun,
  evidence,
  { receipt, planSha256, signal } = {},
) {
  signal?.throwIfAborted();
  assert.equal(plan.scope, "experimental-module-pairs");
  assert.equal(receipt.version, "renderer-module-extraction-continuation-source-v1");
  assert.equal(receipt.planSha256, planSha256);
  assert.match(planSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.sourceIdentity.sourceClean, true);
  assert.match(receipt.sourceIdentity.sourceCommit, /^[a-f0-9]{40}$/);
  for (const name of ["verifierSha256", "runnerSha256"])
    assert.match(receipt.sourceIdentity[name], /^[a-f0-9]{64}$/);
  const source = path.resolve(sourceRun);
  const relative = path.relative(source, path.resolve(evidence));
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`));
  const [reportBytes, executionBytes, manifestBytes] = await Promise.all([
    readFile(path.join(source, "report.json")),
    readFile(path.join(source, "execution.json")),
    readFile(path.join(source, "candidate/manifest.json")),
  ]);
  assert.equal(hash(reportBytes), receipt.reportSha256);
  assert.equal(hash(executionBytes), receipt.executionSha256);
  assert.equal(hash(manifestBytes), receipt.candidateManifestSha256);
  const report = JSON.parse(reportBytes);
  const execution = JSON.parse(executionBytes);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(report.version, "renderer-module-extraction-run-v2");
  assert.equal(report.scope, plan.scope);
  assert.equal(report.status, "complete");
  assert.equal(report.initial, plan.initialIdentity);
  assert.deepEqual(report.modules, plan.modules);
  assert.equal(report.agents, plan.agents);
  assert.deepEqual(
    report.files,
    plan.tasks.map(({ id, file }) => ({ id, file })),
  );
  assert.ok(!report.continuation && !report.stages && !report.waves);
  validateExtractionDeliveries(report.files, plan.agents, report);
  assert.equal(execution.kind, "model");
  assert.equal(execution.planSha256, planSha256);
  assert.deepEqual(execution.sourceIdentity, receipt.sourceIdentity);
  assert.equal(manifest.version, "renderer-candidate-evidence-v1");
  assert.equal(manifest.identity, receipt.candidateIdentity);
  assert.equal(typeof report.integration.buildPassed, "boolean");
  assert.equal(typeof report.integration.resultMatched, "boolean");
  assert.ok(report.integration.buildPassed || !report.integration.resultMatched);
  assert.ok(
    report.extraction.status !== "pass" ||
      !report.integration.buildPassed ||
      !report.integration.resultMatched,
  );
  const workspace = path.join(source, "workspace");
  try {
    const candidate = await captureCandidate(workspace, evidence, {
      signal,
      includeAllFiles: true,
    });
    assert.equal(candidate.identity, receipt.candidateIdentity);
    assert.equal(candidate.invalid.length, 0);
    await assertCandidateUnchanged(workspace, candidate, { signal });
    const binding = {
      ...receipt,
      version: "renderer-module-extraction-continuation-binding-v1",
      sourceReportVersion: report.version,
    };
    await writeFile(path.join(evidence, "binding.json"), JSON.stringify(binding, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return {
      source: candidate.source,
      binding,
      integration: structuredClone(report.integration),
      integrationEvidence: path.join(source, "integration"),
    };
  } finally {
    releaseCandidateWorkspace(workspace);
  }
}
