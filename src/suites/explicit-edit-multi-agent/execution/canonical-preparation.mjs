import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { treeIdentity } from "../generation/generator.mjs";
import { suiteVerifier } from "../source-identity.mjs";
import {
  CANONICAL_DIFF_POLICY,
  prepareCanonicalDiff,
  compareCanonicalDiff,
} from "../grading/canonical-diff.mjs";
import { CANONICAL_SCORE_POLICY } from "../grading/canonical-score.mjs";
import { canonicalizeTrustedProject } from "./canonical-candidate.mjs";
import { loadRestoringPreparation } from "./restoring-preparation.mjs";
import { validateRestoringProof } from "./restoring-proof.mjs";

export const CANONICAL_PREPARATION_VERSION = "renderer-canonical-preparation-v1";
export const CANONICAL_MULTI_AGENT_PROTOCOL = "shared-project-canonical-diff-v1";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inventory = (ids) => hash(JSON.stringify([...ids].sort()));
const jsonBytes = (value) => Buffer.from(JSON.stringify(value) + "\n");
const hashPattern = /^[a-f0-9]{64}$/;
const scopeFields = [
  "agents",
  "graphWidth",
  "workloadSha256",
  "graphSha256",
  "scheduleSha256",
  "contractHashes",
  "atomic",
  "initial",
  "expectedFinal",
  "totalTasks",
  "totalRounds",
  "totalAtoms",
  "atomicInventorySha256",
  "plannedAtoms",
  "roundEndpoints",
  "roundInventories",
];

function workloadScope(loaded) {
  const { manifest, schedule, atomicIntervals, atomicWorkload } = loaded;
  return {
    agents: loaded.agents,
    graphWidth: loaded.graph.width,
    workloadSha256: manifest.workloadSha256,
    graphSha256: manifest.graphSha256,
    scheduleSha256: loaded.scheduleSha256,
    contractHashes: loaded.contractHashes,
    atomic: manifest.atomic,
    initial: manifest.initial,
    expectedFinal: manifest.final,
    totalTasks: manifest.tasks,
    totalRounds: schedule.length,
    totalAtoms: atomicWorkload.nodes.length,
    atomicInventorySha256: inventory(atomicWorkload.nodes.map(({ id }) => id)),
    plannedAtoms: loaded.plannedAtoms,
    roundEndpoints: schedule.map(({ id }) => ({
      round: id,
      identity: treeIdentity(atomicIntervals.rounds.get(id).expectedTree),
    })),
    roundInventories: schedule.map(({ id }) => ({
      round: id,
      sha256: inventory(atomicIntervals.rounds.get(id).nodes.map((node) => node.id)),
    })),
  };
}

function authorize(proofBytes, scope) {
  assert.ok(Buffer.isBuffer(proofBytes), "Retained reference bytes are required");
  const proof = JSON.parse(proofBytes.toString("utf8"));
  validateRestoringProof(proof, proof.identity);
  for (const key of scopeFields) {
    assert.notEqual(proof.identity[key], undefined, "Retained reference scope is incomplete");
    assert.deepEqual(scope[key], proof.identity[key], "Retained reference workload differs");
  }
  return {
    kind: "retained-task-feasibility",
    proofSha256: hash(proofBytes),
    sourceCommit: proof.identity.sourceCommit,
    runnerSha256: proof.identity.runnerSha256,
    verifierSha256: proof.identity.verifierSha256,
    agents: proof.identity.agents,
    referenceConcurrency: structuredClone(proof.referenceConcurrency),
  };
}

function representation(snapshot) {
  return {
    canonicalVersion: snapshot.version,
    canonicalizer: snapshot.canonicalizer,
    inventory: snapshot.inventory,
  };
}

function snapshotView(snapshot) {
  return { version: snapshot.version, files: snapshot.files };
}

function validateSnapshot(snapshot, expectedRepresentation) {
  assert.ok(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot));
  const { sha256, ...payload } = snapshot;
  assert.match(sha256, hashPattern);
  assert.equal(hash(JSON.stringify(payload)), sha256, "Canonical snapshot digest differs");
  assert.deepEqual(
    representation(snapshot),
    expectedRepresentation,
    "Canonical representation differs",
  );
  assert.ok(snapshot.files && typeof snapshot.files === "object" && !Array.isArray(snapshot.files));
  assert.ok(Array.isArray(snapshot.errors));
  return snapshot;
}

async function saveArtifact(output, file, bytes, signal) {
  signal?.throwIfAborted();
  await writeFile(path.join(output, file), bytes, { flag: "wx", mode: 0o600 });
  return { file, sha256: hash(bytes) };
}

