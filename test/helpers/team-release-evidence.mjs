import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicIdentity } from "./atomic-identity.mjs";
import { pathToFileURL } from "node:url";
import { teamFixtureSources } from "../../scripts/official-team-release.mjs";
import { suiteVerifier } from "../../scripts/run-multi-agent-batch.mjs";
import {
  MULTI_AGENT_POLICY,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_VERSION,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";

/** Seed controlled evidence for release-transaction tests, never a real approval.
 * The experimental record supplies canonical task identities only. Synthetic proof
 * hashes exercise validation and commits without claiming a new reference run.
 */
export async function seedTeamReleaseEvidence(root) {
  const evidence = JSON.parse(
    await readFile(path.join(root, "policies/official-runs/multi-agent-v1.json"), "utf8"),
  );
  evidence.sourceCommit = "a".repeat(40);
  evidence.reference.reportSha256 = "b".repeat(64);
  evidence.reference.normalizedSha256 = "c".repeat(64);
  evidence.fixtureSourcesSha256 = await teamFixtureSources(root);
  evidence.release.runner.contract = MULTI_AGENT_PROTOCOL;
  evidence.release.runner.verifierSha256 = await suiteVerifier(
    pathToFileURL(path.join(root, "src/suites/explicit-edit-multi-agent/")),
  );
  evidence.release.runPolicy.oracleRecoveries = MULTI_AGENT_POLICY.oracleRecoveries;
  evidence.release.atomic = atomicIdentity();
  evidence.reference.atomic = evidence.release.atomic;
  evidence.reference.acceptedAtomicEdits = evidence.release.atomic.edits;
  const file = path.join(root, `policies/official-runs/multi-agent-v${MULTI_AGENT_VERSION}.json`);
  await writeFile(file, JSON.stringify(evidence));
  return file;
}
