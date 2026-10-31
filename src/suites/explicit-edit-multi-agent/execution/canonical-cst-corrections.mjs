import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeSourceBytes } from "../cpp/source-bytes.mjs";
import { canonicalCorrectionNodes } from "./canonical-diagnostics.mjs";
import { cstCorrectionHunks } from "./cst-correction-hunks.mjs";
import { prepareMergirafCorrection } from "./mergiraf-correction.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (bytes) => Buffer.isBuffer(bytes) && Buffer.from(bytes.toString()).equals(bytes);
function fragmentInfo(text) {
  return `${Buffer.byteLength(text)} UTF-8 bytes; final LF: ${text.endsWith("\n") ? "yes" : "no"}`;
}
function block(text) {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** Package related moves together; a source subtree must not vanish in another task. */
function groups(plan) {
  const parent = plan.hunks.map((_, id) => id);
  const root = (id) => {
    while (parent[id] !== id) id = parent[id];
    return id;
  };
  for (const label of Object.keys(plan.anchors)) {
    const marker = `@@UNCHANGED_CST[${label}]@@`;
    const indexes = plan.hunks.flatMap((hunk, id) =>
      hunk.actual.includes(marker) || hunk.expected.includes(marker) ? [id] : [],
    );
    for (const id of indexes.slice(1)) parent[root(id)] = root(indexes[0]);
  }
  const grouped = new Map();
  plan.hunks.forEach((hunk, id) => {
    const key = root(id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ hunk, index: id });
  });
  return [...grouped.values()];
}

function describeSubtrees(hunk) {
  return Object.entries(hunk.unchangedSubtrees)
    .map(([label, metadata]) => {
      const view = metadata.actual;
      return `${label}: ${view.kind}, original line ${view.line}; ${[...view.scopes, view.header].join(" / ")}`;
    })
    .join("\n");
}
function instruction(file, sourceHash, members) {
  const chunks = [
    `Edit ${JSON.stringify(file)}. Make only the source changes below. Inspect the current file before editing; preserve concurrent changes outside these blocks.`,
    `Use byte ranges and line hints only to locate the original snapshot (SHA-256 ${sourceHash}); do not apply stale offsets to the current file. Read all blocks before editing. Preserve the complete existing code represented by unchanged-subtree labels. Move that code when a label changes position. Each label and its single enclosing newline on each side form a placeholder, not source text; expand that entire placeholder to the existing subtree without adding newlines. Do not write labels into the source. Keep surrounding context unchanged.`,
  ];
  for (const { hunk, index } of members) {
    chunks.push(
      `Block ${index + 1}; original source bytes [${hunk.actualSourceBytes.join(", ")}).`,
    );
    if (hunk.contextBefore) chunks.push(`Locate after this context:\n${block(hunk.contextBefore)}`);
    chunks.push(
      `Find this current fragment (${fragmentInfo(hunk.actual)}; empty means an insertion):\n${block(hunk.actual)}`,
    );
    chunks.push(
      `Change it to this required fragment (${fragmentInfo(hunk.expected)}; empty means a deletion):\n${block(hunk.expected)}`,
    );
    if (hunk.contextAfter) chunks.push(`Locate before this context:\n${block(hunk.contextAfter)}`);
    const subtrees = describeSubtrees(hunk);
    if (subtrees)
      chunks.push(`Locate labelled existing subtrees using these original locations:\n${subtrees}`);
  }
  return chunks.join("\n\n");
}

/** Render task text, not a controller-applied source patch or physical-owner match. */
export function cstCorrectionAssignments(input) {
  const plan = cstCorrectionHunks(input);
  const sourceHash = hash(input.actual);
  const nodes = groups(plan).map((members, id) => ({
    id: `cst-repair-${hash(Buffer.from(input.file)).slice(0, 16)}-${id}`,
    kind: "cst-correction",
    dependencies: [],
    prompt: instruction(input.file, sourceHash, members),
    hunkIndexes: members.map(({ index }) => index),
  }));
  return { nodes, plan };
}

/** Analyze trusted B/E and a still-sealed A capture before any correction starts. */
export async function prepareCanonicalCstCorrections({
  comparison,
  startTree,
  expectedTree,
  captured,
  command,
  directory,
  signal,
}) {
  assert.ok(captured?.contents instanceof Map, "A sealed candidate is required");
  await mkdir(directory, { mode: 0o700 });
  const nodes = [],
    files = [],
    fallback = [];
  const mismatches = [...new Set(comparison.mismatches.map(({ file }) => file))].sort();
  for (const [id, file] of mismatches.entries()) {
    signal?.throwIfAborted();
    const name = file.startsWith("source/") ? file.slice(7) : null;
    const pathBytes = name === null ? null : encodeSourceBytes(name).toString("base64");
    const actual = pathBytes === null ? null : captured.contents.get(pathBytes);
    const entry = captured.manifest.entries.find((item) => item.pathBytes === pathBytes);
    const expected =
      name !== null && Object.hasOwn(expectedTree, name)
        ? encodeSourceBytes(expectedTree[name])
        : null;
    const base =
      name !== null && Object.hasOwn(startTree, name)
        ? encodeSourceBytes(startTree[name])
        : Buffer.alloc(0);
    if (
      !name ||
      !/\.(?:cpp|cc|cxx|h|hpp|hxx)$/.test(name) ||
      entry?.type !== "file" ||
      !utf8(actual) ||
      !utf8(expected) ||
      !utf8(base)
    ) {
      fallback.push(file);
      files.push({
        file,
        backend: "canonical-diff-of-diffs",
        reason: "non-C++-or-nonregular-or-absent-or-non-UTF8-endpoint",
      });
      continue;
    }
    const evidence = path.join(directory, `file-${id}`);
    const verified = await prepareMergirafCorrection({
      command,
      base,
      actual,
      expected,
      directory: evidence,
      signal,
    });
    const result = cstCorrectionAssignments({ file: name, actual, expected, ...verified });
    assert.ok(result.nodes.length, "Canonical disagreement produced no source correction");
    await writeFile(path.join(evidence, "plan.json"), JSON.stringify(result.plan) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(evidence, "assignments.json"), JSON.stringify(result.nodes) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    nodes.push(...result.nodes);
    files.push({
      file,
      backend: "mergiraf-cst",
      hunks: result.plan.hunks.length,
      assignments: result.nodes.length,
      instructionBytes: result.nodes.reduce((sum, node) => sum + Buffer.byteLength(node.prompt), 0),
      maximumInstructionBytes: Math.max(
        ...result.nodes.map((node) => Buffer.byteLength(node.prompt)),
      ),
    });
  }
  if (fallback.length)
    nodes.push(
      ...canonicalCorrectionNodes({
        ...comparison,
        mismatches: comparison.mismatches.filter(({ file }) => fallback.includes(file)),
      }),
    );
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify({ files, assignments: nodes.length, controllerEdits: false }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return nodes;
}
