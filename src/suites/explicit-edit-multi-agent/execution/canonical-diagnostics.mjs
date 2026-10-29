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

/** Supply only the failed stage and a command to reproduce its verification. */
export function canonicalIntegrationNodes(stage, { expectedPixels } = {}) {
  assert.ok(
    ["build-correction", "image-correction"].includes(stage),
    "Invalid integration correction stage",
  );
  const build = `set -euo pipefail
export LC_ALL=C
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
/usr/bin/find -P . \\( -type f -o -type l \\) -name '*.cpp' -print0 | /usr/bin/sort -z > "$scratch/translation-units"
mapfile -d '' -t sources < "$scratch/translation-units"
for source in "\${sources[@]}"; do
  if [[ ! -f "$source" ]]; then
    printf '%s: translation unit is not a regular file\\n' "$source" >&2
    exit 1
  fi
done
/usr/bin/clang++ -std=c++17 -O0 -ffp-contract=off -pthread -I "$PWD/support" "\${sources[@]}" -o "$scratch/renderer"`;
  let validation = build;
  if (stage === "image-correction") {
    assert.ok(
      Array.isArray(expectedPixels) &&
        expectedPixels.length === 2 &&
        expectedPixels.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)),
      "Two expected scene pixel hashes are required",
    );
    validation += `
"$scratch/renderer" "$scratch/scene"
"$scratch/renderer" "$scratch/repeat"
/usr/bin/python3 - "$scratch" ${expectedPixels.join(" ")} <<'PY'
import hashlib, math, pathlib, struct, sys
root = pathlib.Path(sys.argv[1])
expected = sys.argv[2:]
for scene in range(2):
    first_path = root / f"scene-{scene}.rgba32f"
    repeat_path = root / f"repeat-{scene}.rgba32f"
    if any(path.is_symlink() or not path.is_file() for path in (first_path, repeat_path)):
        sys.exit(f"scene {scene}: missing or unsafe output")
    first = first_path.read_bytes()
    repeat = repeat_path.read_bytes()
    if len(first) != 32 * 32 * 4 * 4 or first != repeat:
        sys.exit(f"scene {scene}: invalid size or nondeterministic output")
    pixels = struct.unpack('<4096f', first)
    if not all(math.isfinite(value) for value in pixels) or len(set(value for i, value in enumerate(pixels) if i % 4 != 3)) < 2:
        sys.exit(f"scene {scene}: invalid pixel values")
    if hashlib.sha256(first).hexdigest() != expected[scene]:
        sys.exit(f"scene {scene}: pixels differ")
PY`;
  }
  return [{ id: stage, dependencies: [], prompt: JSON.stringify({ stage, validation }) }];
}

export function canonicalAssignmentPrompt(members) {
  assert.ok(Array.isArray(members) && members.length > 0, "An editing packet must contain work");
  if (members.every(({ id }) => ["build-correction", "image-correction"].includes(id))) {
    return [
      "Work in the shared project. Preserve changes made by other agents. The integration check failed. Run the validation command with Bash from the project root, then diagnose and fix the failure.",
      ...members.map(({ prompt }) => prompt),
    ].join("\n\n---\n\n");
  }
  return [
    "Work in the shared writable project. Inspect current files before each edit. Preserve concurrent changes made by other agents; do not assume earlier file contents remain unchanged. Complete only the assignments in this packet. Do not run project-wide builds or lint commands. Address native IDE diagnostics only when they concern your assigned edits.",
    "For structural-correction data, resolve the supplied actual-to-expected diff-of-diffs hunk in actual source. Read the outer minus/plus markers as differences between actual and expected changes; read the inner minus/plus markers as changes from the trusted round start. Treat diff.hunk line numbers as positions in serialized change text, not C++ source lines. Read any hunk header record as baseline-range metadata. Locate the source by its physical path and nearby canonical C++ code. Preserve literal contents, already-correct edits and unrelated code. Do not apply this representation as a C++ patch. For an unexpected physical entry, restore the required absence or entry type. Decode location.pathBytes as base64 when location.path is null.",
    ...members.map(({ prompt }) => prompt),
  ].join("\n\n---\n\n");
}
