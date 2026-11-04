import assert from "node:assert/strict";
import test from "node:test";
import { validateFlatProof } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-proof.mjs";

function fixture() {
  const manifest = {
    planSha256: "plan",
    initial: "initial",
    expected: "expected",
    pixels: ["a", "b"],
    files: [{ id: "one", file: "a.h" }],
  };
  const source = { sourceClean: true, sourceCommit: "commit" };
  const report = {
    version: "renderer-flat-reference-report-v1",
    status: "pass",
    initial: "initial",
    expected: "expected",
    monolith: { buildPassed: true, resultMatched: true, pixels: ["a", "b"] },
    extracted: { buildPassed: true, resultMatched: true, pixels: ["a", "b"] },
    tasks: [{ id: "one", file: "a.h", status: "pass" }],
  };
  report.shared = {
    status: "complete",
    passed: true,
    agents: 10,
    rounds: manifest.files.map(({ id, file }) => ({ id, file, status: "pass" })),
  };
  const proof = {
    version: "renderer-flat-reference-proof-v1",
    status: "pass",
    planSha256: "plan",
    sourceIdentity: source,
  };
  return { manifest, report, proof, source };
}

test("flat proof binds every reference task, both renders and clean runner identity", () => {
  const { manifest, report, proof, source } = fixture();
  assert.doesNotThrow(() => validateFlatProof(manifest, proof, report, source));
  assert.throws(() =>
    validateFlatProof(
      manifest,
      proof,
      { ...report, extracted: { ...report.extracted, pixels: ["wrong", "b"] } },
      source,
    ),
  );
  assert.throws(() => validateFlatProof(manifest, proof, { ...report, tasks: [] }, source));
  assert.throws(() =>
    validateFlatProof(
      manifest,
      proof,
      { ...report, shared: { ...report.shared, passed: false } },
      source,
    ),
  );
  assert.throws(() =>
    validateFlatProof(manifest, proof, report, { ...source, sourceClean: false }),
  );
});
