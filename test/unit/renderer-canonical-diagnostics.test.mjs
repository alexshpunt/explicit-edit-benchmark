import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch } from "diff";
import { compareCanonicalSnapshots } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";
import {
  canonicalCorrectionNodes,
  canonicalIntegrationNodes,
  canonicalAssignmentPrompt,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";

const view = (files) => ({ version: "canonical-diagnostic-fixture-v1", files });

function deltaText(hunks, file) {
  return hunks
    .filter((hunk) => hunk.file === file)
    .map(
      (hunk) =>
        [JSON.stringify(["hunk", hunk.oldStart, hunk.oldLines, hunk.newLines]), ...hunk.lines].join(
          "\n",
        ) + "\n",
    )
    .join("");
}

function assertFeedbackReconstructs(checked, nodes) {
  const files = new Set(checked.mismatches.map(({ file }) => file));
  assert.deepEqual(
    [...new Set(nodes.flatMap(({ differenceIds }) => differenceIds))].sort(),
    [...checked.differenceIds].sort(),
  );
  for (const file of files) {
    const feedback = nodes
      .map(({ prompt }) => JSON.parse(prompt))
      .filter(({ location }) => location.canonicalPath === file);
    assert.ok(feedback.length > 0);
    for (const item of feedback) {
      assert.equal(item.diff.version, "canonical-diff-of-diffs-v1");
      assert.equal(item.diff.direction, "actual-to-expected");
      assert.equal(item.diff.context, 3);
    }
    const patch = {
      oldFileName: file,
      newFileName: file,
      hunks: feedback.map(({ diff }) => diff.hunk),
    };
    assert.equal(
      applyPatch(deltaText(checked.actualHunks, file), patch),
      deltaText(checked.expectedHunks, file),
    );
  }
}

test("a nearly correct large addition receives only its actual-to-expected diff hunks", () => {
  const suffix = "_".repeat(80);
  const expected = Array.from(
    { length: 9000 },
    (_, index) => `int fixture_identifier_${index}${suffix} = ${index} ;\n`,
  ).join("");
  const actual = expected.replace("fixture_identifier_4500", "incorrect_identifier_4500");
  const checked = compareCanonicalSnapshots(
    view({}),
    view({ "source/large.h": expected }),
    view({ "source/large.h": actual }),
  );
  assert.equal(checked.mismatches.length, 1);
  assert.ok(JSON.stringify(checked.expectedHunks).length > 1000000);
  const nodes = canonicalCorrectionNodes(checked);
  assert.ok(Buffer.byteLength(canonicalAssignmentPrompt(nodes)) < 16384);
  assertFeedbackReconstructs(checked, nodes);
});

test("distant errors inside one original hunk become separate diff-of-diffs assignments", () => {
  const expected = Array.from({ length: 100 }, (_, index) => "declaration " + index + "\n").join(
    "",
  );
  const actual = expected
    .replace("declaration 10\n", "wrong 10\n")
    .replace("declaration 80\n", "wrong 80\n");
  const checked = compareCanonicalSnapshots(
    view({}),
    view({ "source/large.h": expected }),
    view({ "source/large.h": actual }),
  );
  assert.equal(checked.mismatches.length, 1);
  const nodes = canonicalCorrectionNodes(checked);
  assert.equal(nodes.length, 2);
  assertFeedbackReconstructs(checked, nodes);
});

test("feedback preserves complete missing changes rather than truncating a large absent file", () => {
  const expected = Array.from(
    { length: 12000 },
    (_, index) => "required content " + index + "\n",
  ).join("");
  const checked = compareCanonicalSnapshots(
    view({}),
    view({ "source/absent.h": expected }),
    view({}),
  );
  assertFeedbackReconstructs(checked, canonicalCorrectionNodes(checked));
});

test("merged actual hunks do not make feedback undo already correct changes", () => {
  const first = Array.from({ length: 60 }, (_, index) => "line " + index + "\n").join("");
  const expected = first
    .replace("line 10\n", "required 10\n")
    .replace("line 20\n", "required 20\n");
  const actual = expected.replace("line 15\n", "unexpected 15\n");
  const checked = compareCanonicalSnapshots(
    view({ "source/main.cpp": first }),
    view({ "source/main.cpp": expected }),
    view({ "source/main.cpp": actual }),
  );
  assert.equal(checked.actualHunks.length, 1);
  assert.equal(checked.expectedHunks.length, 2);
  assertFeedbackReconstructs(checked, canonicalCorrectionNodes(checked));
});

test("structural corrections cover every supplied mismatch with reconstructible diff-of-diffs hunks", () => {
  const first = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
  const end = first.replace("line 1\n", "changed 1\n").replace("line 18\n", "changed 18\n");
  const checked = compareCanonicalSnapshots(
    view({ "source/main.cpp": first }),
    view({ "source/main.cpp": end }),
    view({ "source/main.cpp": first, "source/extra.bin": "extra\n" }),
  );
  const nodes = canonicalCorrectionNodes(checked);
  assert.equal(nodes.length, 2);
  assert.equal(new Set(nodes.map(({ id }) => id)).size, 2);
  assertFeedbackReconstructs(checked, nodes);
  for (const node of nodes) {
    assert.deepEqual(node.dependencies, []);
    const data = JSON.parse(node.prompt);
    assert.deepEqual(
      data.mismatches.map(({ id }) => id),
      node.differenceIds,
    );
    assert.deepEqual(
      data.mismatches,
      checked.mismatches.filter(({ id }) => node.differenceIds.includes(id)),
    );
    assert.equal(Object.hasOwn(data, "expected"), false);
    assert.equal(Object.hasOwn(data, "actual"), false);
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