/** Read only a fixed artifact name from a real cache directory. */
async function artifactBytes(output, artifact, expectedFile, signal) {
  signal?.throwIfAborted();
  assert.deepEqual(Object.keys(artifact).sort(), ["file", "sha256"]);
  assert.equal(artifact.file, expectedFile, "Canonical artifact path differs");
  assert.match(artifact.sha256, hashPattern);
  const descriptor = await open(
    path.join(output, expectedFile),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    assert.ok(before.isFile(), "Canonical cache artifact must be a regular file");
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      assert.equal(after[key], before[key], "Canonical cache changed while reading");
    assert.equal(BigInt(bytes.length), before.size);
    assert.equal(hash(bytes), artifact.sha256, "Canonical artifact digest differs");
    signal?.throwIfAborted();
    return bytes;
  } finally {
    await descriptor.close();
  }
}

function artifactNames(index) {
  const prefix = `round-${String(index + 1).padStart(4, "0")}`;
  return { snapshot: `${prefix}.snapshot.json`, diff: `${prefix}.diff.json` };
}

/** Cache an already validated workload's trusted endpoints. The retained proof
 * is checked in full and binds every original round and source endpoint. No
 * participant process or new reference execution is created by this operation.
 */
export async function buildCanonicalCache(loaded, outputPath, { proofBytes, signal } = {}) {
  signal?.throwIfAborted();
  const scope = workloadScope(loaded);
  assert.equal(treeIdentity(loaded.initial), scope.initial, "Trusted initial source differs");
  const authorization = authorize(proofBytes, scope);
  const verifierSha256 = await suiteVerifier();
  const initial = await canonicalizeTrustedProject(loaded.initial);
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const referenceArtifact = await saveArtifact(output, "feasibility.json", proofBytes, signal);
  const initialArtifact = await saveArtifact(
    output,
    "initial.snapshot.json",
    jsonBytes(initial),
    signal,
  );
  const manifest = {
    version: CANONICAL_PREPARATION_VERSION,
    protocol: CANONICAL_MULTI_AGENT_PROTOCOL,
    verifierSha256,
    ...representation(initial),
    diffPolicy: CANONICAL_DIFF_POLICY,
    scorePolicy: CANONICAL_SCORE_POLICY,
    scope,
    feasibility: referenceArtifact,
    authorization,
    initial: { ...initialArtifact, identity: initial.sha256 },
    rounds: [],
  };
  let previous = initial;
  let previousSource = scope.initial;
  for (const [index, { id }] of loaded.schedule.entries()) {
    signal?.throwIfAborted();
    const tree = loaded.atomicIntervals.rounds.get(id).expectedTree;
    const expectedSnapshot = await canonicalizeTrustedProject(tree);
    let preparedDiff;
    try {
      preparedDiff = prepareCanonicalDiff(previous, expectedSnapshot);
    } catch (error) {
      if (error?.code === "CANONICAL_DIFF_EMPTY_REFERENCE") error.round = id;
      throw error;
    }
    const names = artifactNames(index);
    const snapshot = await saveArtifact(
      output,
      names.snapshot,
      jsonBytes(expectedSnapshot),
      signal,
    );
    const diff = await saveArtifact(output, names.diff, jsonBytes(preparedDiff), signal);
    manifest.rounds.push({
      round: id,
      startSourceIdentity: previousSource,
      endSourceIdentity: treeIdentity(tree),
      startCanonicalIdentity: previous.sha256,
      endCanonicalIdentity: expectedSnapshot.sha256,
      totalHunks: preparedDiff.totalHunks,
      snapshot,
      diff,
    });
    previous = expectedSnapshot;
    previousSource = treeIdentity(tree);
  }
  assert.equal(previousSource, scope.expectedFinal, "Trusted final source differs");
  signal?.throwIfAborted();
  assert.equal(
    await suiteVerifier(),
    verifierSha256,
    "Canonical verifier changed during preparation",
  );
  await saveArtifact(output, "manifest.json", jsonBytes(manifest), signal);
  return manifest;
}

/** Validate cached endpoints without reparsing their trusted C++ source. Each
 * stored diff is rechecked against its baseline and canonical endpoint. The
 * caller supplies the workload after its immutable preparation was validated.
 */
