import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
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
    ...members.map(({ prompt }) => prompt),
  ].join("\n\n---\n\n");
}
