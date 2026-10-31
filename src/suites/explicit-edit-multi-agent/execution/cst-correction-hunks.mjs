import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const markerPrefix = "@@UNCHANGED_CST[";
const markerPattern = /@@UNCHANGED_CST\[([^\]\n]+)\]@@/g;
const envelopePattern = /\n@@UNCHANGED_CST\[([^\]\n]+)\]@@\n/g;
const bodyKinds = new Set(["compound_statement", "declaration_list", "field_declaration_list"]);
const scopeKinds = new Set([
  "namespace_definition",
  "preproc_if",
  "preproc_ifdef",
  "class_specifier",
  "struct_specifier",
  "function_definition",
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sourceLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const markerText = (key) => `\n${markerPrefix}${key}]@@\n`;
const isWhitespace = (value) => value === 32 || (value >= 9 && value <= 13);
const byteBoundary = (raw, offset) => offset === raw.length || (raw[offset] & 0xc0) !== 0x80;

function residualText(raw, start, end) {
  while (start < end && isWhitespace(raw[start])) start++;
  while (start < end && isWhitespace(raw[end - 1])) end--;
  return raw.subarray(start, end).toString("utf8");
}

/** Validate a dense preorder tree before trusting its source intervals. */
function inventory(raw, nodes) {
  assert.ok(Buffer.isBuffer(raw));
  assert.ok(Buffer.from(raw.toString("utf8"), "utf8").equals(raw));
  assert.equal(raw.includes(Buffer.from(markerPrefix)), false);
  assert.ok(Array.isArray(nodes) && nodes.length > 0);
  const listed = new Set();
  for (const [index, row] of nodes.entries()) {
    assert.ok(Array.isArray(row) && row.length === 7);
    const [id, kind, label, start, length, parent, children] = row;
    assert.equal(id, index);
    assert.ok(typeof kind === "string" && kind.length > 0 && kind.isWellFormed());
    assert.ok(typeof label === "string" && label.isWellFormed());
    assert.ok([start, length, parent].every(Number.isSafeInteger));
    assert.ok(start >= 0 && length >= 0 && start + length <= raw.length);
    assert.ok(byteBoundary(raw, start) && byteBoundary(raw, start + length));
    assert.ok(index === 0 ? parent === -1 : parent >= 0 && parent < index);
    assert.ok(Array.isArray(children));
    let cursor = start;
    for (const child of children) {
      assert.ok(Number.isSafeInteger(child) && child > index && child < nodes.length);
      assert.equal(listed.has(child), false);
      listed.add(child);
      const next = nodes[child];
      assert.ok(Array.isArray(next) && next.length === 7);
      assert.equal(next[5], id);
      assert.ok(next[3] >= cursor && next[3] + next[4] <= start + length);
      cursor = next[3] + next[4];
    }
  }
  assert.equal(listed.size, nodes.length - 1);
  const ends = Array.from({ length: nodes.length });
  const gaps = Array.from({ length: nodes.length });
  const hashes = Array.from({ length: nodes.length });
  for (let index = nodes.length - 1; index >= 0; index--) {
    const [id, kind, label, start, length, , children] = nodes[index];
    const parts = [];
    let nextId = id + 1;
    let cursor = start;
    for (const child of children) {
      assert.equal(child, nextId);
      nextId = ends[child];
      parts.push(residualText(raw, cursor, nodes[child][3]));
      cursor = nodes[child][3] + nodes[child][4];
    }
    parts.push(residualText(raw, cursor, start + length));
    ends[id] = nextId;
    gaps[id] = parts;
    hashes[id] = digest(
      JSON.stringify([kind, label, parts, children.map((child) => hashes[child])]),
    );
  }
  assert.equal(ends[0], nodes.length);
  return { nodes, gaps, hashes, ends };
}

function location(row, raw, nodes) {
  const [id, kind, , start, length, parent, children] = row;
  const bodies = children.filter((child) => bodyKinds.has(nodes[child][1]));
  const header = bodies.length
    ? raw.subarray(start, nodes[bodies[0]][3]).toString("utf8").trim()
    : raw
        .subarray(start, start + length)
        .toString("utf8")
        .split("\n", 1)[0]
        .trim();
  const scopes = [];
  for (let current = parent; current !== -1; current = nodes[current][5]) {
    const scope = nodes[current];
    if (scopeKinds.has(scope[1]))
      scopes.push(
        raw
          .subarray(scope[3], scope[3] + scope[4])
          .toString("utf8")
          .split("\n", 1)[0]
          .trim(),
      );
  }
  let line = 1;
  for (let at = 0; at < start; at++) if (raw[at] === 10) line++;
  return { kind, header, line, scopes: scopes.reverse(), node: id };
}

function skeleton(raw, cuts) {
  const segments = [];
  const pieces = [];
  let cursor = 0;
  let position = 0;
  for (const cut of cuts.toSorted((a, b) => a.start - b.start)) {
    assert.ok(cut.start >= cursor);
    const gap = raw.subarray(cursor, cut.start);
    const marker = Buffer.from(markerText(cut.key));
    pieces.push(gap, marker);
    segments.push([position, position + gap.length, cursor, cut.start, false]);
    position += gap.length;
    segments.push([position, position + marker.length, cut.start, cut.end, true]);
    position += marker.length;
    cursor = cut.end;
  }
  const tail = raw.subarray(cursor);
  pieces.push(tail);
  segments.push([position, position + tail.length, cursor, raw.length, false]);
  return { text: Buffer.concat(pieces).toString("utf8"), segments };
}

function restore(text, anchors, side) {
  const seen = new Set();
  const result = text.replace(envelopePattern, (_, key) => {
    assert.ok(Object.hasOwn(anchors, key));
    assert.equal(seen.has(key), false);
    seen.add(key);
    return anchors[key][side];
  });
  assert.equal(seen.size, Object.keys(anchors).length);
  return Buffer.from(result);
}

function orderedAnchors(actual, expected) {
  const markers = (lines) =>
    lines.flatMap((line, index) => {
      if (!line.startsWith(markerPrefix)) return [];
      const match = /^@@UNCHANGED_CST\[([^\]\n]+)\]@@\n$/.exec(line);
      assert.ok(match);
      return [[index, match[1]]];
    });
  const left = markers(actual);
  const right = markers(expected);
  const target = new Map(right.map(([line, key]) => [key, line]));
  assert.equal(target.size, right.length);
  assert.equal(new Set(left.map(([, key]) => key)).size, left.length);
  assert.equal(left.length, right.length);
  for (const [, key] of left) assert.ok(target.has(key));
  const tails = [];
  const tailAt = [];
  const parents = [];
  for (const [index, [, key]] of left.entries()) {
    const position = target.get(key);
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle] < position) low = middle + 1;
      else high = middle;
    }
    parents[index] = low ? tailAt[low - 1] : -1;
    tails[low] = position;
    tailAt[low] = index;
  }
  const chain = [];
  for (let index = tailAt.length ? tailAt.at(-1) : -1; index !== -1; index = parents[index])
    chain.push([left[index][0], target.get(left[index][1])]);
  return chain.reverse();
}

