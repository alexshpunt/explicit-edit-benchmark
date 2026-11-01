import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { restoringSourceIdentity } from "../execution/restoring-identity.mjs";
import { startPiParticipant, finalizedUsage } from "../execution/pi-baseline.mjs";
import { admitProviderDelivery, createProviderRecovery } from "../execution/provider-recovery.mjs";
import { loadExtraction } from "./prepare.mjs";
import { runExtraction } from "./run.mjs";
import { prepareExtractionReference, extractionReference } from "./reference.mjs";
import { moduleExtractionPrompt } from "./prompt.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Require an actual passed reference report bound to the exact clean runner. */
export function validateExtractionProof(manifest, proof, report, sourceIdentity) {
  const paired = manifest.scope === "experimental-module-pairs";
  assert.equal(
    proof.version,
    paired ? "renderer-module-extraction-proof-v2" : "renderer-module-extraction-proof-v1",
  );
  assert.equal(proof.kind, "scripted-reference");
  assert.equal(proof.status, "pass");
  assert.equal(proof.planSha256, manifest.planSha256);
  assert.equal(sourceIdentity.sourceClean, true);
  assert.deepEqual(proof.sourceIdentity, sourceIdentity);
  assert.equal(report.status, "complete");
  assert.equal(report.initial, manifest.initial);
  if (paired) {
    assert.equal(manifest.version, "renderer-module-extraction-v2");
    assert.equal(report.version, "renderer-module-extraction-run-v2");
    assert.equal(report.scope, manifest.scope);
    assert.equal(proof.scope, manifest.scope);
    assert.ok(
      Number.isSafeInteger(manifest.agents) && manifest.agents >= 1 && manifest.agents <= 10,
    );
    assert.equal(report.agents, manifest.agents);
    assert.equal(proof.agents, manifest.agents);
    assert.deepEqual(report.files, manifest.files);
    assert.deepEqual(proof.files, manifest.files);
    assert.equal(report.participants.length, manifest.agents);
    assert.equal(report.deliveries.length, manifest.files.length);
    const byAgent = new Map(
      report.participants.map((participant) => [participant.agent, participant]),
    );
    assert.equal(byAgent.size, manifest.agents);
    const delivered = new Set();
    for (const delivery of report.deliveries) {
      assert.equal(delivery.status, "settled");
      assert.equal(delivery.ids.length, 1);
      const index = manifest.files.findIndex((file) => file.id === delivery.ids[0]);
      assert.ok(index >= 0 && !delivered.has(delivery.ids[0]));
      delivered.add(delivery.ids[0]);
      assert.equal(delivery.agent, index % manifest.agents);
      assert.ok(byAgent.has(delivery.agent));
      assert.equal(delivery.session, byAgent.get(delivery.agent).session);
    }
  } else {
    assert.equal(report.participants.length, manifest.modules.length);
    assert.equal(report.deliveries.length, manifest.modules.length);
  }
  assert.ok(report.participants.every(({ closed }) => closed));
  assert.equal(report.extraction.status, "pass");
  assert.equal(report.integration.buildPassed, true);
  assert.equal(report.integration.resultMatched, true);
  assert.deepEqual(report.integration.pixels, manifest.pixels);
}

/** Model-free feasibility proof. Development source can be tested but its dirty
 * identity cannot later authorize a paid run, even if this reference succeeds.
 */
