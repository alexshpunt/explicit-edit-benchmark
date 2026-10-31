import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { structuredPatch } from "diff";
import { CANONICAL_DIFF_POLICY } from "../grading/canonical-diff.mjs";

function location(file) {
  if (file.startsWith("source/")) {
    const path = file.slice("source/".length);
    return { path, pathBytes: Buffer.from(path).toString("base64") };
  }
  assert.ok(file.startsWith("bytes/"), "Unknown canonical entry namespace");
  return {
    path: null,
    pathBytes: Buffer.from(file.slice("bytes/".length), "base64url").toString("base64"),
  };
}

// Both diffs use the same start. Keep every hunk, including agreements, so the
// outer diff describes only what differs between the two complete deltas.
function deltaView(hunks, file) {
  const lines = [];
  for (const hunk of hunks) {
    if (hunk.file !== file) continue;
    lines.push(JSON.stringify(["hunk", hunk.oldStart, hunk.oldLines, hunk.newLines]));
    lines.push(...hunk.lines);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** Split the actual-to-reference diff of diffs into independent assignments. */
export function canonicalCorrectionNodes(comparison) {
  const nodes = [];
  const files = [...new Set(comparison.mismatches.map(({ file }) => file))].sort();
  for (const file of files) {
    const actual = deltaView(comparison.actualHunks, file);
    const expected = deltaView(comparison.expectedHunks, file);
    const patch = structuredPatch(file, file, actual, expected, undefined, undefined, {
      context: CANONICAL_DIFF_POLICY.context,
      ignoreWhitespace: false,
      stripTrailingCr: false,
    });
    const where = location(file);
    for (const hunk of patch.hunks) {
      const data = { location: where, hunk };
      nodes.push({
        id: `canonical-repair-${nodes.length}`,
        dependencies: [],
        prompt: JSON.stringify(data),
      });
    }
  }
  return nodes;
}

/** Prepare only this participant's text; the caller owns its private mounted directory. */
export async function prepareCanonicalFeedback(members, directory) {
  return Promise.all(
    members.map(async (member) => {
      if (member.validationFile) {
        await writeFile(
          path.join(directory, path.basename(member.validationFile)),
          member.validation + "\n",
          { flag: "wx", mode: 0o600 },
        );
      }
      if (Buffer.byteLength(member.prompt) <= 4096) return { ...member };
      const name = `${randomUUID()}.txt`;
      await writeFile(path.join(directory, name), member.prompt, { flag: "wx", mode: 0o600 });
      const feedbackFile = `/feedback/${name}`;
      return {
        ...member,
        feedbackFile,
        prompt: `Your editing assignment is in ${feedbackFile}. Read the complete text in sections as needed, then carry out those edits in the project. The assignment file is read-only; do not copy it into the project.`,
      };
    }),
  );
}
/** Keep executable validation inside the controller until assignment delivery. */
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
  const validationFile = `/feedback/${stage === "build-correction" ? "check-build.sh" : "check-images.sh"}`;
  return [
    {
      id: stage,
      dependencies: [],
      stage,
      validation,
      validationFile,
      prompt: `The ${stage === "build-correction" ? "build" : "rendered-image"} check failed. Run \`bash ${validationFile}\` from the project root. Diagnose and fix the cause using its output, then run the script again after your changes. The script is read-only; do not copy it into the project.`,
    },
  ];
}

export function canonicalAssignmentPrompt(members) {
  assert.ok(Array.isArray(members) && members.length > 0, "An editing packet must contain work");
  if (members.every(({ id }) => ["build-correction", "image-correction"].includes(id))) {
    return [
      "Work in the shared project. Preserve changes made by other agents. The integration check failed. Run the assigned validation script with Bash from the project root, then diagnose and fix the failure.",
      ...members.map(({ prompt }) => prompt),
    ].join("\n\n---\n\n");
  }
  return [
    "Work in the shared writable project. Inspect current files before each edit. Preserve concurrent changes made by other agents; do not assume earlier file contents remain unchanged. Complete only the assignments in this packet. Do not run project-wide builds or lint commands. Address native IDE diagnostics only when they concern your assigned edits.",
    ...(members.some(({ kind }) => kind !== "cst-correction")
      ? [
          "For JSON hunk assignments, compare the actual and reference changes from the same round start. Outer minus lines are actual changes and outer plus lines are reference changes; the inner diff markers describe changes from that start. Locate the affected code in the named project-relative file and make the actual changes match the reference. Hunk coordinates refer to the serialized diffs, not source line numbers. Do not apply the nested diff directly as a source patch. If location.path is null, decode location.pathBytes from base64 to identify the filename.",
        ]
      : []),
    ...members.map(({ prompt }) => prompt),
  ].join("\n\n---\n\n");
}
