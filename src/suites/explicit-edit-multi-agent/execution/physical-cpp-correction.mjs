import assert from "node:assert/strict";
import { diffArrays } from "diff";
import { canonicalizeCpp } from "../grading/canonical-snapshot.mjs";

/** Project changed syntax onto sealed physical source. Canonical ordering is used
 * only for correspondence; matched subtrees are never rewritten or reordered.
 */
export async function physicalCppTarget(actual, expected, { expectedMacros } = {}) {
  // All repairs are projected toward the same final project context. A restored
  // definition can resolve a caller without changing any of its physical bytes.
  const before = await canonicalizeCpp(actual, { macros: expectedMacros, projection: true });
  const after = await canonicalizeCpp(expected, { macros: expectedMacros, projection: true });
  if (before.text === after.text) return actual;
  const edits = [];
  const replace = (left, right) => {
    edits.push({ start: left.start, end: left.end, text: expected.slice(right.start, right.end) });
  };
  function reconcile(left, right) {
    if (left.key === right.key) return;
    if (left.type !== right.type || !left.children.length || !right.children.length) {
      replace(left, right);
      return;
    }
    const sequence = !left.container || !right.container;
    const pairs = new Map();
    const used = new Set();
    let oldIndex = 0;
    let newIndex = 0;
    for (const part of diffArrays(left.children, right.children, {
      comparator: (a, b) => a.type === b.type && a.key === b.key,
    })) {
      if (part.removed) oldIndex += part.value.length;
      else if (part.added) newIndex += part.value.length;
      else {
        for (let index = 0; index < part.value.length; index++) {
          pairs.set(right.children[newIndex++], left.children[oldIndex]);
          used.add(left.children[oldIndex++]);
        }
      }
    }
    // Canonical sort positions do not establish physical ownership. Prefer exact
    // owners, signatures with renamed bindings, and unchanged bodies. Both ends
    // must be unique before a correspondence can preserve accepted bytes safely.
    if (!sequence)
      for (const field of ["owner", "identity", "anchor", "name"]) {
        for (const child of right.children) {
          if (pairs.has(child) || !child.sortable || child[field] == null) continue;
          const compatible = (candidate) =>
            candidate.sortable &&
            candidate.type === child.type &&
            candidate[field] === child[field];
          const candidates = left.children.filter(
            (candidate) => !used.has(candidate) && compatible(candidate),
          );
          const targets = right.children.filter(
            (candidate) => !pairs.has(candidate) && compatible(candidate),
          );
          if (candidates.length === 1 && targets.length === 1) {
            pairs.set(child, candidates[0]);
            used.add(candidates[0]);
          }
        }
      }
    // Ordered syntax has positional roles (arguments, statement slots, tokens).
    // Retain exact anchors first, then recurse through changed roles rather than
    // replacing an entire body or argument list when its arity changes.
    if (sequence) {
      for (const [index, child] of right.children.entries()) {
        const current = left.children[index];
        if (!pairs.has(child) && current && !used.has(current) && current.type === child.type) {
          pairs.set(child, current);
          used.add(current);
        }
      }
    }
    const unmatchedOld = left.children.filter((child) => !used.has(child));
    const unmatchedNew = right.children.filter((child) => !pairs.has(child));
    if (!sequence) {
      const oldDefinitions = unmatchedOld.filter((child) => child.sortable);
      const newDefinitions = unmatchedNew.filter((child) => child.sortable);
      assert.ok(
        !oldDefinitions.length ||
          !newDefinitions.length ||
          (oldDefinitions.length === 1 && newDefinitions.length === 1),
        "Ambiguous physical definition correspondence",
      );
    }
    if (unmatchedOld.length === unmatchedNew.length) {
      unmatchedNew.forEach((child, index) => {
        pairs.set(child, unmatchedOld[index]);
        used.add(unmatchedOld[index]);
      });
    }
    for (const [next, current] of pairs) reconcile(current, next);
    for (const child of left.children) {
      if (!used.has(child)) edits.push({ start: child.start, end: child.end, text: "" });
    }
    const physical = [...right.children].sort((a, b) => a.start - b.start);
    const insertions = new Map();
    for (const [index, child] of physical.entries()) {
      if (pairs.has(child)) continue;
      const previous = physical
        .slice(0, index)
        .reverse()
        .find((node) => pairs.has(node));
      const next = physical.slice(index + 1).find((node) => pairs.has(node));
      const at = previous ? pairs.get(previous).end : next ? pairs.get(next).start : left.start;
      const leading = expected.slice(0, child.start).match(/[\t \r\n]*$/)[0];
      const trailing = expected.slice(child.end).match(/^[\t \r\n]*/)[0];
      const prefix = sequence ? leading : leading || "\n";
      const suffix = sequence
        ? trailing
        : at === actual.length && !actual.endsWith("\n")
          ? ""
          : trailing || "\n";
      const text = prefix + expected.slice(child.start, child.end) + suffix;
      const group = insertions.get(at) ?? [];
      group.push(text);
      insertions.set(at, group);
    }
    for (const [at, pieces] of insertions)
      edits.push({ start: at, end: at, text: pieces.join("") });
  }
  if (!before.projection) {
    // Existing comment-only files have no scoring syntax, but their bytes still
    // belong to the candidate. Do not discard them while adding missing code.
    return actual + (actual && !actual.endsWith("\n") ? "\n" : "") + expected;
  }
  if (!after.projection) {
    for (const child of before.projection.children)
      edits.push({ start: child.start, end: child.end, text: "" });
  } else reconcile(before.projection, after.projection);
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let end = 0;
  for (const edit of ordered) {
    assert.ok(edit.start >= end, "Ambiguous overlapping physical correction");
    end = edit.end;
  }
  let result = actual;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  const checked = await canonicalizeCpp(result, { macros: expectedMacros });
  assert.equal(
    checked.text,
    after.text,
    "Physical correction does not reach its canonical endpoint",
  );
  return result;
}
