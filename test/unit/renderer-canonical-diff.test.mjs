import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  CANONICAL_DIFF_POLICY,
  canonicalProjectDiff,
  prepareCanonicalDiff,
  compareCanonicalDiff,
  compareCanonicalSnapshots,
} from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";

const execute = promisify(execFile);
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

test("proven and deserialized comparisons preserve complete output for exact, unchanged and partial projects", () => {
  const start = snapshot({ "item.cpp": source, "remove.cpp": "gone\n" });
  const endpoint = snapshot({ "item.cpp": changed(10, 45), "added.h": "" });
  const reference = prepareCanonicalDiff(start, endpoint);
  const deserialized = JSON.parse(JSON.stringify(reference));
  assert.equal(reference.totalHunks, 4);
  assert.equal(Object.isFrozen(reference), true);
  assert.equal(Object.isFrozen(reference.start.files), true);
  assert.equal(Object.isFrozen(reference.expectedHunks), true);
  assert.ok(
    reference.expectedHunks.every((hunk) => Object.isFrozen(hunk) && Object.isFrozen(hunk.lines)),
  );
  const candidates = [
    [endpoint, 4],
    [start, 0],
    [snapshot({ "item.cpp": changed(10), "remove.cpp": "gone\n" }), 1],
    [snapshot({ "item.cpp": changed(10, 45), "added.h": "", "extra.cpp": "extra\n" }), 4],
  ];
  for (const [candidate, passed] of candidates) {
    const observed = compareCanonicalDiff(reference, candidate);
    assert.equal(observed.passedHunks, passed);
    assert.deepEqual(observed, compareCanonicalDiff(deserialized, candidate));
    assert.equal(Object.isFrozen(observed.actualHunks), true);
    assert.ok(
      observed.actualHunks.every((hunk) => Object.isFrozen(hunk) && Object.isFrozen(hunk.lines)),
    );
    assert.ok(observed.actualHunks.every((hunk, index) => hunk.id === `actual:${index}`));
  }
});

test("a serialized claimed reference identity cannot authorize unrelated expected hunks", () => {
  const reference = prepared();
  const partial = snapshot({ "item.cpp": changed(10) });
  const claimed = JSON.parse(JSON.stringify(reference));
  claimed.referenceIdentity = prepareCanonicalDiff(reference.start, partial).referenceIdentity;
  const result = compareCanonicalDiff(claimed, partial);
  assert.equal(result.totalHunks, 2);
  assert.equal(result.passedHunks, 1);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].status, "missing");
});

test("resealing a serialized context-trimmed hunk does not prove pinned grouping", () => {
  const forged = JSON.parse(JSON.stringify(prepared()));
  const hunk = forged.expectedHunks[0];
  assert.equal(hunk.lines[0][0], " ");
  hunk.lines.shift();
  hunk.oldStart++;
  hunk.newStart++;
  hunk.oldLines--;
  hunk.newLines--;
  forged.expectedDiffIdentity = createHash("sha256")
    .update(
      JSON.stringify(
        forged.expectedHunks.map((item) => [
          item.file,
          item.index,
          item.id,
          item.oldStart,
          item.oldLines,
          item.newStart,
          item.newLines,
          item.lines,
        ]),
      ),
    )
    .digest("hex");
  const result = compareCanonicalDiff(forged, snapshot({ "item.cpp": changed(10, 45) }));
  assert.equal(result.totalHunks, 2);
  assert.equal(result.passedHunks, 1);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].status, "wrong");
});

test("exact proven endpoints and unchanged inputs reuse compiled hunks while untrusted and partial inputs still diff", async () => {
  const module = new URL(
    "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs",
    import.meta.url,
  ).href;
  const child = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const target = process.argv[1];
const key = Symbol.for("explicit-edit.canonical-diff-replay-test");
const state = { forbidden: false, calls: 0, installed: false };
globalThis[key] = state;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== target) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    assert.match(source, /function projectDiff\\(/);
    state.installed = true;
    return { ...loaded, source: source + "\\nconst replayTestOriginal = projectDiff; projectDiff = (...args) => { const state = globalThis[Symbol.for(\\"explicit-edit.canonical-diff-replay-test\\")]; state.calls++; if (state.forbidden) throw Object.assign(new Error(), { code: \\"CANONICAL_DIFF_REPLAY_TEST\\" }); return replayTestOriginal(...args); };\\n" };
  },
});
try {
  const { prepareCanonicalDiff, compareCanonicalDiff } = await import(target);
  const snapshot = (text) => ({ version: "reuse-fixture-v1", files: { "item.cpp": text } });
  const lines = Array.from({length: 60}, (_, i) => "row-" + i);
  const start = snapshot(lines.join("\\n") + "\\n");
  const changed = [...lines]; changed[10] = "new-10"; changed[45] = "new-45";
  const endpoint = snapshot(changed.join("\\n") + "\\n");
  const reference = prepareCanonicalDiff(start, endpoint);
  const plain = JSON.parse(JSON.stringify(reference));
  const exact = compareCanonicalDiff(plain, endpoint);
  const noop = compareCanonicalDiff(plain, start);
  assert.equal(exact.passedHunks, 2); assert.equal(noop.passedHunks, 0);
  assert.equal(state.installed, true);
  const beforeFast = state.calls; state.forbidden = true;
  assert.deepEqual(compareCanonicalDiff(reference, endpoint), exact);
  assert.deepEqual(compareCanonicalDiff(reference, start), noop);
  assert.equal(state.calls, beforeFast);
  const partialLines = [...lines]; partialLines[10] = "new-10";
  const partial = snapshot(partialLines.join("\\n") + "\\n");
  for (const [prepared, candidate] of [
    [plain, endpoint], [new Proxy(reference, {}), endpoint], [reference, partial],
  ]) assert.throws(() => compareCanonicalDiff(prepared, candidate), { code: "CANONICAL_DIFF_REPLAY_TEST" });
  const invalid = structuredClone(plain); invalid.start.files["item.cpp"] = "tampered\\n";
  assert.throws(() => compareCanonicalDiff(invalid, start), { code: "ERR_ASSERTION" });
  assert.throws(() => compareCanonicalDiff(reference, { ...endpoint, version: "wrong-version" }), { code: "ERR_ASSERTION" });
  assert.equal(state.calls, beforeFast + 3);
  console.log(JSON.stringify({ status: "passed", replayedFastComparisons: 0, guardedFallbacks: 3 }));
} catch (error) {
  console.log(JSON.stringify({ status: "failed", code: error?.code ?? null, installed: state.installed, calls: state.calls }));
}
`;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", child, module]);
  assert.deepEqual(JSON.parse(stdout), {
    status: "passed",
    replayedFastComparisons: 0,
    guardedFallbacks: 3,
  });
});

test("an empty reference diff is diagnosed instead of providing a zero denominator or free score", () => {
  const start = snapshot({ "item.cpp": source });
  assert.deepEqual(canonicalProjectDiff(start, start).hunks, []);
  assert.throws(() => prepareCanonicalDiff(start, start), {
    code: "CANONICAL_DIFF_EMPTY_REFERENCE",
  });
});
