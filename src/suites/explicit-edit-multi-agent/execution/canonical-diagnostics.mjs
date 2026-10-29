import assert from "node:assert/strict";
import { structuredPatch } from "diff";
import { CANONICAL_DIFF_POLICY } from "../grading/canonical-diff.mjs";

function location(canonicalPath) {
  if (canonicalPath.startsWith("source/")) {
    const path = canonicalPath.slice("source/".length);
    return { canonicalPath, path, pathBytes: Buffer.from(path).toString("base64") };
  }
  assert.ok(canonicalPath.startsWith("bytes/"), "Unknown canonical entry namespace");
  const bytes = Buffer.from(canonicalPath.slice("bytes/".length), "base64url");
  return { canonicalPath, path: null, pathBytes: bytes.toString("base64") };
}

/** Serialize complete file deltas, including agreements. Output positions and
 * controller IDs are not changes: both deltas use the same baseline coordinates.
 */
function deltaView(hunks, file) {
  const lines = [],
    spans = new Map();
  for (const hunk of hunks) {
    if (hunk.file !== file) continue;
    const start = lines.length;
    lines.push(JSON.stringify(["hunk", hunk.oldStart, hunk.oldLines, hunk.newLines]));
    for (const line of hunk.lines) lines.push(line);
    spans.set(hunk.index, { start, end: lines.length });
  }
  return { text: lines.length ? lines.join("\n") + "\n" : "", spans };
}

function intersects(span, start, count) {
  if (!span) return false;
  const offset = count === 0 ? start : start - 1;
  return count === 0
    ? span.start <= offset && offset <= span.end
    : span.start < offset + count && offset < span.end;
}

/** Assign ordinary hunks of the actual-to-expected delta comparison.
 * These are feedback units only; the original scoring disagreements retain their
 * identities. Never replay entire associated hunks or drop unchanged agreements
 * before taking this second diff: either would misdescribe a partial repair.
 */
export function canonicalCorrectionNodes(comparison) {
  const nodes = [],
    covered = new Set();
  const files = [...new Set(comparison.mismatches.map(({ file }) => file))].sort();
  for (const file of files) {
    const expected = deltaView(comparison.expectedHunks, file);
    const actual = deltaView(comparison.actualHunks, file);
    const mismatches = comparison.mismatches.filter((item) => item.file === file);
    const patch = structuredPatch(file, file, actual.text, expected.text, undefined, undefined, {
      context: CANONICAL_DIFF_POLICY.context,
      ignoreWhitespace: false,
      stripTrailingCr: false,
    });
    for (const hunk of patch.hunks) {
      const related = mismatches.filter(
        (item) =>
          (item.kind === "expected" &&
            intersects(expected.spans.get(item.expectedIndex), hunk.newStart, hunk.newLines)) ||
          item.actualIndices.some((index) =>
            intersects(actual.spans.get(index), hunk.oldStart, hunk.oldLines),
          ),
      );
      assert.ok(related.length, "A correction hunk must identify its scoring disagreement");
      const differenceIds = related.map(({ id }) => id);
      for (const id of differenceIds) covered.add(id);
      const data = {
        stage: "structural-correction",
        location: location(file),
        mismatches: related,
        diff: {
          version: "canonical-diff-of-diffs-v1",
          direction: "actual-to-expected",
          context: CANONICAL_DIFF_POLICY.context,
          hunk,
        },
      };
      nodes.push({
        id: `canonical-repair-${nodes.length}`,
        dependencies: [],
        differenceIds,
        prompt: JSON.stringify(data),
      });
    }
  }
  assert.deepEqual(
    [...covered].sort(),
    [...comparison.differenceIds].sort(),
    "Correction feedback must cover every supplied disagreement",
  );
  return nodes;
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
    "For structural-correction data, resolve the supplied actual-to-expected diff-of-diffs hunk in actual source. Read the outer minus/plus markers as differences between actual and expected changes; read the inner minus/plus markers as changes from the trusted round start. Treat diff.hunk line numbers as positions in serialized change text, not C++ source lines. Read any hunk header record as baseline-range metadata. Locate the source by its physical path and nearby canonical C++ code. Preserve literal contents, already-correct edits and unrelated code. Do not apply this representation as a C++ patch. For an unexpected physical entry, restore the required absence or entry type. Decode location.pathBytes as base64 when location.path is null.",
    "For a build-correction or image-correction assignment, resolve the reported integration failure while preserving already-correct structure and the supplied public requirements. The controller verifies the complete project after the editing wave; do not modify tests or verification infrastructure.",
    ...members.map(({ prompt }) => prompt),
  ].join("\n\n---\n\n");
}
