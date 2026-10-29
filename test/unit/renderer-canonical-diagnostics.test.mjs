import assert from "node:assert/strict";
import test from "node:test";
import { compareCanonicalSnapshots } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";
import {
  canonicalCorrectionNodes,
  canonicalIntegrationNodes,
  canonicalAssignmentPrompt,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";

const view = (files) => ({ version: "canonical-diagnostic-fixture-v1", files });

test("structural corrections carry each supplied mismatch and only its related canonical hunks", () => {
  const first = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
  const end = first.replace("line 1\n", "changed 1\n").replace("line 18\n", "changed 18\n");
  const checked = compareCanonicalSnapshots(
    view({ "source/main.cpp": first }),
    view({ "source/main.cpp": end }),
    view({ "source/main.cpp": first, "source/extra.bin": "extra\n" }),
  );
  const nodes = canonicalCorrectionNodes(checked);
  assert.equal(nodes.length, 3);
  assert.equal(new Set(nodes.map(({ id }) => id)).size, 3);
  assert.deepEqual(
    nodes.flatMap(({ differenceIds }) => differenceIds).sort(),
    [...checked.differenceIds].sort(),
  );
  for (const node of nodes) {
    assert.deepEqual(node.dependencies, []);
    const data = JSON.parse(node.prompt);
    assert.equal(data.mismatch.id, node.differenceIds[0]);
    assert.deepEqual(
      data.actual,
      data.mismatch.actualIndices.map((index) => checked.actualHunks[index]),
    );
    if (data.mismatch.kind === "expected")
      assert.deepEqual(data.expected, checked.expectedHunks[data.mismatch.expectedIndex]);
    else assert.equal(data.expected, null);
  }
});

test("encoded physical filenames remain lossless correction locations", () => {
  const bytes = Buffer.from([0x80, 0x2e, 0x68]);
  const key = `bytes/${bytes.toString("base64url")}`;
  const checked = compareCanonicalSnapshots(
    view({}),
    view({ "source/main.cpp": "required\n" }),
    view({ [key]: "unexpected\n" }),
  );
  const nodes = canonicalCorrectionNodes(checked);
  const encoded = nodes
    .map(({ prompt }) => JSON.parse(prompt))
    .find(({ location }) => location.canonicalPath === key);
  assert.equal(encoded.location.path, null);
  assert.equal(encoded.location.pathBytes, bytes.toString("base64"));
  const ordinary = nodes
    .map(({ prompt }) => JSON.parse(prompt))
    .find(({ location }) => location.path === "main.cpp");
  assert.equal(ordinary.location.pathBytes, Buffer.from("main.cpp").toString("base64"));
});

test("a successful comparison creates no structural repair assignment", () => {
  const checked = compareCanonicalSnapshots(
    view({}),
    view({ "source/main.cpp": "ok\n" }),
    view({ "source/main.cpp": "ok\n" }),
  );
  assert.deepEqual(canonicalCorrectionNodes(checked), []);
});

test("integration corrections retain candidate diagnostics and already-public requirements", () => {
  const diagnostics = [
    { file: "main.cpp", line: 7, severity: "error", message: "fixture diagnostic" },
  ];
  const requirements = [{ id: "public-task", prompt: "fixture requirement" }];
  for (const stage of ["build-correction", "image-correction"]) {
    const nodes = canonicalIntegrationNodes(stage, { diagnostics, requirements });
    assert.equal(nodes.length, 1);
    const data = JSON.parse(nodes[0].prompt);
    assert.equal(data.stage, stage);
    assert.deepEqual(data.diagnostics, diagnostics);
    assert.deepEqual(data.requirements, requirements);
    assert.deepEqual(nodes[0].dependencies, []);
  }
  assert.throws(() => canonicalIntegrationNodes("original", { diagnostics, requirements }));
});

test("assignment composition retains supplied task values without requiring their prose", () => {
  const prompt = canonicalAssignmentPrompt([
    { prompt: "first fixture value" },
    { prompt: "second fixture value" },
  ]);
  assert.ok(prompt.includes("first fixture value"));
  assert.ok(prompt.includes("second fixture value"));
  assert.throws(() => canonicalAssignmentPrompt([]));
});
