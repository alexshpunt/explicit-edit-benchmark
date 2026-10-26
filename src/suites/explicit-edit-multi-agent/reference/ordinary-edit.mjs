import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

// Put lexical pieces, including all original whitespace, on separate diff lines.
// A normal three-way text merge can then preserve a peer's different identifier
// on the same C++ line. There is no shared service, lock or conditional commit.
function lines(source) {
  const pieces = [];
  let cursor = 0;
  for (const token of cppTokens(source)) {
    if (cursor < token.start) pieces.push(source.slice(cursor, token.start));
    pieces.push(source.slice(token.start, token.end));
    cursor = token.end;
  }
  if (cursor < source.length) pieces.push(source.slice(cursor));
  return pieces.map((piece) => JSON.stringify(piece) + "\n").join("");
}

// A compiler rename changes identifier tokens, not their punctuation or literals.
// Retain those selected token positions only while the complete lexical skeleton
// still matches. Other identifier renames are preserved; changed structure or an
// unknown spelling at an owned site takes the ordinary conflicting merge path.
function nameChanges(before, after) {
  const previous = cppTokens(before),
    next = cppTokens(after);
  if (previous.length !== next.length) return undefined;
  const changes = [];
  for (const [index, token] of previous.entries()) {
    if (token.text === next[index].text) continue;
    if (!/^[A-Za-z_]\w*$/.test(token.text) || !/^[A-Za-z_]\w*$/.test(next[index].text))
      return undefined;
    changes.push({ index, old: token.text, next: next[index].text });
  }
  if (!changes.length) return undefined;
  let projected = before;
  for (const change of [...changes].reverse()) {
    const token = previous[change.index];
    projected = projected.slice(0, token.start) + change.next + projected.slice(token.end);
  }
  return projected === after ? { source: before, previous, changes } : undefined;
}
function alignedNames(current, names) {
  if (!names) return undefined;
  const tokens = cppTokens(current);
  if (tokens.length !== names.previous.length) return undefined;
  let previousEnd = 0,
    currentEnd = 0;
  for (const [index, token] of tokens.entries()) {
    const previous = names.previous[index];
    // The lexer omits punctuation, numbers and layout. Compare every raw gap
    // as well, so a changed expression or directive cannot reuse old sites.
    if (current.slice(currentEnd, token.start) !== names.source.slice(previousEnd, previous.start))
      return undefined;
    previousEnd = previous.end;
    currentEnd = token.end;
    if (
      token.text !== previous.text &&
      (!/^[A-Za-z_]\w*$/.test(token.text) || !/^[A-Za-z_]\w*$/.test(previous.text))
    )
      return undefined;
  }
  if (current.slice(currentEnd) !== names.source.slice(previousEnd)) return undefined;
  for (const change of names.changes)
    if (![change.old, change.next].includes(tokens[change.index].text)) return undefined;
  let result = current;
  for (const change of [...names.changes].reverse()) {
    const token = tokens[change.index];
    result = result.slice(0, token.start) + change.next + result.slice(token.end);
  }
  return result;
}
// Precompute our own patch before the latest shared-file read. Most moves and
// prototype removals are one unique region; renames retain their selected sites.
function replacement(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length,
    nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const previous = before.slice(start, end);
  return {
    previous,
    unique: previous.length > 0 && before.indexOf(previous) === before.lastIndexOf(previous),
    next: after.slice(start, nextEnd),
    append: start === before.length && before.length > 0,
    names: nameChanges(before, after),
  };
}
function merge(before, after, current, directory, change) {
  if (current === before || current === after) return after;
  // Rejected identifier sites cannot fall through to an unrestricted character
  // replacement or textual merge: neither can establish their current binding.
  if (change.names) return alignedNames(current, change.names);
  if (change.unique) {
    const offset = current.indexOf(change.previous);
    if (offset >= 0 && current.indexOf(change.previous, offset + 1) < 0)
      return (
        current.slice(0, offset) + change.next + current.slice(offset + change.previous.length)
      );
  } else if (change.append && current.startsWith(before)) {
    return current.includes(change.next) ? current : current + change.next;
  }
  const files = [after, before, current].map((source, index) => {
    const file = path.join(directory, String(index));
    writeFileSync(file, lines(source));
    return file;
  });
  try {
    const result = execFileSync("diff3", ["-m", ...files], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    return result
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .join("");
  } catch (error) {
    if (error.status === 1) return undefined;
    throw error;
  }
}

/** Project only this actor's retained edits into its private planning buffer.
 * This never reads or writes shared source and grants no publication protection.
 */
export function projectEdits(before, after, current) {
  const directory = mkdtempSync(path.join(tmpdir(), "reference-projection-"));
  const result = { ...current };
  try {
    for (const file of Object.keys(after)) {
      if (before[file] === after[file]) continue;
      const next = merge(
        before[file] ?? "",
        after[file],
        current[file] ?? "",
        directory,
        replacement(before[file] ?? "", after[file]),
      );
      if (next === undefined) throw Error("Retained edit conflicts with private planning buffer");
      result[file] = next;
    }
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
// Use ordinary inherited-descriptor flock, available to a Bash participant.
// An existing file's inode protects its read/apply/rename operation. A waiter
// that opened an older inode must reopen after a peer's atomic replacement.
// Creation briefly protects the parent directory and rechecks absence. No lock
// files, editor service or protection during planning are needed.
function atomicFileEdit(target, edit) {
  mkdirSync(path.dirname(target), { recursive: true });
  for (;;) {
    let descriptor,
      missing = false;
    try {
      descriptor = openSync(target, "r");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      descriptor = openSync(path.dirname(target), "r");
      missing = true;
    }
    try {
      execFileSync("/usr/bin/flock", ["--exclusive", "3"], {
        stdio: ["ignore", "ignore", "pipe", descriptor],
      });
      let current;
      try {
        current = statSync(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (missing) {
        if (current) continue;
      } else {
        const opened = fstatSync(descriptor);
        if (!current || opened.dev !== current.dev || opened.ino !== current.ino) continue;
        if (!opened.isFile()) throw Error("Nonregular atomic edit target");
      }
      return edit(missing ? undefined : descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
/** Apply one file patch atomically using ordinary Bash-accessible file locks.
 * Each actor plans independently. Only its latest read, patch merge and atomic
 * replacement share a short per-file critical section. Other files remain
 * writable and multi-file intermediate states remain visible. Uncooperative
 * direct writes do not participate in this protocol and are not protected.
 */
export function publishEdits(workspace, before, after, { onEvent = () => {} } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "reference-merge-"));
  const conflicts = [];
  const written = [];
  try {
    for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[file] === after[file]) continue;
      if (
        !/^[A-Za-z0-9_./-]+\.(?:cpp|h)$/.test(file) ||
        file.startsWith("/") ||
        file.split("/").includes("..")
      )
        throw Error("Unsafe reference edit path");
      if (after[file] === undefined) throw Error("Reference task cannot delete source files");
      const target = path.join(workspace, file);
      const change = replacement(before[file] ?? "", after[file]);
      onEvent("publish-ready", file);
      atomicFileEdit(target, (descriptor) => {
        onEvent("read-start", file);
        const current = descriptor === undefined ? "" : readFileSync(descriptor, "utf8");
        onEvent("read-end", file);
        const next = merge(before[file] ?? "", after[file], current, directory, change);
        if (next === undefined) {
          conflicts.push(file);
          return;
        }
        if (next === current) return;
        onEvent("write-start", file);
        const temporary = path.join(
          path.dirname(target),
          `.${path.basename(target)}.${randomUUID()}.tmp`,
        );
        try {
          writeFileSync(temporary, next, { flag: "wx" });
          renameSync(temporary, target);
        } finally {
          rmSync(temporary, { force: true });
        }
        onEvent("write-end", file);
        written.push(file);
      });
    }
    return { written, conflicts };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
