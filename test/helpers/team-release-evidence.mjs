import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicIdentity } from "./atomic-identity.mjs";
import {
  REFERENCE_EXECUTION_POLICY,
  referenceFirstPass,
} from "../../src/suites/explicit-edit-multi-agent/reference/execution-proof.mjs";
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
  evidence.reference.referenceExecution = REFERENCE_EXECUTION_POLICY;
  const rounds = Array.from({ length: evidence.reference.acceptedRounds }, (_, index) => ({
    round: `fixture-round-${index + 1}`,
    attempt: 1,
    status: "accepted",
  }));
  const atoms = Array.from(
    { length: evidence.reference.acceptedAtomicEdits },
    (_, index) => `fixture-atom-${index + 1}`,
  );
  evidence.reference.referenceFirstPass = referenceFirstPass({
    repairs: 0,
    acceptedRounds: rounds.length,
    totalRounds: rounds.length,
    atomic: evidence.reference.atomic,
    atomicBarriers: rounds,
    checks: ["initial", ...rounds.map(({ round }) => round)].map((contractId) => ({
      contractId,
      status: "pass",
    })),
    executions: Array.from({ length: Math.ceil(atoms.length / 50) }, (_, index) => ({
      attempt: 1,
      status: "settled",
      atomicIds: atoms.slice(index * 50, (index + 1) * 50),
    })),
  });
  evidence.reference.referenceSourceSha256 = evidence.release.runner.verifierSha256;
  evidence.reference.referenceConcurrency = {
    executors: 15,
    maxWorking: 15,
    maxPlanning: 15,
    maxPublishing: 2,
    workIntervals: 11178,
    planningIntervals: 11178,
    publicationIntervals: 11178,
  };
  const file = path.join(root, `policies/official-runs/multi-agent-v${MULTI_AGENT_VERSION}.json`);
  await writeFile(file, JSON.stringify(evidence));
  return file;
}
