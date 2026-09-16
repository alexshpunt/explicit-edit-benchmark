import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createGzip } from "node:zlib";
import {
  OfficialVerificationError,
  extractOfficialArchive,
  officialRejectionCode,
  officialVerdict,
  verifyOfficialCandidate,
} from "../../scripts/official-verifier.mjs";

const SIGNER = "a".repeat(40);
const EXECUTION = "b".repeat(64);
const LAYOUT = [
  "official-manifest.json",
  "execution-plan.json",
  "installed-dependencies.json",
  "normalized/manifest.json",
  "normalized/profiles.jsonl",
  "normalized/configurations.jsonl",
  "normalized/trials.jsonl",
  "normalized/rounds.jsonl",
  "normalized/tool-calls.jsonl",
];

function header(name, size, type = "0") {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

async function archive(file, entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    chunks.push(header(entry.name, content.length, entry.type), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  await pipeline(
    Readable.from(Buffer.concat(chunks)),
    createGzip(),
    await import("node:fs").then((module) => module.createWriteStream(file)),
  );
}

function layout() {
  return [
    { name: "normalized/", type: "5" },
    ...LAYOUT.map((name) => ({ name, content: name.endsWith(".json") ? "{}" : "" })),
  ];
}

async function reason(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expected);
    return true;
  });
}

test("official extraction accepts only the signed public layout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "official-archive-"));
  try {
    const file = path.join(root, "result.tar.gz");
    await archive(file, layout());
    const output = path.join(root, "out");
    await extractOfficialArchive(file, output);
    assert.equal(await readFile(path.join(output, "official-manifest.json"), "utf8"), "{}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official extraction returns exact reasons for hostile archives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "official-archive-"));
  try {
    /** @type {Array<[string, Array<{name: string, type?: string, content?: string}>, string]>} */
    const cases = [
      ["traversal", [{ name: "../escape" }], "invalid-layout"],
      ["absolute", [{ name: "/escape" }], "invalid-layout"],
      ["symlink", [{ name: LAYOUT[0], type: "2" }], "invalid-archive"],
      ["hardlink", [{ name: LAYOUT[0], type: "1" }], "invalid-archive"],
      ["device", [{ name: LAYOUT[0], type: "3" }], "invalid-archive"],
      ["extra", [...layout(), { name: "extra.json" }], "invalid-layout"],
      ["duplicate", [...layout(), { name: LAYOUT[0] }], "invalid-layout"],
      ["missing", layout().filter((entry) => entry.name !== LAYOUT[0]), "invalid-layout"],
    ];
    for (const [label, entries, code] of cases) {
      const name = label;
      const file = path.join(root, `${name}.tar.gz`);
      await archive(file, entries);
      await reason(extractOfficialArchive(file, path.join(root, `out-${name}`)), code);
    }
    const corrupt = path.join(root, "corrupt.tar.gz");
    await writeFile(corrupt, "not gzip");
    await reason(
      extractOfficialArchive(corrupt, path.join(root, "out-corrupt")),
      "invalid-archive",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transport rejects poisoned envelopes, changed bytes, wrong signers, and forged attestations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "official-transport-"));
  try {
    const candidate = path.join(root, "candidate");
    await import("node:fs/promises").then((module) => module.mkdir(candidate));
    const artifact = Buffer.from("signed bytes");
    await writeFile(path.join(candidate, "official-result.tar.gz"), artifact);
    await writeFile(path.join(candidate, "attestation.jsonl"), "{}\n");
    const transport = {
      schemaVersion: 1,
      executionId: EXECUTION,
      artifactSha256: createHash("sha256").update(artifact).digest("hex"),
      producer: {
        repository: "person/caller",
        runId: "123",
        producerAttempt: 1,
        invocation: "smoke",
      },
      signerWorkflowSha: SIGNER,
      submitter: "person",
    };
    const verify = (overrides = {}, signerSha = SIGNER, verifyAttestation = async () => {}) => {
      return verifyOfficialCandidate({
        candidateDirectory: candidate,
        extractedDirectory: path.join(root, "out"),
        policyFile: "unused.json",
        signerSha,
        verifyAttestation,
        ...overrides,
      });
    };

    await writeFile(path.join(candidate, "transport.json"), "{broken");
    await reason(verify(), "invalid-envelope");
    await writeFile(path.join(candidate, "transport.json"), JSON.stringify(transport));
    await writeFile(path.join(candidate, "official-result.tar.gz"), "changed bytes");
    await reason(verify(), "invalid-digest");
    await writeFile(path.join(candidate, "official-result.tar.gz"), artifact);
    await reason(verify({}, "c".repeat(40)), "wrong-signer");
    const forged = async () => {
      throw Error("gh attestation verify exited with 1: signer workflow mismatch");
    };
    const verdict = await officialVerdict({
      candidateDirectory: candidate,
      extractedDirectory: path.join(root, "out-forged"),
      policyFile: "unused.json",
      signerSha: SIGNER,
      verifyAttestation: forged,
    });
    assert.deepEqual(
      { status: verdict.status, code: verdict.code },
      { status: "rejected", code: "invalid-signature" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every verification rejection has a stable reason code", () => {
  const cases = [
    [new OfficialVerificationError("invalid-archive", "bad"), "invalid-archive"],
    [Error("Revoked signer workflow SHA"), "revoked-workflow"],
    [Error("Unknown signer workflow SHA"), "wrong-signer"],
    [Error("attestation signature invalid"), "invalid-signature"],
    [Error("unsupported schema"), "invalid-schema"],
    [Error("hidden retryFailures mismatch"), "hidden-retries"],
    [Error("nullable metric is malformed"), "invalid-metrics"],
    [Error("canonical fixture hash mismatch"), "invalid-contract"],
    [Object.assign(Error("GitHub unavailable"), { statusCode: 503 }), "temporarily-unavailable"],
  ];
  for (const [error, code] of cases) assert.equal(officialRejectionCode(error), code);
});

test("public verdict accepts complete low-score evidence and classifies replay, conflict, and outage", async () => {
  const evidence = {
    artifactSha256: "d".repeat(64),
    transport: { executionId: EXECUTION },
    trials: [{ exact: false, finalExact: false }],
  };
  const verifyCandidate = async () => evidence;
  const accepted = await officialVerdict({ verifyCandidate });
  assert.equal(accepted.code, "accepted");
  assert.equal(accepted.status, "accepted");
  const duplicate = await officialVerdict({
    verifyCandidate,
    acceptedExecutions: [{ executionId: EXECUTION, artifactSha256: evidence.artifactSha256 }],
  });
  assert.equal(duplicate.code, "duplicate");
  const conflict = await officialVerdict({
    verifyCandidate,
    acceptedExecutions: [{ executionId: EXECUTION, artifactSha256: "e".repeat(64) }],
  });
  assert.equal(conflict.code, "conflicting-identity");
  const outage = await officialVerdict({
    verifyCandidate: async () => {
      throw Object.assign(Error("service unavailable"), { statusCode: 503 });
    },
  });
  assert.deepEqual(
    { status: outage.status, code: outage.code },
    { status: "deferred", code: "temporarily-unavailable" },
  );
});
