import assert from "node:assert/strict";
import test from "node:test";
import { validateExtractionProof } from "../../src/suites/explicit-edit-multi-agent/extraction/case.mjs";

const source = {
  sourceCommit: "a".repeat(40),
  sourceClean: true,
  verifierSha256: "b".repeat(64),
  runnerSha256: "c".repeat(64),
};
const manifest = {
  initial: "d".repeat(64),
  planSha256: "e".repeat(64),
  modules: ["bad.h"],
  pixels: ["0".repeat(64), "1".repeat(64)],
};
const report = {
  status: "complete",
  initial: manifest.initial,
  participants: [{ closed: true }],
  deliveries: [{}],
  extraction: { status: "pass" },
  integration: { buildPassed: true, resultMatched: true, pixels: manifest.pixels },
};
const proof = {
  version: "renderer-module-extraction-proof-v1",
  kind: "scripted-reference",
  status: "pass",
  planSha256: manifest.planSha256,
  sourceIdentity: source,
};

test("only a passed reference with the same clean source and exact plan authorizes model execution", () => {
  assert.doesNotThrow(() => validateExtractionProof(manifest, proof, report, source));
  for (const mutation of [
    { ...proof, status: "fail" },
    { ...proof, kind: "diagnostic" },
    { ...proof, planSha256: "f".repeat(64) },
    { ...proof, sourceIdentity: { ...source, sourceCommit: "0".repeat(40) } },
  ])
    assert.throws(() => validateExtractionProof(manifest, mutation, report, source));
  assert.throws(() =>
    validateExtractionProof(manifest, proof, report, { ...source, sourceClean: false }),
  );
  assert.throws(() =>
    validateExtractionProof(
      manifest,
      proof,
      { ...report, participants: [{ closed: false }] },
      source,
    ),
  );
  assert.throws(() =>
    validateExtractionProof(
      manifest,
      proof,
      { ...report, integration: { buildPassed: false, resultMatched: false } },
      source,
    ),
  );
});
