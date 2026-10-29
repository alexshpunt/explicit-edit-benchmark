import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { structuredPatch } from "diff";

export const CANONICAL_DIFF_POLICY = Object.freeze({
  version: "renderer-canonical-diff-v1",
  implementation: "jsdiff",
  implementationVersion: "9.0.0",
  context: 3,
  newline: "canonical-input-lf",
  filePresence: "json-header-line-v1",
  hunkIdentity: "baseline-range-and-lines",
  association: "overlapping-baseline-range-v1",
});

assert.equal(
  createRequire(import.meta.url)("diff/package.json").version,
  CANONICAL_DIFF_POLICY.implementationVersion,
  "Canonical diff requires its pinned implementation",
);

const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function projectPath(file) {
  assert.equal(typeof file, "string", "Invalid canonical project path");
  assert.ok(
    file.length > 0 &&
      !file.startsWith("/") &&
      !/^[A-Za-z]:/.test(file) &&
      !/[\\\u0000-\u001f\u007f]/.test(file) &&
      file.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Canonical paths must be project relative",
  );
  return file;
}

/** Inputs are canonical snapshots with {version, files: Record<relativePath, text>}.
 * Other snapshot diagnostics are annotations; source-bearing content belongs in files.
 */
function snapshotView(snapshot) {
  assert.ok(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot));
  assert.ok(typeof snapshot.version === "string" && snapshot.version.length > 0);
  const files = snapshot.files;
  assert.ok(files && typeof files === "object" && !Array.isArray(files));
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(files)));
  const entries = Object.entries(files).sort(([left], [right]) => order(left, right));
  for (const [file, text] of entries) {
    projectPath(file);
    assert.equal(typeof text, "string", "Canonical file content must be text");
    assert.ok(!text.includes("\r"), "Canonical file content must use LF newlines");
  }
  return Object.freeze({
    version: snapshot.version,
    files: Object.freeze(Object.fromEntries(entries)),
  });
}

function identity(snapshot) {
  return hash([snapshot.version, Object.entries(snapshot.files)]);
}

function hunkStorageIdentity(hunks) {
  return hash(
    hunks.map((hunk) => [
      hunk.file,
      hunk.index,
      hunk.id,
      hunk.oldStart,
      hunk.oldLines,
      hunk.newStart,
      hunk.newLines,
      hunk.lines,
    ]),
  );
}

function fileText(snapshot, file) {
  // A present empty file differs from an absent file. The header is comparison
  // representation only and is never written into the measured workspace.
  return Object.hasOwn(snapshot.files, file)
    ? JSON.stringify({ file }) + "\n" + snapshot.files[file]
    : "";
}

function freezeHunk(hunk, file, index, prefix) {
  return Object.freeze({
    id: `${prefix}:${index}`,
    file,
    index,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: Object.freeze([...hunk.lines]),
  });
}

function projectDiff(before, after, prefix) {
  assert.equal(before.version, after.version, "Canonical representation version changed");
  const hunks = [];
  const files = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort(
    order,
  );
  for (const file of files) {
    const patch = structuredPatch(
      file,
      file,
      fileText(before, file),
      fileText(after, file),
      undefined,
      undefined,
      { context: CANONICAL_DIFF_POLICY.context, ignoreWhitespace: false, stripTrailingCr: false },
    );
    assert.ok(Array.isArray(patch.hunks), "Canonical diff did not complete");
    for (const hunk of patch.hunks) hunks.push(freezeHunk(hunk, file, hunks.length, prefix));
  }
  return Object.freeze({
    version: CANONICAL_DIFF_POLICY.version,
    policy: CANONICAL_DIFF_POLICY,
    canonicalVersion: before.version,
    beforeIdentity: identity(before),
    afterIdentity: identity(after),
    hunks: Object.freeze(hunks),
  });
}

/** Diff complete project representations, including file presence. No task IDs enter this view. */
export function canonicalProjectDiff(before, after) {
  return projectDiff(snapshotView(before), snapshotView(after), "hunk");
}

/** Cache the trusted baseline and reference hunks once, independently of candidates. */
export function prepareCanonicalDiff(start, reference) {
  const baseline = snapshotView(start);
  const endpoint = snapshotView(reference);
  const expected = projectDiff(baseline, endpoint, "reference");
  if (expected.hunks.length === 0) {
    throw Object.assign(new Error("The canonical round has no observable reference changes"), {
      code: "CANONICAL_DIFF_EMPTY_REFERENCE",
    });
  }
  return Object.freeze({
    version: CANONICAL_DIFF_POLICY.version,
    policy: CANONICAL_DIFF_POLICY,
    canonicalVersion: baseline.version,
    startIdentity: expected.beforeIdentity,
    referenceIdentity: expected.afterIdentity,
    start: baseline,
    totalHunks: expected.hunks.length,
    expectedHunks: expected.hunks,
    expectedDiffIdentity: hunkStorageIdentity(expected.hunks),
  });
}

function hunkSignature(hunk) {
  // Actual independent changes can shift newStart without changing this hunk.
  // oldStart remains meaningful because both deltas use the same baseline.
  return JSON.stringify([hunk.file, hunk.oldStart, hunk.oldLines, hunk.newLines, hunk.lines]);
}

function baselineRange(hunk) {
  const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
  return { start, end: start + hunk.oldLines };
}

