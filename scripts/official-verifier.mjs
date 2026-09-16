import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

function tarText(block, offset, length) {
  return block
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");
}

function tarNumber(block, offset, length) {
  const value = tarText(block, offset, length).trim();
  if (!/^[0-7]*$/.test(value)) throw Error("official archive: invalid tar number");
  return value ? Number.parseInt(value, 8) : 0;
}

/** Extract the exact official public layout without allowing links or path traversal. */
export async function extractOfficialArchive(archive, outputDirectory) {
  const compressed = await readFile(path.resolve(archive));
  if (compressed.length > MAX_COMPRESSED_BYTES) throw Error("official archive: compressed limit");
  const tar = gunzipSync(compressed, { maxOutputLength: MAX_EXTRACTED_BYTES });
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
    if (type !== "0") throw Error("official archive: every entry must be a regular file");
    if (!FILES.has(fullName) || path.posix.normalize(fullName) !== fullName)
      throw Error(`official archive: invalid layout entry ${fullName}`);
    if (entries.has(fullName)) throw Error(`official archive: duplicate entry ${fullName}`);
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw Error("official archive: truncated entry");
    entries.set(fullName, tar.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (entries.size !== FILES.size || [...FILES].some((name) => !entries.has(name)))
    throw Error("official archive: incomplete public layout");
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
  const transport = JSON.parse(await readFile(path.join(root, "transport.json"), "utf8"));
  const artifactSha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  if (transport.artifactSha256 !== artifactSha256)
    throw Error("official transport: artifact digest mismatch");
  if (transport.signerWorkflowSha !== signerSha)
    throw Error("official transport: signer SHA mismatch");
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
    throw Error("official transport: execution identity mismatch");
  return { artifact, attestation, transport, artifactSha256, ...validated };
}
