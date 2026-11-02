import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { symbolSpecifications } from "./symbol-spec.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const lineAt = (text, offset) => 1 + (text.slice(0, offset).match(/\n/g) ?? []).length;
const exactlyOnce = (source, text) =>
  text.length > 0 && source.indexOf(text) === source.lastIndexOf(text) && source.includes(text);

function validateFragment(source, fragment) {
  assert.ok(Number.isSafeInteger(fragment.start) && Number.isSafeInteger(fragment.end));
  assert.ok(0 <= fragment.start && fragment.start < fragment.end && fragment.end <= source.length);
  assert.equal(
    source.slice(fragment.start, fragment.end),
    fragment.text,
    "Fragment does not match source snapshot",
  );
}

async function publicAnchor(source, fragment, targetSide) {
  const entities = await symbolSpecifications({ fragments: [fragment], using: [] });
  const signatures = entities
    .map(({ signature }) => signature)
    .filter((signature) => fragment.text.includes(signature) && exactlyOnce(source, signature));
  // A suffix consisting only of closing braces and conditional delimiters is
  // also safe to disclose and can be much closer than a declaration signature.
  if (targetSide === "after") {
    const lines = fragment.text.split("\n");
    for (let at = lines.length - 1; at >= 0; at--) {
      if (!/^\s*(?:[};]+|#\s*endif)?\s*$/.test(lines[at])) break;
      const suffix = lines.slice(at).join("\n").trim();
      if (exactlyOnce(source, suffix)) {
        signatures.push(suffix);
        break;
      }
    }
  }
  signatures.sort((a, b) =>
    targetSide === "before"
      ? source.indexOf(a) - source.indexOf(b)
      : source.indexOf(b) - source.indexOf(a),
  );
  if (signatures.length) return signatures[0];
  // The prefix up to the first opening brace or semicolon is a declaration
  // header, not a function/type body. Variable initializers are not safe here.
  assert.ok(
    entities.length === 1 &&
      ["class", "struct", "union", "enum", "function-declaration", "function-definition"].includes(
        entities[0].kind,
      ),
    "No public anchor signature",
  );
  const match = /^[\s\S]*?[{;]/.exec(fragment.text);
  assert.ok(match, "No bounded declaration header");
  const prefix = match[0].trim();
  assert.ok(exactlyOnce(source, prefix), "Ambiguous declaration header");
  return prefix;
}

/** Locate a target using a unique anchor and an exact digest of the original gap.
 * This is fail-closed when changes in the intervening source invalidate the proof.
 */
export function locateAnchoredFragment(source, entry) {
  assert.equal(typeof source, "string");
  assert.ok(exactlyOnce(source, entry.anchor), "Anchor is missing or ambiguous");
  const pos = source.indexOf(entry.anchor);
  if (entry.targetSide === "context") {
    assert.ok(Number.isSafeInteger(entry.offset) && entry.offset >= 0);
    assert.equal(
      entry.anchor.slice(entry.offset, entry.offset + entry.target.length),
      entry.target,
    );
    return pos + entry.offset;
  }
  let start, gap;
  if (entry.targetSide === "before") {
    start = source.lastIndexOf(entry.target, pos - 1);
    assert.ok(start >= 0 && start + entry.target.length <= pos, "Target before anchor is missing");
    gap = source.slice(start + entry.target.length, pos);
  } else {
    assert.equal(entry.targetSide, "after");
    start = source.indexOf(entry.target, pos + entry.anchor.length);
    assert.ok(start >= 0, "Target after anchor is missing");
    gap = source.slice(pos + entry.anchor.length, start);
  }
  assert.equal(hash(gap), entry.gapSha256, "Source between target and anchor changed");
  const edge =
    entry.targetSide === "before"
      ? source.slice(Math.max(0, start - entry.edgeLength), start)
      : source.slice(start + entry.target.length, start + entry.target.length + entry.edgeLength);
  assert.equal(edge.length, entry.edgeLength, "Target boundary context is missing");
  if (entry.edgeAtBoundary)
    assert.ok(
      entry.targetSide === "before" ? start === 0 : start + entry.target.length === source.length,
      "Target boundary changed",
    );
  assert.equal(hash(edge), entry.edgeSha256, "Target boundary context changed");
  return start;
}

/** Expose coordinates and exact snippets only for ambiguous owned fragments. */
export async function ambiguityAnchors(source, task) {
  assert.equal(typeof source, "string");
  assert.ok(Array.isArray(task.fragments));
  const fragments = new Map();
  for (const fragment of task.fragments) {
    assert.equal(typeof fragment.id, "string");
    assert.ok(!fragments.has(fragment.id));
    fragments.set(fragment.id, fragment);
  }
  const result = [];
  for (const target of task.fragments) {
    if (!target.beforeFragment && !target.afterFragment) continue;
    validateFragment(source, target);
    let found, failure;
    for (const [id, targetSide] of [
      [target.beforeFragment, "before"],
      [target.afterFragment, "after"],
    ]) {
      if (!id) continue;
      const fragment = fragments.get(id);
      assert.ok(fragment && fragment !== target, "Missing private neighbour");
      validateFragment(source, fragment);
      assert.ok(
        targetSide === "before" ? target.end <= fragment.start : fragment.end <= target.start,
        "Invalid anchor direction",
      );
      try {
        const anchor = await publicAnchor(source, fragment, targetSide);
        const anchorStart = source.indexOf(anchor);
        assert.ok(fragment.start <= anchorStart && anchorStart + anchor.length <= fragment.end);
        const gap =
          targetSide === "before"
            ? source.slice(target.end, anchorStart)
            : source.slice(anchorStart + anchor.length, target.start);
        const edgeAtBoundary =
          targetSide === "before" ? target.start === 0 : target.end === source.length;
        const edge =
          targetSide === "before"
            ? source.slice(
                Math.max(0, source.lastIndexOf("\n", target.start - 2) + 1),
                target.start,
              )
            : source.slice(
                target.end,
                source.indexOf("\n", target.end) < 0
                  ? source.length
                  : source.indexOf("\n", target.end) + 1,
              );
        const entry = {
          fragmentId: target.id,
          target: target.text,
          startLine: lineAt(source, target.start),
          endLine: lineAt(source, target.end - 1),
          targetSide,
          anchor,
          gapSha256: hash(gap),
          edgeLength: edge.length,
          edgeSha256: hash(edge),
          edgeAtBoundary,
        };
        assert.equal(
          locateAnchoredFragment(source, entry),
          target.start,
          "Neighbour does not disambiguate the target",
        );
        found = entry;
        break;
      } catch (error) {
        // Try the other recorded neighbour. If neither is safe, retain the cause.
        failure = error;
      }
    }
    if (!found) {
      // Fall back to exact surrounding context when a neighbour is not unique.
      let left = target.start,
        right = target.end,
        radius = 1;
      while (!exactlyOnce(source, source.slice(left, right))) {
        if (left === 0 && right === source.length)
          throw new Error("Cannot uniquely anchor source context", { cause: failure });
        const before = Math.max(0, target.start - radius);
        const after = Math.min(source.length, target.end + radius);
        left = before ? source.lastIndexOf("\n", before - 1) + 1 : 0;
        const newline = source.indexOf("\n", after);
        right = newline < 0 ? source.length : newline + 1;
        radius *= 2;
      }
      found = {
        fragmentId: target.id,
        target: target.text,
        startLine: lineAt(source, target.start),
        endLine: lineAt(source, target.end - 1),
        targetSide: "context",
        anchor: source.slice(left, right),
        offset: target.start - left,
      };
      assert.equal(locateAnchoredFragment(source, found), target.start);
    }
    result.push(found);
  }
  return result;
}

function fence(text) {
  let length = 3;
  for (const [run] of text.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
  const mark = "`".repeat(length);
  return `${mark}\n${text}${text.endsWith("\n") ? "" : "\n"}${mark}`;
}

/** Present ambiguous snippets as prose, not an executable destination template. */
export function ambiguityAnchorsProse(entries) {
  assert.ok(Array.isArray(entries));
  if (!entries.length) return "";
  return [
    "For the following ambiguous source portions, use the specified exact text to identify the assigned occurrence. The line numbers refer only to the original snapshot and may be stale. Under the shared workspace lock, re-read the current source and follow the checks for each portion. If any check fails, do not guess; report the ambiguity. Check these portions before moving their anchor entities. During recovery, apply these checks when locating source that still needs removal; do not recreate an already removed source portion merely to satisfy its old anchor.",
    ...entries.map((entry) =>
      entry.targetSide === "context"
        ? [
            `The ambiguous portion was on snapshot lines ${entry.startLine} through ${entry.endLine}. Its unique context is shown below.`,
            `Under the lock, find that context exactly once. The target starts ${entry.offset} JavaScript UTF-16 code units into it and has length ${entry.target.length} code units. If the context is missing or ambiguous, do not guess.`,
            fence(entry.anchor),
          ].join("\n")
        : [
            `The ambiguous portion was on snapshot lines ${entry.startLine} through ${entry.endLine}. It is ${entry.targetSide} the unique anchor.`,
            "Under the lock, confirm the anchor occurs exactly once, choose the nearest exact target on the stated side, and verify that the UTF-8 SHA-256 of the exact intervening text matches the digest below.",
            "Exact ambiguous portion:",
            fence(entry.target),
            "Unique anchor excerpt:",
            fence(entry.anchor),
            `SHA-256 of the original intervening text encoded as UTF-8: ${entry.gapSha256}.`,
            `Also check the ${entry.edgeLength} JavaScript UTF-16 code units immediately ${entry.targetSide === "before" ? "before" : "after"} the target; their UTF-8 SHA-256 is ${entry.edgeSha256}.${entry.edgeAtBoundary ? " This edge must also remain at the file boundary." : ""}`,
          ].join("\n"),
    ),
  ].join("\n\n");
}