function operations(actual, expected) {
  const result = [];
  const append = (kind, a0, a1, e0, e1) => {
    if (a0 === a1 && e0 === e1) return;
    if (kind === "equal" && result.at(-1)?.[0] === "equal") {
      const previous = result.pop();
      result.push([kind, previous[1], a1, previous[3], e1]);
    } else result.push([kind, a0, a1, e0, e1]);
  };
  let a0 = 0;
  let e0 = 0;
  for (const [a1, e1] of [...orderedAnchors(actual, expected), [actual.length, expected.length]]) {
    const left = actual.slice(a0, a1);
    const right = expected.slice(e0, e1);
    const equal =
      left.length === right.length && left.every((value, index) => value === right[index]);
    append(equal ? "equal" : "change", a0, a1, e0, e1);
    if (a1 < actual.length) {
      assert.equal(actual[a1], expected[e1]);
      append("equal", a1, a1 + 1, e1, e1 + 1);
    }
    a0 = a1 + 1;
    e0 = e1 + 1;
  }
  return result;
}

function lineBytes(lines) {
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + Buffer.byteLength(line));
  return offsets;
}

function sourceBoundary(segments, position) {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle][0] <= position) low = middle + 1;
    else high = middle;
  }
  const [s0, s1, r0, r1, marker] = segments[Math.max(0, low - 1)];
  assert.ok(position >= s0 && position <= s1);
  if (position === s0) return r0;
  if (position === s1) return r1;
  if (!marker) return r0 + position - s0;
  assert.ok(position === s0 + 1 || position === s1 - 1);
  return position === s0 + 1 ? r0 : r1;
}

/** Render complete ordered source gaps around proven unchanged CST occurrences.
 * Node rows are [preorderId, kind, label, startByte, byteLength, parentId, children].
 * Anchors retain actual/expected UTF-8 payloads and locations for controller use.
 * This does not infer definition owners, apply source edits or schedule hunks.
 */
