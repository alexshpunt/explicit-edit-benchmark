import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { validateOfficialManifest } from "./official-result.mjs";

const FILES = new Set([
  "official-manifest.json",
  "execution-plan.json",
  "installed-dependencies.json",
  "normalized/manifest.json",
  "normalized/profiles.jsonl",
  "normalized/configurations.jsonl",
  "normalized/trials.jsonl",
  "normalized/rounds.jsonl",
  "normalized/tool-calls.jsonl",
]);
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
const MAX_ATTESTATION_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_JSONL_ROWS = 100_000;
export class OfficialVerificationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "OfficialVerificationError";
    this.code = code;
  }
}

function reject(code, message, cause) {
  throw new OfficialVerificationError(code, message, cause ? { cause } : undefined);
}

/** Convert every verification failure into one stable machine-readable reason. */
export function officialRejectionCode(error) {
  if (error instanceof OfficialVerificationError) return error.code;
  if (error?.code === "invalid-signature") return "invalid-signature";
  const status = error?.statusCode ?? error?.status ?? error?.response?.status;
  if (
    status === 429 ||
    (Number.isInteger(status) && status >= 500) ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code)
  )
    return "temporarily-unavailable";
  const message = String(error?.message ?? error);
  if (/Revoked signer workflow SHA/.test(message)) return "revoked-workflow";
  if (/Unknown signer workflow SHA|signer SHA mismatch/.test(message)) return "wrong-signer";
  if (/attestation|signature|Sigstore|gh exited/i.test(message)) return "invalid-signature";
  if (/schema/i.test(message)) return "invalid-schema";
  if (/JSON|object|fields must be exactly|expected fields/i.test(message))
    return "invalid-envelope";
  if (/metric|token|tool-call|round|ordinal|nullable/i.test(message)) return "invalid-metrics";
  if (/retry|recover/i.test(message)) return "hidden-retries";
  if (/task|fixture|verifier|contract|policy|runner|configuration|identity/i.test(message))
    return "invalid-contract";
  return "invalid-envelope";
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject("invalid-envelope", `${label}: expected object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys))
    reject("invalid-envelope", `${label}: fields must be exactly ${keys.join(", ")}`);
}

function validateTransport(transport) {
  exactKeys(
    transport,
    [
      "schemaVersion",
      "executionId",
      "artifactSha256",
      "producer",
      "signerWorkflowSha",
      "submitter",
    ],
    "official transport",
  );
  exactKeys(
    transport.producer,
    ["repository", "runId", "producerAttempt", "invocation"],
    "official transport.producer",
  );
  if (
    transport.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(transport.executionId ?? "") ||
    !/^[a-f0-9]{64}$/.test(transport.artifactSha256 ?? "") ||
    !/^[a-f0-9]{40}$/.test(transport.signerWorkflowSha ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(transport.producer.repository ?? "") ||
    !/^\d+$/.test(String(transport.producer.runId)) ||
    !Number.isInteger(transport.producer.producerAttempt) ||
    transport.producer.producerAttempt < 1
  )
    reject("invalid-envelope", "official transport: invalid identity");
}

function tarText(block, offset, length) {
  return block
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");
}

function tarNumber(block, offset, length) {
  const value = tarText(block, offset, length).trim();
  if (!/^[0-7]*$/.test(value)) reject("invalid-archive", "official archive: invalid tar number");
  return value ? Number.parseInt(value, 8) : 0;
}

/** Extract the exact official public layout without allowing links or path traversal. */
export async function extractOfficialArchive(archive, outputDirectory) {
  const compressed = await readFile(path.resolve(archive));
  if (compressed.length > MAX_COMPRESSED_BYTES)
    reject("invalid-archive", "official archive: compressed limit");
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_EXTRACTED_BYTES });
  } catch (error) {
    reject("invalid-archive", "official archive: invalid or decompressed limit exceeded", error);
  }
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = tarNumber(header, 124, 12);
    const type = tarText(header, 156, 1) || "0";
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) reject("invalid-archive", "official archive: truncated entry");
    if (size > MAX_JSON_BYTES)
      reject("invalid-archive", `official archive: entry too large ${fullName}`);
    if (fullName.endsWith(".jsonl")) {
      const rows = tar.subarray(start, end).toString("utf8").split("\n").filter(Boolean).length;
      if (rows > MAX_JSONL_ROWS)
        reject("invalid-archive", `official archive: row limit exceeded ${fullName}`);
    }
    if (type === "5" && fullName === "normalized/" && size === 0) {
      offset = start;
      continue;
    }
    if (type !== "0")
      reject("invalid-archive", "official archive: every entry must be a regular file");
    if (!FILES.has(fullName) || path.posix.normalize(fullName) !== fullName)
      reject("invalid-layout", `official archive: invalid layout entry ${fullName}`);
    if (entries.has(fullName))
      reject("invalid-layout", `official archive: duplicate entry ${fullName}`);
    entries.set(fullName, tar.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (entries.size !== FILES.size || [...FILES].some((name) => !entries.has(name)))
    reject("invalid-layout", "official archive: incomplete public layout");
  const root = path.resolve(outputDirectory);
  for (const [name, content] of entries) {
    const destination = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: "wx" });
  }
  return { root, files: [...entries.keys()].sort() };
}

/** Verify the signed transport metadata and trusted manifest after attestation verification. */
export async function verifyOfficialCandidate({
  candidateDirectory,
  extractedDirectory,
  policyFile,
  signerSha,
  verifyAttestation,
}) {
  const root = path.resolve(candidateDirectory);
  const artifact = path.join(root, "official-result.tar.gz");
  const attestation = path.join(root, "attestation.jsonl");
  let transport;
  try {
    transport = JSON.parse(await readFile(path.join(root, "transport.json"), "utf8"));
  } catch (error) {
    reject("invalid-envelope", "official transport: invalid JSON", error);
  }
  validateTransport(transport);
  if ((await stat(attestation)).size > MAX_ATTESTATION_BYTES)
    reject("invalid-envelope", "official transport: attestation too large");
  const artifactSha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  if (transport.artifactSha256 !== artifactSha256)
    reject("invalid-digest", "official transport: artifact digest mismatch");
  if (transport.signerWorkflowSha !== signerSha)
    reject("wrong-signer", "official transport: signer SHA mismatch");
  await verifyAttestation({
    artifact,
    attestation,
    signerSha,
    repository: transport.producer.repository,
  });
  await extractOfficialArchive(artifact, extractedDirectory);
  const validated = await validateOfficialManifest(
    path.join(extractedDirectory, "official-manifest.json"),
    path.join(extractedDirectory, "normalized"),
    policyFile,
    signerSha,
  );
  if (validated.manifest.executionIdentity.executionId !== transport.executionId)
    reject("conflicting-identity", "official transport: execution identity mismatch");
  return { artifact, attestation, transport, artifactSha256, ...validated };
}

/** Public fail-closed verifier API used by CLI and automatic acceptance. */
export async function officialVerdict(options) {
  const {
    verifyCandidate = verifyOfficialCandidate,
    acceptedExecutions = [],
    ...verificationOptions
  } = options;
  try {
    const evidence = await verifyCandidate(verificationOptions);
    const prior = acceptedExecutions.find(
      (item) => item.executionId === evidence.transport.executionId,
    );
    if (prior)
      return prior.artifactSha256 === evidence.artifactSha256
        ? { status: "rejected", code: "duplicate" }
        : { status: "rejected", code: "conflicting-identity" };
    return { status: "accepted", code: "accepted", evidence };
  } catch (error) {
    const code = officialRejectionCode(error);
    return {
      status: code === "temporarily-unavailable" ? "deferred" : "rejected",
      code,
      message: String(error?.message ?? error),
    };
  }
}
