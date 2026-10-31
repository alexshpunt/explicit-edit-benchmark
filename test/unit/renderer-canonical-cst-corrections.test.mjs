import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  prepareCanonicalCstCorrections,
  cstCorrectionAssignments,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-cst-corrections.mjs";
import { compareCanonicalSnapshots } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";
import { canonicalAssignmentPrompt } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";

function trees(actual, expected) {
  const table = (text) => [
    [0, "translation_unit", JSON.stringify([null, text]), 0, Buffer.byteLength(text), -1, []],
  ];
  return {
    file: "unit.cpp",
    actual: Buffer.from(actual),
    expected: Buffer.from(expected),
    actualNodes: table(actual),
    expectedNodes: table(expected),
    mappings: [[0, 0]],
  };
}

test("CST corrections deliver complete source blocks instead of nested delta JSON", () => {
  const result = cstCorrectionAssignments(trees("int wrong;\n", "int required;\n"));
  assert.equal(result.nodes.length, 1);
  const node = result.nodes[0];
  assert.equal(node.kind, "cst-correction");
  assert.ok(node.prompt.includes("unit.cpp"));
  assert.ok(node.prompt.includes("int wrong;"));
  assert.ok(node.prompt.includes("int required;"));
  assert.throws(() => JSON.parse(node.prompt));
  assert.equal(canonicalAssignmentPrompt(result.nodes).includes("inner diff markers"), false);
  assert.ok(Buffer.byteLength(node.prompt) >= result.plan.hunks[0].payloadBytes);
});

test("separate gaps moving the same unchanged subtree stay in one assignment", () => {
  const actual = Buffer.from("int a;\nint b;\n"),
    expected = Buffer.from("int b;\nint a;\n");
  const rows = (a, b) => [
    [0, "translation_unit", "root", 0, 14, -1, [1, 2]],
    [1, "declaration", a, 0, 6, 0, []],
    [2, "declaration", b, 7, 6, 0, []],
  ];
  const result = cstCorrectionAssignments({
    file: "moves.cpp",
    actual,
    expected,
    actualNodes: rows("a", "b"),
    expectedNodes: rows("b", "a"),
    mappings: [
      [0, 0],
      [1, 2],
      [2, 1],
    ],
  });
  assert.ok(result.plan.hunks.length > 1);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].hunkIndexes.length, result.plan.hunks.length);
});

test("byte-equal raw sources require no correction assignment", () => {
  assert.deepEqual(cstCorrectionAssignments(trees("int a;\n", "int a;\n")).nodes, []);
});

test("literal whitespace and malformed residual source are not discarded", () => {
  const result = cstCorrectionAssignments(
    trees('auto x = "a b";\nint broken(\n', 'auto x = "a  b";\nint fixed;\n'),
  );
  assert.equal(result.nodes.length, 1);
  assert.ok(result.nodes[0].prompt.includes('"a  b"'));
  assert.ok(result.nodes[0].prompt.includes("int broken("));
});

test("instruction metadata distinguishes empty fragments and missing final newlines", () => {
  const without = cstCorrectionAssignments(trees("", "int x;"));
  const withLf = cstCorrectionAssignments(trees("", "int x;\n"));
  assert.notEqual(without.nodes[0].prompt, withLf.nodes[0].prompt);
  assert.match(without.nodes[0].prompt, /0 UTF-8 bytes; final LF: no/);
  assert.match(without.nodes[0].prompt, /6 UTF-8 bytes; final LF: no/);
  assert.match(withLf.nodes[0].prompt, /7 UTF-8 bytes; final LF: yes/);
});
test("missing files and non-C++ changes remain explicit fallback assignments", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cst-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const view = (files) => ({ version: "fixture", files });
  const comparison = compareCanonicalSnapshots(
    view({}),
    view({ "source/missing.cpp": "int needed;\n", "source/notes.txt": "needed\n" }),
    view({}),
  );
  const directory = path.join(root, "feedback");
  const nodes = await prepareCanonicalCstCorrections({
    comparison,
    startTree: {},
    expectedTree: { "missing.cpp": "int needed;\n", "notes.txt": "needed\n" },
    captured: { contents: new Map(), manifest: { entries: [] } },
    command: ["/must-not-be-invoked"],
    directory,
  });
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every(({ kind }) => kind !== "cst-correction"));
  const report = JSON.parse(await readFile(path.join(directory, "report.json")));
  assert.equal(report.controllerEdits, false);
  assert.equal(report.files.length, 2);
  assert.ok(report.files.every(({ backend }) => backend === "canonical-diff-of-diffs"));
});
