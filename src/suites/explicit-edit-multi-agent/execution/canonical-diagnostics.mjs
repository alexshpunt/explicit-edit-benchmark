import assert from "node:assert/strict";

function location(canonicalPath) {
  if (canonicalPath.startsWith("source/")) {
    const path = canonicalPath.slice("source/".length);
    return { canonicalPath, path, pathBytes: Buffer.from(path).toString("base64") };
  }
  assert.ok(canonicalPath.startsWith("bytes/"), "Unknown canonical entry namespace");
  const bytes = Buffer.from(canonicalPath.slice("bytes/".length), "base64url");
  return { canonicalPath, path: null, pathBytes: bytes.toString("base64") };
}

/** Each disagreement is a correction assignment, not a new scoring unit.
 * Canonical hunks describe the current round only. They are representation text,
 * never a patch to apply literally to the actual C++ source.
 */
export function canonicalCorrectionNodes(comparison) {
  return comparison.mismatches.map((mismatch, index) => {
    const data = {
      stage: "structural-correction",
      location: location(mismatch.file),
      mismatch,
      expected:
        mismatch.kind === "expected" ? comparison.expectedHunks[mismatch.expectedIndex] : null,
      actual: mismatch.actualIndices.map((item) => comparison.actualHunks[item]),
    };
    return {
      id: `canonical-repair-${index}`,
      dependencies: [],
      differenceIds: [mismatch.id],
      prompt: JSON.stringify(data),
    };
  });
}

/** Integration feedback uses located candidate diagnostics and requirements that
 * were already public. Expected pixel bytes and future reference source stay private.
 */
export function canonicalIntegrationNodes(stage, { diagnostics = [], requirements = [] } = {}) {
  assert.ok(
    ["build-correction", "image-correction"].includes(stage),
    "Invalid integration correction stage",
  );
  return [
    {
      id: stage,
      dependencies: [],
      prompt: JSON.stringify({ stage, diagnostics, requirements }),
    },
  ];
}

export function canonicalAssignmentPrompt(members) {
  assert.ok(Array.isArray(members) && members.length > 0, "An editing packet must contain work");
  return [
    "Work in the shared writable project. Inspect current files before each edit. Preserve concurrent changes made by other agents; do not assume earlier file contents remain unchanged. Complete only the assignments in this packet. Do not run project-wide builds or lint commands. Address native IDE diagnostics only when they concern your assigned edits.",
    "For structural-correction data, use the supplied canonical hunks to locate and resolve the stated disagreement in actual source. Preserve literal contents and unrelated code. Do not apply canonical JSON as a source patch. For an unexpected physical entry, restore the required absence or entry type. Decode location.pathBytes as base64 when location.path is null.",
    "For a build-correction or image-correction assignment, resolve the reported integration failure while preserving already-correct structure and the supplied public requirements. The controller verifies the complete project after the editing wave; do not modify tests or verification infrastructure.",
    ...members.map(({ prompt }) => prompt),
  ].join("\n\n---\n\n");
}
