import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_DIFF_POLICY,
  canonicalProjectDiff,
  prepareCanonicalDiff,
  compareCanonicalDiff,
  compareCanonicalSnapshots,
} from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";

const snapshot = (files) => ({ version: "fixture-canonical-v1", files });
const source = Array.from({ length: 60 }, (_, index) => `record-${index}`).join("\n") + "\n";
function changed(...indices) {
  const lines = source.trimEnd().split("\n");
  for (const index of indices) lines[index] = `changed-${index}`;
  return lines.join("\n") + "\n";
}
function prepared(reference = changed(10, 45)) {
  return prepareCanonicalDiff(
    snapshot({ "item.cpp": source }),
    snapshot({ "item.cpp": reference }),
  );
}

test("canonical diff accepts the complete endpoint and denies an unchanged candidate every required hunk", () => {
  const reference = prepared();
  assert.equal(reference.totalHunks, 2);
  const exact = compareCanonicalDiff(reference, snapshot({ "item.cpp": changed(10, 45) }));
  assert.equal(exact.passedHunks, 2);
  assert.deepEqual(exact.differenceIds, []);
  const untouched = compareCanonicalDiff(reference, snapshot({ "item.cpp": source }));
  assert.equal(untouched.passedHunks, 0);
  assert.equal(untouched.mismatches.length, 2);
  assert.ok(
    untouched.mismatches.every((item) => item.kind === "expected" && item.status === "missing"),
  );
  assert.deepEqual(
    untouched.differenceIds,
    reference.expectedHunks.map((item) => item.id),
  );
});

test("a wrong replacement is one expected disagreement rather than a missing edit plus an extra edit", () => {
  const result = compareCanonicalDiff(
    prepared(changed(10)),
    snapshot({ "item.cpp": changed(10).replace("changed-10", "wrong-10") }),
  );
  assert.equal(result.totalHunks, 1);
  assert.equal(result.actualHunks.length, 1);
  assert.equal(result.passedHunks, 0);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].kind, "expected");
  assert.equal(result.mismatches[0].status, "wrong");
  assert.deepEqual(result.mismatches[0].actualIndices, [0]);
});

test("independent additions do not invalidate an exact later hunk merely by shifting its output line number", () => {
  const reference = prepared(changed(45));
  const lines = changed(45).trimEnd().split("\n");
  lines.splice(2, 0, "independent addition");
  const result = compareCanonicalDiff(reference, snapshot({ "item.cpp": lines.join("\n") + "\n" }));
  assert.equal(result.actualHunks.length, 2);
  assert.equal(result.passedHunks, 1);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].kind, "extra");
  const corresponding = result.actualHunks.find(
    (hunk) => hunk.oldStart === reference.expectedHunks[0].oldStart,
  );
  assert.notEqual(corresponding.newStart, reference.expectedHunks[0].newStart);
});

test("an unexpected hunk keeps its identity when its wrong contents change at the same baseline span", () => {
  const reference = prepared(changed(10));
  const first = compareCanonicalDiff(reference, snapshot({ "item.cpp": changed(10, 45) }));
  const second = compareCanonicalDiff(
    reference,
    snapshot({ "item.cpp": changed(10, 45).replace("changed-45", "another-wrong-value") }),
  );
  assert.equal(first.mismatches[0].kind, "extra");
  assert.deepEqual(first.differenceIds, second.differenceIds);
  assert.notDeepEqual(first.actualHunks.at(-1).lines, second.actualHunks.at(-1).lines);
});

test("the pinned context groups nearby changes and keeps distant changes as separate ordinary hunks", () => {
  assert.equal(CANONICAL_DIFF_POLICY.context, 3);
  assert.equal(prepared(changed(10, 11)).totalHunks, 1);
  assert.equal(prepared(changed(10, 45)).totalHunks, 2);
});

test("a candidate hunk spanning multiple reference hunks does not invent an independent extra hunk", () => {
  const reference = prepared(changed(10, 20));
  assert.equal(reference.totalHunks, 2);
  const result = compareCanonicalDiff(reference, snapshot({ "item.cpp": changed(10, 15, 20) }));
  assert.equal(result.actualHunks.length, 1);
  assert.equal(result.passedHunks, 0);
  assert.equal(result.mismatches.length, 2);
  assert.ok(result.mismatches.every((item) => item.kind === "expected" && item.status === "wrong"));
});

test("empty file creation and deletion remain observable even without source lines", () => {
  for (const [start, reference] of [
    [{}, { "empty.h": "" }],
    [{ "empty.h": "" }, {}],
  ]) {
    const expected = prepareCanonicalDiff(snapshot(start), snapshot(reference));
    assert.equal(expected.totalHunks, 1);
    assert.equal(compareCanonicalDiff(expected, snapshot(start)).mismatches.length, 1);
    assert.deepEqual(compareCanonicalDiff(expected, snapshot(reference)).differenceIds, []);
  }
  const reference = prepared(changed(10));
  const extra = compareCanonicalDiff(
    reference,
    snapshot({ "item.cpp": changed(10), "empty.h": "" }),
  );
  assert.equal(extra.passedHunks, 1);
  assert.equal(extra.mismatches.length, 1);
  assert.equal(extra.mismatches[0].file, "empty.h");
});

