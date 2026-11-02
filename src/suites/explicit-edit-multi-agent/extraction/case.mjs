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
import {
  moduleExtractionPrompt,
  moduleRecoveryPrompt,
  moduleSymbolPrompt,
  moduleSymbolRecoveryPrompt,
  moduleExplicitPrompt,
} from "./prompt.mjs";
import { writeTree } from "../generation/generator.mjs";
import { runExtractionRecovery } from "./recovery.mjs";
import { EXTRACTION_RECOVERY_POLICY, extractionScore } from "./score.mjs";
import { validateExtractionDeliveries } from "./continuation.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const proofVersion = (manifest) =>
  manifest.scope !== "experimental-module-pairs"
    ? "renderer-module-extraction-proof-v1"
    : manifest.version === "renderer-module-extraction-v5"
      ? "renderer-module-extraction-proof-v7"
      : manifest.version === "renderer-module-extraction-v4"
        ? "renderer-module-extraction-proof-v6"
        : manifest.version === "renderer-module-extraction-v3"
          ? "renderer-module-extraction-proof-v5"
          : "renderer-module-extraction-proof-v4";

/** Require an actual passed reference report bound to the exact clean runner. */
export function validateExtractionProof(manifest, proof, report, sourceIdentity) {
  const paired = manifest.scope === "experimental-module-pairs";
  assert.equal(proof.version, proofVersion(manifest));
  assert.equal(proof.kind, "scripted-reference");
  assert.equal(proof.status, "pass");
  assert.equal(proof.planSha256, manifest.planSha256);
  assert.equal(sourceIdentity.sourceClean, true);
  assert.deepEqual(proof.sourceIdentity, sourceIdentity);
  assert.equal(report.status, "complete");
  assert.equal(report.initial, manifest.initial);
  if (paired) {
    assert.ok(
      [
        "renderer-module-extraction-v2",
        "renderer-module-extraction-v3",
        "renderer-module-extraction-v4",
        "renderer-module-extraction-v5",
      ].includes(manifest.version),
    );
    if (
      [
        "renderer-module-extraction-v3",
        "renderer-module-extraction-v4",
        "renderer-module-extraction-v5",
      ].includes(manifest.version)
    ) {
      assert.equal(manifest.headerProtection, "pragma-once");
      assert.equal(proof.headerProtection, manifest.headerProtection);
      assert.equal(report.headerProtection, manifest.headerProtection);
    }
    if (manifest.version === "renderer-module-extraction-v4") {
      assert.equal(manifest.assignmentContract, "symbol-inventory-v1");
      assert.equal(proof.assignmentContract, manifest.assignmentContract);
    }
    if (manifest.version === "renderer-module-extraction-v5") {
      assert.equal(manifest.assignmentContract, "explicit-inventory-v2");
      assert.equal(proof.assignmentContract, manifest.assignmentContract);
    }
    assert.equal(report.version, "renderer-module-extraction-run-v4");
    assert.equal(report.scope, manifest.scope);
    assert.equal(proof.scope, manifest.scope);
    assert.ok(
      Number.isSafeInteger(manifest.agents) && manifest.agents >= 1 && manifest.agents <= 10,
    );
    assert.equal(report.agents, manifest.agents);
    assert.equal(proof.agents, manifest.agents);
    assert.deepEqual(report.files, manifest.files);
    assert.deepEqual(proof.files, manifest.files);
    assert.deepEqual(proof.policy, EXTRACTION_RECOVERY_POLICY);
    assert.deepEqual(report.policy, EXTRACTION_RECOVERY_POLICY);
    assert.equal(report.passed, true);
    assert.ok(!report.continuation);
    assert.equal(report.stages.length, 1);
    assert.equal(report.stages[0].stage, "original");
    assert.deepEqual(report.stages[0].differenceIds, []);
    assert.deepEqual(report.stages[0].integration, report.integration);
    assert.deepEqual(report.stages[0].structure, report.structure);
    assert.equal(report.structure.version, "renderer-module-extraction-structure-v1");
    assert.equal(report.structure.status, "pass");
    assert.deepEqual(report.structure.differenceIds, []);
    assert.deepEqual(
      report.structure.files.map(({ id, file }) => ({ id, file })),
      manifest.files,
    );
    assert.ok(
      report.structure.files.every(
        ({ targetMatched, sourceMatched }) => targetMatched === true && sourceMatched === true,
      ),
    );
    for (const key of ["mainMatched", "inventoryMatched", "unrelatedMatched"])
      assert.equal(report.structure[key], true);
    assert.equal(report.waves.length, 1);
    assert.equal(report.waves[0].stage, "original");
    assert.equal(report.waves[0].agents, manifest.agents);
    assert.equal(report.waves[0].status, "complete");
    assert.deepEqual(
      report.waves[0].ids,
      manifest.files.map(({ id }) => id),
    );
    assert.equal(report.score.score, 100);
    assert.deepEqual(
      report.score,
      extractionScore({ totalFiles: manifest.files.length, stages: report.stages }),
    );
    assert.deepEqual(report.first.score, report.score);
    assert.ok(report.participants.every(({ stage }) => stage === "original"));
    assert.ok(report.deliveries.every(({ stage }) => stage === "original"));
    validateExtractionDeliveries(manifest.files, manifest.agents, report);
    assert.deepEqual(report.repairs, []);
    assert.deepEqual(report.recoveryChecks, []);
    assert.equal(report.barriers.length, 1);
    const [barrier] = report.barriers;
    assert.equal(barrier.stage, "original");
    assert.equal(barrier.participants.length, manifest.agents);
    assert.equal(new Set(barrier.participants.map(({ agent }) => agent)).size, manifest.agents);
    for (const held of barrier.participants) {
      const original = report.participants.find(({ agent }) => agent === held.agent);
      assert.ok(original);
      assert.equal(held.session, original.session);
      assert.ok(held.participant && original.participant);
      for (const key of ["sessionId", "lifetime"])
        if (original.participant[key] !== undefined)
          assert.equal(held.participant[key], original.participant[key]);
    }
    assert.equal(report.first.stage, "original");
    assert.deepEqual(report.first.structure, report.structure);
    assert.deepEqual(report.first.integration, report.integration);
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
  const paired = manifest.scope === "experimental-module-pairs";
  const run = paired ? runExtractionRecovery : runExtraction;
  const report = await run(plan, output, {
    signal,
    expectedPixels: manifest.pixels,
    createDriver: (_agent, _session, { signal }) =>
      extractionReference(path.join(output, "workspace"), tools, { signal }),
    execute: (driver, task) => driver.execute(task),
  });
  assert.deepEqual(await restoringSourceIdentity(), sourceIdentity);
  const bytes = await readFile(path.join(output, "report.json"));
  const proof = {
    version: proofVersion(manifest),
    ...(manifest.headerProtection ? { headerProtection: manifest.headerProtection } : {}),
    ...(manifest.assignmentContract ? { assignmentContract: manifest.assignmentContract } : {}),
    ...(manifest.scope === "experimental-module-pairs"
      ? {
          scope: manifest.scope,
          agents: manifest.agents,
          files: manifest.files,
          policy: EXTRACTION_RECOVERY_POLICY,
        }
      : {}),
    kind: "scripted-reference",
    status:
      report.extraction.status === "pass" &&
      (!paired || (report.passed && report.score.score === 100 && report.stages.length === 1)) &&
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

// Historical symbol inventories do not identify every verifier-enforced obligation.
// Permit model execution only with the explicit versioned contract.
function requireCompletePublicContract(manifest) {
  if (
    manifest.version === "renderer-module-extraction-v5" &&
    manifest.assignmentContract === "explicit-inventory-v2"
  )
    return;
  throw Object.assign(
    new Error(
      "Model extraction requires a fresh explicit assignment contract; legacy inventories are incomplete",
    ),
    { code: "EXTRACTION_CONTRACT_INCOMPLETE" },
  );
}

/** Start model inference only through explicit configuration and a verified case.
 * Each participant receives its fixed queue as separate whole-file prompts,
 * inline or in complete read-only assignment files. No expected tree or grading contract is mounted.
 */
export async function runModelExtraction(
  prepared,
  outputPath,
  config,
  { proofPath, signal, fromRun, sourceReceipt, inspect } = {},
) {
  if (fromRun !== undefined || sourceReceipt !== undefined)
    throw Object.assign(
      new Error(
        "Recovery requires the original live participant contexts; closed saved runs cannot supply them",
      ),
      { code: "EXTRACTION_LIVE_CONTEXT_REQUIRED" },
    );
  const { manifest, plan, publicAssignments } = await loadExtraction(prepared);
  requireCompletePublicContract(manifest);
  assert.equal(manifest.scope, "experimental-module-pairs");
  assert.equal(
    manifest.version,
    "renderer-module-extraction-v5",
    "Prepare a fresh explicit-contract case before model execution",
  );
  assert.ok(publicAssignments instanceof Map);
  assert.equal(typeof proofPath, "string");
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  const reportBytes = await readFile(
    path.join(path.dirname(path.resolve(proofPath)), "report.json"),
  );
  assert.equal(hash(reportBytes), proof.runReportSha256);
  const sourceIdentity = await restoringSourceIdentity();
  validateExtractionProof(manifest, proof, JSON.parse(reportBytes), sourceIdentity);
  assert.equal(typeof inspect, "function", "Model extraction requires round inspection");
  const output = path.resolve(outputPath);
  const drivers = recoveryModelDrivers(output, config, {
    publicAssignments,
    stopOnProviderError: true,
  });
  try {
    const result = await runExtractionRecovery(plan, output, {
      inspect,
      ...drivers,
      signal,
      publicAssignments: new Map(
        [...publicAssignments].map(([id, assignment]) => [id, assignment.entities]),
      ),
      expectedPixels: manifest.pixels,
    });
    assert.deepEqual(await restoringSourceIdentity(), sourceIdentity);
    await writeFile(
      path.join(output, "execution.json"),
      JSON.stringify(
        {
          kind: "model",
          mode: "whole-file-extraction",
          sourceIdentity,
          planSha256: manifest.planSha256,
          policy: EXTRACTION_RECOVERY_POLICY,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return result;
  } finally {
    await drivers.cleanup();
  }
}

/** Structural recovery stays with its original live context; integration owns fresh participants. */
export function recoveryModelDrivers(
  outputPath,
  config,
  { publicAssignments, stopOnProviderError = false } = {},
) {
  const output = path.resolve(outputPath);
  const stages = new Map();
  const owners = new WeakMap();
  const stageDrivers = (stage) => {
    assert.ok(["original", "build-correction", "image-correction"].includes(stage));
    if (!stages.has(stage))
      stages.set(
        stage,
        modelExtractionDrivers(path.join(output, "stages", stage), config, {
          workspace: path.join(output, "workspace"),
          publicAssignments,
          stopOnProviderError,
        }),
      );
    return stages.get(stage);
  };
  return {
    usage: (driver) => finalizedUsage(driver.events),
    async createDriver(agent, session, context) {
      const drivers = stageDrivers(context.stage);
      const driver = await drivers.createDriver(agent, session, context);
      owners.set(driver, drivers);
      return driver;
    },
    execute(driver, task, context) {
      const drivers = owners.get(driver);
      assert.ok(drivers, "Participant has no owning native factory");
      return drivers.execute(driver, task, context);
    },
    async cleanup() {
      for (const drivers of stages.values()) await drivers.cleanup();
    },
  };
}

/** Native delivery plumbing, also exercised with a local no-cost provider.
 * The public model entry point validates its proof before constructing drivers.
 * Call cleanup only after the pool has closed every owned participant.
 */
export function modelExtractionDrivers(
  outputPath,
  config,
  { workspace, publicAssignments, stopOnProviderError = false } = {},
) {
  const output = path.resolve(outputPath);
  const project = workspace ?? path.join(output, "workspace");
  const participantConfig = { ...config };
  const symbolOnly = publicAssignments !== undefined;
  const assignmentFor = (task) => {
    if (!symbolOnly) return moduleExtractionPrompt(task);
    const spec = publicAssignments.get(task.id);
    assert.ok(spec, "Missing public symbol assignment");
    return Array.isArray(spec) ? moduleSymbolPrompt(task, spec) : moduleExplicitPrompt(task, spec);
  };
  delete participantConfig.cppCorrectionCommand;
  const feedback = new Map();
  const states = new Map();
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
      states.set(state, null);
      const driver = await startPiParticipant(project, state, participantConfig, {
        signal,
        feedbackDirectory: directory,
        eventsFile: state + "-events.jsonl",
        enforceProcessBoundary: true,
        disableAutoRetry: stopOnProviderError,
        onRecovery: stopOnProviderError
          ? (request) => {
              throw new Error(`Provider failure requires inspection: ${request.reason}`);
            }
          : (request) => recovery.wait(request),
        onProviderFailure: (error) => recovery.stop(error),
      });
      states.set(state, driver);
      return driver;
    },
    async execute(driver, task, { signal, session }) {
      const record = feedback.get(session);
      assert.ok(record);
      const number = ++record.deliveries;
      let assignment;
      if (task.recovery) {
        let directories;
        if (task.assignments) {
          const name = `delivery-${number}`;
          const directory = path.join(record.directory, name);
          await mkdir(directory, { mode: 0o700 });
          await mkdir(path.join(directory, "assignments"), { mode: 0o700 });
          for (const member of task.assignments) {
            assert.match(member.id, /^[a-z0-9-]+$/);
            await writeFile(
              path.join(directory, "assignments", member.id + ".txt"),
              assignmentFor(member),
              { flag: "wx", mode: 0o600 },
            );
          }
          if (!symbolOnly) await writeTree(path.join(directory, "initial"), task.initialSources);
          directories = {
            assignmentsDirectory: `/feedback/${name}/assignments`,
            initialDirectory: `/feedback/${name}/initial`,
          };
        }
        if (task.validationFile) {
          const file = path.basename(task.validationFile);
          assert.equal(task.validationFile, `/feedback/${file}`);
          await writeFile(path.join(record.directory, file), task.validation + "\n", {
            flag: "wx",
            mode: 0o600,
          });
        }
        assignment = symbolOnly
          ? moduleSymbolRecoveryPrompt(task, directories?.assignmentsDirectory)
          : moduleRecoveryPrompt(task, directories);
      } else assignment = assignmentFor(task);
      const file = number === 1 ? "module.txt" : `module-${number}.txt`;
      await writeFile(path.join(record.directory, file), assignment, {
        flag: "wx",
        mode: 0o600,
      });
      const prompt =
        Buffer.byteLength(assignment) <= 4096
          ? assignment
          : symbolOnly
            ? `Read /feedback/${file} completely. Complete that one whole-file assignment in the shared workspace and finish.`
            : `Read /feedback/${file} completely, including every source fragment. Complete that one whole-file assignment in the shared workspace and finish.`;
      await admitProviderDelivery(recovery, { signal });
      return driver.execute(prompt, { completion: "turn", signal });
    },
    async cleanup() {
      assert.ok(
        [...states.values()].every((driver) => driver?.closed === true),
        "Participant closure is unconfirmed; retain its private credential copies",
      );
      for (const state of states.keys()) {
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
