import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch } from "diff";
import { compareCanonicalSnapshots } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";
import {
  canonicalAssignmentPrompt,
  canonicalCorrectionNodes,
  canonicalIntegrationNodes,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";

const view = (files) => ({ version: "feedback-fixture-v1", files });
function delta(hunks, file) {
  const lines = [];
  for (const hunk of hunks) {
    if (hunk.file !== file) continue;
    lines.push(
      JSON.stringify(["hunk", hunk.oldStart, hunk.oldLines, hunk.newLines]),
      ...hunk.lines,
    );
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}
function check(start, expected, actual) {
  const comparison = compareCanonicalSnapshots(view(start), view(expected), view(actual));
  const nodes = canonicalCorrectionNodes(comparison);
  for (const file of new Set(comparison.mismatches.map((item) => item.file))) {
    const pathBytes = file.startsWith("source/")
      ? Buffer.from(file.slice("source/".length))
      : Buffer.from(file.slice("bytes/".length), "base64url");
    const hunks = nodes
      .map(({ prompt }) => JSON.parse(prompt))
      .filter(({ location }) => location.pathBytes === pathBytes.toString("base64"))
      .map(({ hunk }) => hunk);
    assert.ok(hunks.length, file);
    assert.equal(
      applyPatch(delta(comparison.actualHunks, file), { hunks }),
      delta(comparison.expectedHunks, file),
    );
  }
  assert.equal(new Set(nodes.map(({ id }) => id)).size, nodes.length);
  assert.ok(nodes.every(({ dependencies }) => dependencies.length === 0));
  return { comparison, nodes };
}

test("separate disagreements are delivered as complete hunks of the two diffs", () => {
  const start = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
  const expected = start
    .replace("line 10\n", "expected 10\n")
    .replace("line 80\n", "expected 80\n");
  const actual = start.replace("line 10\n", "wrong 10\n");
  const { nodes } = check(
    { "source/main.cpp": start },
    { "source/main.cpp": expected },
    { "source/main.cpp": actual },
  );
  assert.ok(nodes.length > 0);
});

test("missing and unexpected files and byte filenames remain in the diffs", () => {
  const key = `bytes/${Buffer.from([0x80, 0x2e, 0x68]).toString("base64url")}`;
  const { nodes } = check({}, { "source/required.h": "int required;\n" }, { [key]: "extra\n" });
  assert.equal(nodes.length, 2);
  assert.ok(
    nodes.some(
      ({ prompt }) =>
        JSON.parse(prompt).location.pathBytes ===
        Buffer.from([0x80, 0x2e, 0x68]).toString("base64"),
    ),
  );
});

test("an exact endpoint needs no structural correction", () => {
  assert.deepEqual(check({}, { "source/a.h": "int a;\n" }, { "source/a.h": "int a;\n" }).nodes, []);
});

test("integration checks remain separate executable files", () => {
  for (const stage of ["build-correction", "image-correction"]) {
    const nodes = canonicalIntegrationNodes(stage, {
      expectedPixels: ["a".repeat(64), "b".repeat(64)],
    });
    assert.equal(nodes.length, 1);
    assert.ok(nodes[0].validation.length > 0);
    assert.ok(nodes[0].prompt.includes(nodes[0].validationFile));
    assert.equal(nodes[0].prompt.includes(nodes[0].validation), false);
    assert.deepEqual(nodes[0].dependencies, []);
  }
  assert.throws(() => canonicalIntegrationNodes("original", { expectedPixels: [] }));
  assert.throws(() => canonicalIntegrationNodes("image-correction", { expectedPixels: [] }));
  assert.throws(() => canonicalAssignmentPrompt([]));
});