test("file deletions and additional files are compared against their own baseline paths", () => {
  const start = snapshot({ "remove.cpp": "remove\n", "keep.cpp": "before\n" });
  const reference = snapshot({ "keep.cpp": "after\n" });
  const result = compareCanonicalSnapshots(
    start,
    reference,
    snapshot({ "remove.cpp": "remove\n", "keep.cpp": "after\n", "extra.cpp": "new\n" }),
  );
  assert.equal(result.totalHunks, 2);
  assert.equal(result.passedHunks, 1);
  assert.deepEqual(
    result.mismatches.map((item) => [item.file, item.kind]),
    [
      ["extra.cpp", "extra"],
      ["remove.cpp", "expected"],
    ],
  );
});

test("preparation owns its baseline and emits deterministic file order and identities", () => {
  const start = snapshot({ "z.cpp": "zero\n", "a.cpp": "alpha\n" });
  const reference = snapshot({ "a.cpp": "new-alpha\n", "z.cpp": "new-zero\n" });
  const saved = structuredClone(start);
  const cached = prepareCanonicalDiff(start, reference);
  const reordered = prepareCanonicalDiff(
    snapshot({ "a.cpp": "alpha\n", "z.cpp": "zero\n" }),
    snapshot({ "z.cpp": "new-zero\n", "a.cpp": "new-alpha\n" }),
  );
  assert.equal(cached.startIdentity, reordered.startIdentity);
  assert.equal(cached.referenceIdentity, reordered.referenceIdentity);
  assert.deepEqual(cached.expectedHunks, reordered.expectedHunks);
  assert.deepEqual(
    cached.expectedHunks.map((item) => item.file),
    ["a.cpp", "z.cpp"],
  );
  start.files["z.cpp"] = "mutated baseline\n";
  assert.deepEqual(compareCanonicalDiff(cached, reference).differenceIds, []);
  assert.notDeepEqual(start, saved);
  assert.deepEqual(reference.files, { "a.cpp": "new-alpha\n", "z.cpp": "new-zero\n" });
});

test("patch line markers are retained and source newline metadata is deterministic", () => {
  const start = snapshot({ "item.cpp": "before" });
  const reference = snapshot({ "item.cpp": "after" });
  const result = compareCanonicalSnapshots(start, reference, reference);
  assert.ok(result.expectedHunks[0].lines.includes("\\ No newline at end of file"));
  assert.deepEqual(result.differenceIds, []);
  assert.equal(result.passedHunks, 1);
});

test("snapshot validation rejects unsafe paths, non-text files and incompatible canonical versions", () => {
  for (const file of [
    "/absolute.cpp",
    "../outside.cpp",
    "a/../outside.cpp",
    "a//b.cpp",
    "./a.cpp",
    "a\\b.cpp",
    "C:/file.cpp",
    "a\u0000.cpp",
    "a\n.cpp",
  ]) {
    assert.throws(() =>
      canonicalProjectDiff(snapshot({ [file]: "before\n" }), snapshot({ [file]: "after\n" })),
    );
  }
  for (const invalid of [
    null,
    [],
    {},
    { version: "fixture-canonical-v1", files: [] },
    snapshot({ "item.cpp": 1 }),
    snapshot({ "item.cpp": "bad\r\n" }),
  ]) {
    assert.throws(() => canonicalProjectDiff(invalid, snapshot({ "item.cpp": "after\n" })));
  }
  assert.throws(() =>
    canonicalProjectDiff(snapshot({ "item.cpp": "before\n" }), {
      version: "different-canonical-v1",
      files: { "item.cpp": "after\n" },
    }),
  );
  assert.throws(() =>
    compareCanonicalDiff(prepared(), {
      version: "different-canonical-v1",
      files: { "item.cpp": source },
    }),
  );
});

test("serialized preparation retains its identities and rejects modified baseline or reference hunks", () => {
  const original = prepared();
  const loaded = JSON.parse(JSON.stringify(original));
  assert.deepEqual(
    compareCanonicalDiff(loaded, snapshot({ "item.cpp": changed(10, 45) })).differenceIds,
    [],
  );
  const changedBaseline = structuredClone(loaded);
  changedBaseline.start.files["item.cpp"] = "changed cache\n";
  assert.throws(() =>
    compareCanonicalDiff(changedBaseline, snapshot({ "item.cpp": changed(10, 45) })),
  );
  const changedReference = structuredClone(loaded);
  changedReference.expectedHunks[0].lines.push("+unexpected cached change");
  assert.throws(() =>
    compareCanonicalDiff(changedReference, snapshot({ "item.cpp": changed(10, 45) })),
  );
});
test("an empty reference diff is diagnosed instead of providing a zero denominator or free score", () => {
  const start = snapshot({ "item.cpp": source });
  assert.deepEqual(canonicalProjectDiff(start, start).hunks, []);
  assert.throws(() => prepareCanonicalDiff(start, start), {
    code: "CANONICAL_DIFF_EMPTY_REFERENCE",
  });
});
