import assert from "node:assert/strict";
import { cppTokens, headerSpan } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "./generator.mjs";

const identifier = /^[A-Za-z_]\w*$/;
const requireGuard = (condition) => assert.ok(condition, "Unsupported project header protection");

function directives(source) {
  let masked = "",
    cursor = 0;
  for (const token of cppTokens(source)) {
    if (identifier.test(token.text)) continue;
    masked += source.slice(cursor, token.start) + token.text.replace(/[^\n]/g, " ");
    cursor = token.end;
  }
  masked += source.slice(cursor);
  const result = [];
  const stack = [];
  for (const line of masked.matchAll(/^[ \t]*#[^\n]*(?:\n|$)/gm)) {
    if (result.length && line.index < result.at(-1).end) continue;
    let end = line.index + line[0].length;
    while (/\\\r?\n$/.test(masked.slice(line.index, end))) {
      const newline = masked.indexOf("\n", end);
      end = newline < 0 ? masked.length : newline + 1;
      if (newline < 0) break;
    }
    const logical = masked.slice(line.index, end).replace(/\\\r?\n/g, "");
    const head = /^[ \t]*#[ \t]*(\w+)\b([\s\S]*)$/.exec(logical);
    if (!head) continue;
    const kind = head[1],
      tail = head[2].trim(),
      depth = stack.length;
    if (["if", "ifdef", "ifndef"].includes(kind)) {
      requireGuard(kind === "if" ? tail.length > 0 : identifier.test(tail));
      stack.push({ alternative: false });
    } else if (kind === "elif" || kind === "else") {
      requireGuard(stack.length > 0 && !stack.at(-1).alternative);
      requireGuard(kind === "elif" ? tail.length > 0 : tail.length === 0);
      if (kind === "else") stack.at(-1).alternative = true;
    } else if (kind === "endif") {
      requireGuard(stack.length > 0 && tail.length === 0);
      stack.pop();
    }
    result.push({ kind, start: line.index, end, depth, argument: tail });
  }
  requireGuard(stack.length === 0);
  return result;
}

/** Refuse computed guard names without implementing a macro expander. */
function refusePastedGuards(tree, guards) {
  const parts = new Set();
  let pasting = false;
  for (let source of Object.values(tree)) {
    source = source.replace(/\\\r?\n/g, "");
    let masked = "",
      cursor = 0;
    for (const token of cppTokens(source)) {
      if (identifier.test(token.text)) continue;
      masked += source.slice(cursor, token.start) + token.text.replace(/[^\r\n]/g, " ");
      cursor = token.end;
    }
    masked += source.slice(cursor);
    pasting ||= masked.includes("##");
    for (const match of masked.matchAll(/[A-Za-z_]\w*|[0-9][A-Za-z_0-9]*/g)) parts.add(match[0]);
  }
  if (!pasting) return;
  for (const guard of guards) {
    const reachable = new Uint8Array(guard.length + 1);
    reachable[0] = 1;
    for (let start = 0; start < guard.length; start++) {
      if (!reachable[start]) continue;
      for (let end = start + 1; end <= guard.length; end++) {
        const part = guard.slice(start, end);
        // Numbers may also come from compiler built-ins such as __LINE__.
        if (part !== guard && (parts.has(part) || /^[0-9]+$/.test(part))) reachable[end] = 1;
      }
    }
    requireGuard(!reachable[guard.length]);
  }
}
/** Remove only ordinary outer guards from the registered packed project headers. */
export function stripProjectGuards(tree, headers) {
  requireGuard(tree !== null && typeof tree === "object" && !Array.isArray(tree));
  requireGuard(Object.values(tree).every((text) => typeof text === "string"));
  const source = tree["main.cpp"];
  requireGuard(typeof source === "string" && Array.isArray(headers) && headers.length > 0);
  const files = new Set(),
    guards = new Set();
  const registered = headers.map((header) => {
    requireGuard(header !== null && typeof header === "object" && !Array.isArray(header));
    const { file, guard } = header;
    requireGuard(typeof file === "string" && /^[A-Za-z_]\w*\.h$/.test(file));
    requireGuard(typeof guard === "string" && identifier.test(guard));
    requireGuard(!files.has(file) && !guards.has(guard));
    files.add(file);
    guards.add(guard);
    return { file, guard };
  });
  refusePastedGuards(tree, guards);
  const all = directives(source),
    tokens = Object.values(tree).flatMap((text) => cppTokens(text.replace(/\\\r?\n/g, ""))),
    edits = [];
  for (const { file, guard } of registered) {
    requireGuard(tokens.filter((token) => token.text === guard).length === 2);
    const span = headerSpan(source, guard);
    const selected = all.filter((item) => span.start <= item.start && item.end <= span.end);
    requireGuard(selected.length >= 3);
    const opening = selected[0],
      definition = selected[1],
      closing = selected.at(-1);
    requireGuard(opening.kind === "ifndef" && opening.start === span.start);
    requireGuard(definition.kind === "define" && definition.start === opening.end);
    requireGuard(closing?.kind === "endif" && closing.end === span.end);
    requireGuard(
      selected.every(
        (item) =>
          !(["else", "elif"].includes(item.kind) && item.depth === opening.depth + 1) &&
          !(item.kind === "pragma" && item.argument === "once"),
      ),
    );
    for (const [item, pattern] of [
      [opening, new RegExp(`^[ \\t]*#[ \\t]*ifndef[ \\t]+${guard}[ \\t]*(?:\\r?\\n|$)$`)],
      [definition, new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+${guard}[ \\t]*(?:\\r?\\n|$)$`)],
      [closing, /^[ \t]*#[ \t]*endif[ \t]*(?:\r?\n|$)$/],
    ]) {
      const removed = source.slice(item.start, item.end);
      requireGuard(pattern.test(removed));
      edits.push({ start: item.start, afterStart: 0, removed, file });
    }
  }
  edits.sort((left, right) => left.start - right.start);
  let next = "",
    cursor = 0,
    removedLength = 0;
  for (const edit of edits) {
    requireGuard(cursor <= edit.start);
    next += source.slice(cursor, edit.start);
    edit.afterStart = edit.start - removedLength;
    removedLength += edit.removed.length;
    cursor = edit.start + edit.removed.length;
  }
  next += source.slice(cursor);
  const result = { ...tree, "main.cpp": next };
  return {
    tree: result,
    record: {
      kind: "project-header-guards",
      headers: registered,
      before: treeIdentity(tree),
      after: treeIdentity(result),
      edits,
    },
  };
}

/** Restore directive scaffolding and prove it exactly replays the guarded transformation. */
export function restoreProjectGuards(tree, record) {
  requireGuard(record !== null && typeof record === "object" && !Array.isArray(record));
  requireGuard(record.kind === "project-header-guards" && Array.isArray(record.edits));
  assert.equal(treeIdentity(tree), record.after);
  let source = tree["main.cpp"];
  requireGuard(typeof source === "string");
  for (const edit of [...record.edits].reverse()) {
    requireGuard(
      Number.isSafeInteger(edit.afterStart) &&
        0 <= edit.afterStart &&
        edit.afterStart <= source.length &&
        typeof edit.removed === "string" &&
        edit.removed.length > 0,
    );
    source = source.slice(0, edit.afterStart) + edit.removed + source.slice(edit.afterStart);
  }
  const restored = { ...tree, "main.cpp": source };
  assert.equal(treeIdentity(restored), record.before);
  const replay = stripProjectGuards(restored, record.headers);
  assert.deepEqual(replay.record, record);
  assert.deepEqual(replay.tree, tree);
  return restored;
}