function overlaps(left, right) {
  if (left.start === left.end) return right.start <= left.start && left.start <= right.end;
  if (right.start === right.end) return left.start <= right.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function grouped(hunks) {
  const files = new Map();
  for (const hunk of hunks) {
    let rows = files.get(hunk.file);
    if (!rows) files.set(hunk.file, (rows = []));
    rows.push({ hunk, ...baselineRange(hunk) });
  }
  return files;
}

function associations(expected, actual) {
  const byExpected = expected.map(() => []);
  const actualAssociated = new Set();
  const expectedFiles = grouped(expected);
  for (const [file, rows] of grouped(actual)) {
    const reference = expectedFiles.get(file) ?? [];
    let first = 0;
    for (const row of rows) {
      while (first < reference.length && reference[first].end < row.start) first++;
      for (
        let index = first;
        index < reference.length && reference[index].start <= row.end;
        index++
      ) {
        const other = reference[index];
        if (!overlaps(row, other)) continue;
        byExpected[other.hunk.index].push(row.hunk.index);
        actualAssociated.add(row.hunk.index);
      }
    }
  }
  return { byExpected, actualAssociated };
}

function validatePrepared(prepared) {
  assert.ok(prepared && typeof prepared === "object");
  assert.equal(prepared.version, CANONICAL_DIFF_POLICY.version);
  assert.deepEqual(prepared.policy, CANONICAL_DIFF_POLICY);
  const baseline = snapshotView(prepared.start);
  assert.equal(prepared.canonicalVersion, baseline.version);
  assert.equal(prepared.startIdentity, identity(baseline), "The cached canonical baseline changed");
  assert.match(prepared.referenceIdentity, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(prepared.totalHunks) && prepared.totalHunks > 0);
  assert.ok(Array.isArray(prepared.expectedHunks));
  assert.equal(prepared.expectedHunks.length, prepared.totalHunks);
  for (const [index, hunk] of prepared.expectedHunks.entries()) {
    assert.equal(hunk.index, index);
    assert.equal(hunk.id, `reference:${index}`);
    projectPath(hunk.file);
    for (const key of ["oldStart", "oldLines", "newStart", "newLines"])
      assert.ok(Number.isSafeInteger(hunk[key]) && hunk[key] >= 0);
    assert.ok(Array.isArray(hunk.lines) && hunk.lines.every((line) => typeof line === "string"));
  }
  assert.equal(
    prepared.expectedDiffIdentity,
    hunkStorageIdentity(prepared.expectedHunks),
    "The cached canonical reference diff changed",
  );
  return baseline;
}

/** Compare ordinary hunks from one common baseline. Unmatched reference hunks
 * are disagreements; unmatched actual hunks add penalties only outside all
 * reference baseline ranges. Association does not reason about source semantics.
 */
export function compareCanonicalDiff(prepared, actual) {
  const baseline = validatePrepared(prepared);
  const candidate = snapshotView(actual);
  assert.equal(
    candidate.version,
    prepared.canonicalVersion,
    "Canonical representation version changed",
  );
  const observed = projectDiff(baseline, candidate, "actual");
  const expected = prepared.expectedHunks;
  const actualHunks = observed.hunks;
  const signatures = new Map();
  for (const hunk of actualHunks) {
    const signature = hunkSignature(hunk);
    let indices = signatures.get(signature);
    if (!indices) signatures.set(signature, (indices = []));
    indices.push(hunk.index);
  }
  const { byExpected, actualAssociated } = associations(expected, actualHunks);
  const agreements = [];
  const mismatches = [];
  for (const hunk of expected) {
    const matches = signatures.get(hunkSignature(hunk));
    if (matches?.length) {
      agreements.push({
        expectedId: hunk.id,
        expectedIndex: hunk.index,
        actualIndex: matches.shift(),
      });
      continue;
    }
    const actualIndices = byExpected[hunk.index];
    mismatches.push({
      id: hunk.id,
      kind: "expected",
      status: actualIndices.length ? "wrong" : "missing",
      file: hunk.file,
      oldStart: hunk.oldStart,
      expectedIndex: hunk.index,
      actualIndices,
    });
  }
  for (const hunk of actualHunks) {
    if (actualAssociated.has(hunk.index)) continue;
    mismatches.push({
      id: `extra:${JSON.stringify([hunk.file, hunk.oldStart, hunk.oldLines])}`,
      kind: "extra",
      file: hunk.file,
      oldStart: hunk.oldStart,
      actualIndices: [hunk.index],
    });
  }
  mismatches.sort(
    (left, right) =>
      order(left.file, right.file) || left.oldStart - right.oldStart || order(left.id, right.id),
  );
  return {
    version: CANONICAL_DIFF_POLICY.version,
    policy: CANONICAL_DIFF_POLICY,
    canonicalVersion: prepared.canonicalVersion,
    startIdentity: prepared.startIdentity,
    referenceIdentity: prepared.referenceIdentity,
    actualIdentity: observed.afterIdentity,
    totalHunks: prepared.totalHunks,
    passedHunks: agreements.length,
    expectedHunks: expected,
    actualHunks,
    agreements,
    mismatches,
    differenceIds: mismatches.map(({ id }) => id),
  };
}

/** Convenience API; use prepareCanonicalDiff plus compareCanonicalDiff for repeated measurements. */
export function compareCanonicalSnapshots(start, reference, actual) {
  return compareCanonicalDiff(prepareCanonicalDiff(start, reference), actual);
}