export async function verifyExtraction(prepared, outputPath, { signal } = {}) {
  const { manifest, plan } = await loadExtraction(prepared);
  const sourceIdentity = await restoringSourceIdentity();
  const output = path.resolve(outputPath);
  const tools = output + "-reference-tools";
  await prepareExtractionReference(tools);
  const report = await runExtraction(plan, output, {
    signal,
    expectedPixels: manifest.pixels,
    createDriver: (_agent, _session, { signal }) =>
      extractionReference(path.join(output, "workspace"), tools, { signal }),
    execute: (driver, task) => driver.execute(task),
  });
  assert.deepEqual(await restoringSourceIdentity(), sourceIdentity);
  const bytes = await readFile(path.join(output, "report.json"));
  const proof = {
    version:
      manifest.scope === "experimental-module-pairs"
        ? "renderer-module-extraction-proof-v2"
        : "renderer-module-extraction-proof-v1",
    ...(manifest.scope === "experimental-module-pairs"
      ? { scope: manifest.scope, agents: manifest.agents, files: manifest.files }
      : {}),
    kind: "scripted-reference",
    status:
      report.extraction.status === "pass" &&
      report.integration.buildPassed &&
      report.integration.resultMatched
        ? "pass"
        : "fail",
    planSha256: manifest.planSha256,
    sourceIdentity,
    runReportSha256: hash(bytes),
  };
  await writeFile(path.join(output, "verification.json"), JSON.stringify(proof, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return proof;
}

/** Start model inference only through explicit configuration and a verified case.
 * Each participant receives its fixed queue as separate whole-file prompts,
 * inline or in complete read-only assignment files. No expected tree or grading contract is mounted.
 */
export async function runModelExtraction(prepared, outputPath, config, { proofPath, signal } = {}) {
  const { manifest, plan } = await loadExtraction(prepared);
  assert.equal(manifest.scope, "experimental-module-pairs");
  assert.equal(typeof proofPath, "string");
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  const reportBytes = await readFile(
    path.join(path.dirname(path.resolve(proofPath)), "report.json"),
  );
  assert.equal(hash(reportBytes), proof.runReportSha256);
  const sourceIdentity = await restoringSourceIdentity();
  validateExtractionProof(manifest, proof, JSON.parse(reportBytes), sourceIdentity);
  const output = path.resolve(outputPath);
  const drivers = modelExtractionDrivers(output, config);
  try {
    const result = await runExtraction(plan, output, {
      ...drivers,
      signal,
      expectedPixels: manifest.pixels,
    });
    assert.deepEqual(await restoringSourceIdentity(), sourceIdentity);
    await writeFile(
      path.join(output, "execution.json"),
      JSON.stringify({ kind: "model", sourceIdentity, planSha256: manifest.planSha256 }, null, 2) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
    return result;
  } finally {
    await drivers.cleanup();
  }
}

/** Native delivery plumbing, also exercised with a local no-cost provider.
 * The public model entry point validates its proof before constructing drivers.
 * Call cleanup only after the pool has closed every owned participant.
 */
export function modelExtractionDrivers(outputPath, config) {
  const output = path.resolve(outputPath);
  const participantConfig = { ...config };
  delete participantConfig.cppCorrectionCommand;
  const feedback = new Map();
  const states = new Set();
  const recovery = createProviderRecovery({
    onEvent: (event) =>
      appendFileSync(path.join(output, "provider-recovery.jsonl"), JSON.stringify(event) + "\n", {
        mode: 0o600,
      }),
  });
  return {
    usage: (driver) => finalizedUsage(driver.events),
    async createDriver(_agent, session, { signal }) {
      const directory = path.join(output, "feedback", `session-${session}`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mkdir(path.join(output, "participants"), { recursive: true, mode: 0o700 });
      feedback.set(session, { directory, deliveries: 0 });
      const state = path.join(output, "participants", `session-${session}`);
      states.add(state);
      return startPiParticipant(path.join(output, "workspace"), state, participantConfig, {
        signal,
        feedbackDirectory: directory,
        eventsFile: state + "-events.jsonl",
        enforceProcessBoundary: true,
        onRecovery: (request) => recovery.wait(request),
        onProviderFailure: (error) => recovery.stop(error),
      });
    },
    async execute(driver, task, { signal, session }) {
      const assignment = moduleExtractionPrompt(task);
      const record = feedback.get(session);
      assert.ok(record);
      const number = ++record.deliveries;
      const file = number === 1 ? "module.txt" : `module-${number}.txt`;
      await writeFile(path.join(record.directory, file), assignment, {
        flag: "wx",
        mode: 0o600,
      });
      const prompt =
        Buffer.byteLength(assignment) <= 4096
          ? assignment
          : `Read /feedback/${file} completely, including every source fragment. Complete that one whole-file assignment in the shared workspace and finish.`;
      await admitProviderDelivery(recovery, { signal });
      return driver.execute(prompt, { completion: "turn", signal });
    },
    async cleanup() {
      for (const state of states) {
        const directory = path.join(state, "pi");
        const entry = await lstat(directory).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!entry) continue;
        // A participant can write its private state. Never follow a replaced
        // directory symlink into the operator's original credential store.
        assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
        await Promise.all(
          ["auth.json", "models.json"].map((file) =>
            rm(path.join(directory, file), { force: true }),
          ),
        );
      }
    },
  };
}
