import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyOfficialDelivery,
  closeAcceptedOfficialCandidate,
  officialTransportMetadata,
  submitOfficialCandidate,
  waitForOfficialAcceptance,
  withDeliveryRetry,
} from "../../scripts/official-delivery.mjs";

async function evidence() {
  const root = await mkdtemp(path.join(tmpdir(), "official-delivery-"));
  const artifact = path.join(root, "official-result.tar.gz");
  const attestation = path.join(root, "attestation.jsonl");
  const manifest = path.join(root, "official-manifest.json");
  await writeFile(artifact, "signed bytes");
  await writeFile(attestation, "attestation bytes\n");
  await writeFile(
    manifest,
    JSON.stringify({
      executionIdentity: {
        executionId: "a".repeat(64),
        repository: "owner/caller",
        runId: "42",
        producerAttempt: 1,
        invocation: "benchmark",
      },
    }),
  );
  return { root, artifact, attestation, manifest };
}

test("temporary delivery failures back off and become explicit deferred state", async () => {
  const delays = [];
  const outcome = await withDeliveryRetry(
    async () => {
      throw Object.assign(Error("maintenance"), { statusCode: 503 });
    },
    { attempts: 3, baseDelayMs: 10, sleep: async (delay) => delays.push(delay) },
  );
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(outcome, {
    status: "deferred",
    attempt: 3,
    reason: "temporary-http-503",
  });
});

test("authentication and validation failures fail immediately", async () => {
  let attempts = 0;
  await assert.rejects(
    withDeliveryRetry(async () => {
      attempts += 1;
      throw Object.assign(Error("forbidden"), { statusCode: 403 });
    }),
    /forbidden/,
  );
  assert.equal(attempts, 1);
});

test("retry uploads the same bytes and keeps execution identity", async () => {
  const files = await evidence();
  const uploads = [];
  const hub = {
    whoAmI: async () => ({ name: "submitter" }),
    uploadFiles: async (request) => {
      uploads.push(
        await Promise.all(
          request.files.map(async (file) => ({
            path: file.path,
            content: await file.content.text(),
          })),
        ),
      );
      if (uploads.length === 1) throw Object.assign(Error("busy"), { statusCode: 429 });
      return {
        pullRequestUrl: "https://hf.example/datasets/owner/dataset/discussions/17",
        commit: { oid: "c".repeat(40) },
      };
    },
  };
  const statusFile = path.join(files.root, "delivery-status.json");
  const status = await submitOfficialCandidate({
    ...files,
    signerWorkflowSha: "b".repeat(40),
    repository: "owner/dataset",
    accessToken: "token",
    statusFile,
    hub,
    retry: { attempts: 2, baseDelayMs: 0, sleep: async () => {} },
    findExisting: async () => null,
  });
  assert.equal(status.status, "delivered");
  assert.equal(status.attempts, 2);
  assert.equal(status.candidateNumber, 17);
  assert.equal(status.candidateCommit, "c".repeat(40));
  assert.deepEqual(uploads[0], uploads[1]);
  assert.equal(uploads[0].length, 3);
  assert(uploads[0].every((file) => file.path.includes("a".repeat(64))));
  assert.equal(JSON.parse(await readFile(statusFile, "utf8")).executionId, "a".repeat(64));
});

test("recovery waits for the exact acceptance receipt and closes with the contributor token", async () => {
  const status = {
    status: "delivered",
    executionId: "a".repeat(64),
    artifactSha256: "b".repeat(64),
    candidateNumber: 17,
    candidateCommit: "c".repeat(40),
    signerWorkflowSha: "d".repeat(40),
  };
  let polls = 0;
  const receipt = await waitForOfficialAcceptance({
    repository: "owner/dataset",
    delivery: status,
    accessToken: "contributor-token",
    attempts: 2,
    sleep: async () => {},
    fetchImpl: async () => {
      polls += 1;
      if (polls === 1) return { ok: false, status: 404 };
      return {
        ok: true,
        headers: new Headers({ "x-repo-commit": "e".repeat(40) }),
        json: async () => ({
          schemaVersion: 1,
          executionId: status.executionId,
          artifactSha256: status.artifactSha256,
          candidateNumber: 17,
          candidateCommit: status.candidateCommit,
          signerWorkflowSha: status.signerWorkflowSha,
        }),
      };
    },
  });
  assert.equal(receipt.datasetCommit, "e".repeat(40));

  const requests = [];
  const closed = await closeAcceptedOfficialCandidate({
    repository: "owner/dataset",
    delivery: status,
    receipt,
    accessToken: "contributor-token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true };
    },
  });
  assert.equal(closed.status, "accepted");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /discussions\/17\/status$/);
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    status: "closed",
    comment: `Accepted verified execution ${status.executionId} in Dataset commit ${"e".repeat(40)}.`,
  });
});

test("recovery rejects a receipt for different candidate bytes", async () => {
  await assert.rejects(
    waitForOfficialAcceptance({
      repository: "owner/dataset",
      delivery: {
        status: "delivered",
        executionId: "a".repeat(64),
        artifactSha256: "b".repeat(64),
        candidateNumber: 17,
        candidateCommit: "c".repeat(40),
        signerWorkflowSha: "d".repeat(40),
      },
      accessToken: "token",
      attempts: 1,
      fetchImpl: async () => ({
        ok: true,
        headers: new Headers({ "x-repo-commit": "e".repeat(40) }),
        json: async () => ({
          executionId: "a".repeat(64),
          artifactSha256: "b".repeat(64),
          candidateNumber: 17,
          candidateCommit: "f".repeat(40),
          signerWorkflowSha: "d".repeat(40),
        }),
      }),
    }),
    /candidate commit/i,
  );
});

test("delivery identity distinguishes no-op duplicates from conflicts", () => {
  const existing = [{ executionId: "execution", artifactSha256: "digest" }];
  assert.equal(
    classifyOfficialDelivery(existing, { executionId: "other", artifactSha256: "digest" }),
    "new",
  );
  assert.equal(
    classifyOfficialDelivery(existing, { executionId: "execution", artifactSha256: "digest" }),
    "duplicate",
  );
  assert.equal(
    classifyOfficialDelivery(existing, { executionId: "execution", artifactSha256: "changed" }),
    "conflict",
  );
});

test("transport metadata is deterministic across submit attempts", async () => {
  const files = await evidence();
  const first = await officialTransportMetadata({
    ...files,
    signerWorkflowSha: "b".repeat(40),
  });
  const second = await officialTransportMetadata({
    ...files,
    signerWorkflowSha: "b".repeat(40),
  });
  assert.deepEqual(first, second);
});