export async function readCanonicalCache(loaded, canonicalPath, { signal } = {}) {
  signal?.throwIfAborted();
  const output = path.resolve(canonicalPath);
  const directory = await lstat(output);
  assert.ok(
    directory.isDirectory() && !directory.isSymbolicLink(),
    "Unsafe canonical cache directory",
  );
  const manifestDescriptor = await open(
    path.join(output, "manifest.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let manifest;
  try {
    assert.ok(
      (await manifestDescriptor.stat()).isFile(),
      "Canonical manifest must be a regular file",
    );
    manifest = JSON.parse(await manifestDescriptor.readFile("utf8"));
  } finally {
    await manifestDescriptor.close();
  }
  assert.equal(manifest.version, CANONICAL_PREPARATION_VERSION);
  assert.equal(manifest.protocol, CANONICAL_MULTI_AGENT_PROTOCOL);
  assert.deepEqual(manifest.diffPolicy, CANONICAL_DIFF_POLICY, "Canonical diff policy differs");
  assert.deepEqual(manifest.scorePolicy, CANONICAL_SCORE_POLICY, "Canonical score policy differs");
  const verifierSha256 = await suiteVerifier();
  assert.equal(manifest.verifierSha256, verifierSha256, "Canonical verifier differs");
  const expectedRepresentation = representation(await canonicalizeTrustedProject({}));
  assert.deepEqual(
    {
      canonicalVersion: manifest.canonicalVersion,
      canonicalizer: manifest.canonicalizer,
      inventory: manifest.inventory,
    },
    expectedRepresentation,
    "Canonical parser or inventory policy differs",
  );
  const scope = workloadScope(loaded);
  assert.equal(treeIdentity(loaded.initial), scope.initial, "Trusted initial source differs");
  assert.deepEqual(manifest.scope, scope, "Canonical workload scope differs");
  const proofBytes = await artifactBytes(output, manifest.feasibility, "feasibility.json", signal);
  const authorization = authorize(proofBytes, scope);
  assert.deepEqual(manifest.authorization, authorization, "Canonical feasibility binding differs");
  const initialReference = { file: manifest.initial.file, sha256: manifest.initial.sha256 };
  const initial = validateSnapshot(
    JSON.parse(
      (await artifactBytes(output, initialReference, "initial.snapshot.json", signal)).toString(
        "utf8",
      ),
    ),
    expectedRepresentation,
  );
  assert.equal(initial.sha256, manifest.initial.identity);
  assert.ok(Array.isArray(manifest.rounds));
  assert.equal(manifest.rounds.length, loaded.schedule.length, "Canonical round coverage differs");
  const rounds = new Map();
  let previous = initial;
  let previousSource = scope.initial;
  for (const [index, { id }] of loaded.schedule.entries()) {
    signal?.throwIfAborted();
    const row = manifest.rounds[index];
    assert.equal(row.round, id, "Canonical round order differs");
    assert.equal(row.startSourceIdentity, previousSource, "Canonical source chain differs");
    assert.equal(
      row.endSourceIdentity,
      scope.roundEndpoints[index].identity,
      "Canonical source endpoint differs",
    );
    assert.equal(row.startCanonicalIdentity, previous.sha256, "Canonical baseline chain differs");
    const names = artifactNames(index);
    const expectedSnapshot = validateSnapshot(
      JSON.parse(
        (await artifactBytes(output, row.snapshot, names.snapshot, signal)).toString("utf8"),
      ),
      expectedRepresentation,
    );
    assert.equal(expectedSnapshot.sha256, row.endCanonicalIdentity);
    const preparedDiff = JSON.parse(
      (await artifactBytes(output, row.diff, names.diff, signal)).toString("utf8"),
    );
    assert.deepEqual(preparedDiff.start, snapshotView(previous), "Canonical diff baseline differs");
    assert.equal(preparedDiff.totalHunks, row.totalHunks);
    const comparison = compareCanonicalDiff(preparedDiff, expectedSnapshot);
    assert.equal(
      comparison.differenceIds.length,
      0,
      "Canonical endpoint differs from its cached reference",
    );
    // Reuse the validated previous snapshot's strings instead of retaining a
    // second deserialized copy of the entire baseline in every cached diff.
    preparedDiff.start = snapshotView(previous);
    rounds.set(id, { expectedSnapshot, preparedDiff });
    previous = expectedSnapshot;
    previousSource = row.endSourceIdentity;
  }
  assert.equal(previousSource, scope.expectedFinal, "Canonical final endpoint differs");
  assert.equal(await suiteVerifier(), verifierSha256, "Canonical verifier changed while loading");
  signal?.throwIfAborted();
  return { ...loaded, authorization, canonical: { manifest, initial, rounds } };
}

/** Prepare a new immutable cache from validated workload and retained reference
 * files. A retained proof certifies only its own recorded feasibility schedule.
 */
export async function prepareCanonical(
  preparationPath,
  outputPath,
  { agents, proofPath, signal } = {},
) {
  signal?.throwIfAborted();
  assert.ok(
    typeof proofPath === "string" && proofPath.length > 0,
    "A retained reference proof is required",
  );
  const loaded = await loadRestoringPreparation(preparationPath, { agents, roundCredit: false });
  signal?.throwIfAborted();
  const proofBytes = await readFile(proofPath);
  return buildCanonicalCache(loaded, outputPath, { proofBytes, signal });
}

/** Load the new protocol's cache through the complete immutable workload checks.
 * Legacy restoring execution retains its own default credit preparation path.
 */
export async function loadCanonicalPreparation(
  preparationPath,
  canonicalPath,
  { agents, signal } = {},
) {
  signal?.throwIfAborted();
  const loaded = await loadRestoringPreparation(preparationPath, { agents, roundCredit: false });
  return readCanonicalCache(loaded, canonicalPath, { signal });
}