export function cstCorrectionHunks({
  actual,
  expected,
  actualNodes,
  expectedNodes,
  mappings,
  file,
}) {
  assert.ok(typeof file === "string" && file.length > 0 && file.isWellFormed());
  const a = inventory(actual, actualNodes);
  const e = inventory(expected, expectedNodes);
  assert.ok(Array.isArray(mappings));
  const pairs = new Map();
  const used = new Set();
  for (const pair of mappings) {
    assert.ok(Array.isArray(pair) && pair.length === 2);
    const [left, right] = pair;
    assert.ok(Number.isSafeInteger(left) && left >= 0 && left < a.nodes.length);
    assert.ok(Number.isSafeInteger(right) && right >= 0 && right < e.nodes.length);
    assert.equal(pairs.has(left), false);
    assert.equal(used.has(right), false);
    pairs.set(left, right);
    used.add(right);
  }
  const equal = Array.from({ length: a.nodes.length }, () => false);
  for (let index = a.nodes.length - 1; index >= 0; index--) {
    const row = a.nodes[index];
    const other = pairs.get(index);
    if (other === undefined) continue;
    const target = e.nodes[other];
    equal[index] =
      row[1] === target[1] &&
      row[2] === target[2] &&
      a.gaps[index].length === e.gaps[other].length &&
      a.gaps[index].every((value, at) => value === e.gaps[other][at]) &&
      row[6].length === target[6].length &&
      row[6].every((child, at) => pairs.get(child) === target[6][at] && equal[child]);
    if (equal[index]) assert.equal(a.hashes[index], e.hashes[other]);
  }
  const selected = [];
  let blocked = -1;
  for (const row of a.nodes) {
    if (row[0] < blocked || !equal[row[0]] || row[4] === 0) continue;
    const target = e.nodes[pairs.get(row[0])];
    if (target[4] === 0) continue;
    selected.push([row, target]);
    blocked = a.ends[row[0]];
  }
  const orderedTargets = selected
    .map(([, row]) => [row[0], e.ends[row[0]]])
    .toSorted((x, y) => x[0] - y[0]);
  for (let index = 1; index < orderedTargets.length; index++)
    assert.ok(orderedTargets[index - 1][1] <= orderedTargets[index][0]);
  const anchors = {};
  const metadata = {};
  const cuts = { actual: [], expected: [] };
  for (const [index, [left, right]] of selected.entries()) {
    const hash = a.hashes[left[0]];
    const key = `${String(index).padStart(6, "0")}:${encodeURIComponent(left[1])}:${hash.slice(0, 16)}`;
    const actualLocation = location(left, actual, a.nodes);
    const expectedLocation = location(right, expected, e.nodes);
    anchors[key] = {
      actual: actual.subarray(left[3], left[3] + left[4]).toString("utf8"),
      expected: expected.subarray(right[3], right[3] + right[4]).toString("utf8"),
      structuralSha256: hash,
      actualSourceBytes: [left[3], left[3] + left[4]],
      expectedSourceBytes: [right[3], right[3] + right[4]],
      locations: { actual: actualLocation, expected: expectedLocation },
    };
    metadata[key] = { structuralSha256: hash, actual: actualLocation, expected: expectedLocation };
    cuts.actual.push({ start: left[3], end: left[3] + left[4], key });
    cuts.expected.push({ start: right[3], end: right[3] + right[4], key });
  }
  const left = skeleton(actual, cuts.actual);
  const right = skeleton(expected, cuts.expected);
  assert.ok(restore(left.text, anchors, "actual").equals(actual));
  assert.ok(restore(right.text, anchors, "expected").equals(expected));
  const actualLines = sourceLines(left.text);
  const expectedLines = sourceLines(right.text);
  const actualOffsets = lineBytes(actualLines);
  const expectedOffsets = lineBytes(expectedLines);
  const changes = operations(actualLines, expectedLines);
  const hunks = [];
  const reconstructed = [];
  for (const [index, [kind, a0, a1, e0, e1]] of changes.entries()) {
    if (kind === "equal") {
      reconstructed.push(...actualLines.slice(a0, a1));
      continue;
    }
    const before = changes[index - 1]?.[0] === "equal" ? actualLines[a0 - 1] : "";
    const after = changes[index + 1]?.[0] === "equal" ? actualLines[a1] : "";
    const oldText = actualLines.slice(a0, a1).join("");
    const newText = expectedLines.slice(e0, e1).join("");
    const keys = [
      ...new Set(
        [...`${before}${oldText}${newText}${after}`.matchAll(markerPattern)].map(
          (match) => match[1],
        ),
      ),
    ];
    hunks.push({
      file,
      actual: oldText,
      expected: newText,
      contextBefore: before,
      contextAfter: after,
      actualSourceBytes: [
        sourceBoundary(left.segments, actualOffsets[a0]),
        sourceBoundary(left.segments, actualOffsets[a1]),
      ],
      expectedSourceBytes: [
        sourceBoundary(right.segments, expectedOffsets[e0]),
        sourceBoundary(right.segments, expectedOffsets[e1]),
      ],
      actualSkeletonLines: [a0, a1],
      expectedSkeletonLines: [e0, e1],
      unchangedSubtrees: Object.fromEntries(keys.map((key) => [key, metadata[key]])),
      payloadBytes: Buffer.byteLength(oldText) + Buffer.byteLength(newText),
    });
    reconstructed.push(...expectedLines.slice(e0, e1));
  }
  assert.equal(reconstructed.join(""), right.text);
  return { hunks, anchors, actualSkeleton: left.text, expectedSkeleton: right.text };
}
