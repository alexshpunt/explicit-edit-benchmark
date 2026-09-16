import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { officialRunMetadata } from "../../scripts/build-public-dataset.mjs";

await test("publishes factual official proof metadata without changing historical runs", async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), "public-provenance-"));
  const executionId = "a".repeat(64);
  const proof = path.join(store, "official", executionId);
  await mkdir(proof, { recursive: true });
  await writeFile(
    path.join(proof, "acceptance.json"),
    JSON.stringify({
      schemaVersion: 1,
      executionId,
      artifactSha256: "b".repeat(64),
      candidateNumber: 40,
      candidateCommit: "c".repeat(40),
      datasetParentCommit: "d".repeat(40),
      signerWorkflowSha: "e".repeat(40),
      policyId: "official-runs-v1",
    }),
  );
  await writeFile(
    path.join(proof, "transport.json"),
    JSON.stringify({
      schemaVersion: 1,
      executionId,
      producer: { repository: "person/caller", runId: "123", producerAttempt: 1 },
    }),
  );

  assert.deepEqual(await officialRunMetadata(store, "official-123-1"), {
    executionId,
    proofPath: `source/official/${executionId}`,
    artifactSha256: "b".repeat(64),
    workflow: {
      repository: "person/caller",
      runId: "123",
      attempt: 1,
      signerSha: "e".repeat(40),
    },
    policyId: "official-runs-v1",
    acceptedCandidateCommit: "c".repeat(40),
  });
  assert.equal(await officialRunMetadata(store, "historical-run"), null);
});
