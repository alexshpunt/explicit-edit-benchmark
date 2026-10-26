import assert from "node:assert/strict";
import { validateReferenceExecution } from "../src/suites/explicit-edit-multi-agent/reference/execution-proof.mjs";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { suiteVerifier } from "./run-multi-agent-batch.mjs";
import { validateAtomicIdentity } from "./normalized-team-protocol.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_POLICY,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_VERSION,
} from "../src/suites/explicit-edit-multi-agent/results.mjs";

/** Hash the bundled fixture as portable relative names and exact file bytes. */
export async function teamFixtureSources(root = process.cwd()) {
  const files = [];
  async function visit(directory, relative = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = relative + entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, name + "/");
      else {
        assert.ok(entry.isFile(), "Release fixtures must be regular files");
        files.push([
          name,
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ]);
      }
    }
  }
  await visit(path.join(root, "fixtures/explicit-edit-multi-agent"));
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

/** Read maintainer-owned evidence, never an observation supplied by a contributor.
 * A release refuses changed fixture or suite code until a new full reference proof
 * has been reviewed and recorded. This does not call models or publish results.
 */
export async function approvedTeamRelease(root = process.cwd()) {
  const evidenceFile = path.join(
    root,
    `policies/official-runs/multi-agent-v${MULTI_AGENT_VERSION}.json`,
  );
  const evidence = JSON.parse(
    await readFile(evidenceFile, "utf8").catch((cause) => {
      throw Error(
        "Cannot read a reviewed full reference proof for the current Multi-Agent version",
        {
          cause,
        },
      );
    }),
  );
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(
    evidence.release.runner.contract,
    MULTI_AGENT_PROTOCOL,
    "Reference protocol differs",
  );
  assert.equal(
    evidence.release.runPolicy.oracleRecoveries,
    MULTI_AGENT_POLICY.oracleRecoveries,
    "Reference correction budget differs",
  );
  validateAtomicIdentity(evidence.release.atomic);
  assert.deepEqual(
    evidence.reference.atomic,
    evidence.release.atomic,
    "Reference atomic identity differs",
  );
  assert.equal(
    evidence.reference.acceptedAtomicEdits,
    evidence.release.atomic.edits,
    "Reference atomic inventory is incomplete",
  );
  assert.match(evidence.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(evidence.reference.reportSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.reference.normalizedSha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.reference.status, "pass");
  validateReferenceExecution(evidence.reference, 15);
  assert.equal(
    evidence.reference.referenceSourceSha256,
    evidence.release.runner.verifierSha256,
    "Reference source identity differs",
  );
  assert.equal(evidence.reference.modelCalls, 0);
  assert.equal(evidence.reference.agents, 15);
  assert.equal(evidence.reference.acceptedTasks, 71);
  assert.equal(evidence.reference.acceptedRounds, 28);
  assert.equal(evidence.reference.repairs, 0);
  assert.equal(
    evidence.fixtureSourcesSha256,
    await teamFixtureSources(root),
    "Fixture changed since the approved reference proof",
  );
  assert.equal(
    evidence.release.runner.verifierSha256,
    await suiteVerifier(pathToFileURL(path.join(root, "src/suites/explicit-edit-multi-agent/"))),
    "Suite changed since the approved reference proof",
  );
  return { [MULTI_AGENT_BENCHMARK]: evidence.release };
}
