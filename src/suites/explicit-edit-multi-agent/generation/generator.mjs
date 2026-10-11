import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
export { cppTokens } from "../cpp/cpp-tokens.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const ordered = (tree) =>
  Object.fromEntries(Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Identify a source tree by its relative file names and exact UTF-8 contents. */
export function treeIdentity(tree) {
  return digest(JSON.stringify(ordered(tree)));
}

/** Remove comments and outer whitespace, keeping one internal gap and required token/directive separators. */
export function stripComments(text) {
  let logical = "";
  const positions = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && /^\r?\n/.test(text.slice(index + 1))) {
      index += text[index + 1] === "\r" ? 2 : 1;
      continue;
    }
    positions.push(index);
    logical += text[index];
  }
  const parts = [];
  const comments = [];
  let cursor = 0,
    length = 0;
  for (const token of cppTokens(logical)) {
    if (!token.text.startsWith("//") && !token.text.startsWith("/*")) continue;
    const start = positions[token.start];
    const end = positions[token.end - 1] + 1;
    const prefix = text.slice(cursor, start);
    parts.push(prefix, " ");
    length += prefix.length;
    comments.push(length++);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  const prepared = parts.join("");
  const lines = [];
  let commentIndex = 0,
    continued = false;
  for (const line of prepared.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const start = line.index,
      end = start + line[0].length;
    while (commentIndex < comments.length && comments[commentIndex] < start) commentIndex++;
    const commentOnly =
      commentIndex < comments.length &&
      comments[commentIndex] < end &&
      /^[ \t\r]*(?:\n|$)$/.test(line[0]);
    // Keep a terminating newline after a spliced line, especially in a macro.
    if (!commentOnly || continued) lines.push(line[0]);
    continued = /\\\r?\n$/.test(line[0]);
  }
  const compacted = compactBlankLines({ "main.cpp": lines.join("") }).tree["main.cpp"].trimStart();
  const trimmed = compacted.trimEnd();
  if (!trimmed.endsWith("\\")) return trimmed;
  // A final backslash may splice the next newline; keep the following line terminator.
  const trailing = compacted.slice(trimmed.length);
  const terminator = trailing.match(/^(?:[ \t]*\r?\n)?[^\n]*\n/);
  return trimmed + (terminator ? terminator[0] : trailing);
}

/** Prepare the comment-free canonical project; keep notices and metadata outside its payload. */
export function prepareTree(tree) {
  return ordered(
    Object.fromEntries(
      Object.entries(tree)
        .filter(([name]) => /\.(cpp|h)$/.test(name))
        .map(([name, text]) => [name, stripComments(text)]),
    ),
  );
}
/** Keep one internal blank code line and no blank edge lines, preserving literals and directives. */
export function compactBlankLines(tree) {
  validatePaths(tree);
  const source = tree["main.cpp"];
  if (typeof source !== "string") throw new Error("Missing monolith: main.cpp");
  const firstCode = source.search(/[^ \t\r\n]/);
  const lastCode = source.length - source.match(/[ \t\r\n]*$/)[0].length;
  const ranges = cppTokens(source).filter((token) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(token.text));
  for (const directive of source.matchAll(/^[ \t]*#(?:[^\n\\]|\\(?:\r?\n|[^\r\n]))*(?:\r?\n|$)/gm))
    ranges.push({
      start: directive.index,
      end: directive.index + directive[0].length,
      text: directive[0],
    });
  const protectedRanges = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const previous = protectedRanges.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else protectedRanges.push({ start: range.start, end: range.end });
  }
  const edits = [];
  let blank = 0,
    protectedIndex = 0;
  for (const line of source.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const start = line.index,
      end = start + line[0].length;
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex].end <= start)
      protectedIndex++;
    const protectedLine =
      protectedIndex < protectedRanges.length && protectedRanges[protectedIndex].start < end;
    if (protectedLine || !/^[ \t\r]*(?:\n|$)$/.test(line[0])) {
      blank = 0;
      continue;
    }
    if (++blank <= 1 && start >= firstCode && end <= lastCode) continue;
    const previous = edits.at(-1);
    if (previous && previous.start + previous.removed.length === start) previous.removed += line[0];
    else edits.push({ start, afterStart: 0, removed: line[0] });
  }
  const parts = [];
  let cursor = 0,
    removedLength = 0;
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start));
    edit.afterStart = edit.start - removedLength;
    removedLength += edit.removed.length;
    cursor = edit.start + edit.removed.length;
  }
  parts.push(source.slice(cursor));
  const next = { ...tree, "main.cpp": parts.join("") };
  return {
    tree: next,
    record: { kind: "compact", before: treeIdentity(tree), after: treeIdentity(next), edits },
  };
}

/** Restore trimmed whitespace after checking the exact compacted tree identity. */
export function restoreBlankLines(tree, record) {
  if (record.kind !== "compact" || treeIdentity(tree) !== record.after)
    throw new Error("Compacted tree identity does not match");
  let source = tree["main.cpp"];
  for (const edit of [...record.edits].reverse()) {
    if (!/^[ \t\r\n]+$/.test(edit.removed))
      throw new Error("Compaction record contains non-whitespace");
    source = source.slice(0, edit.afterStart) + edit.removed + source.slice(edit.afterStart);
  }
  const restored = { ...tree, "main.cpp": source };
  if (treeIdentity(restored) !== record.before)
    throw new Error("Restored tree identity does not match");
  return restored;
}
function rename(text, names) {
  const replacements = cppTokens(text).filter((token) => Object.hasOwn(names, token.text));
  for (const token of replacements.reverse()) {
    text = text.slice(0, token.start) + names[token.text] + text.slice(token.end);
  }
  return text;
}

function includeSites(text, source, owner = "main.cpp") {
  const protectedTokens = cppTokens(text).filter(
    (token) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(token.text),
  );
  return [...text.matchAll(/^[ \t]*#include[ \t]+["<]([^">\n]+)[">][ \t]*(?:\r?\n|$)/gm)]
    .filter(
      (match) =>
        (path.posix.normalize(path.posix.join(path.posix.dirname(owner), match[1])) === source ||
          `support/${match[1]}` === source ||
          match[1] === source) &&
        !protectedTokens.some((token) => token.start <= match.index && match.index < token.end),
    )
    .map((match) => ({ start: match.index, removed: match[0] }));
}

function validatePaths(tree) {
  for (const name of Object.keys(tree)) {
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => part === ".." || part === "" || part === ".")
    ) {
      throw new Error(`Unsafe source path: ${name}`);
    }
    if (typeof tree[name] !== "string") throw new Error(`Source is not UTF-8 text: ${name}`);
  }
}

/** Pack one file into a target without changing the input tree. Return source-free inverse metadata. */
export function pack(tree, operation) {
  validatePaths(tree);
  const { kind, source, target, renames = {} } = operation;
  if (source === target || !Object.hasOwn(tree, source))
    throw new Error(`Missing or invalid source: ${source}`);
  if (!Object.hasOwn(tree, target)) throw new Error(`Missing target: ${target}`);
  if (kind !== "append" && kind !== "include")
    throw new Error(`Unknown packing operation: ${kind}`);
  const original = tree[source];
  const values = Object.values(renames);
  if (
    new Set(values).size !== values.length ||
    Object.keys(renames).some((name) => values.includes(name))
  ) {
    throw new Error("Helper renames must be one-to-one and disjoint");
  }
  for (const name of [...Object.keys(renames), ...values]) {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error(`Invalid helper name: ${name}`);
  }
  if (cppTokens(original).some((token) => values.includes(token.text)))
    throw new Error("Helper rename would collide");
  const payload = rename(original, renames);
  const sites =
    kind === "append"
      ? [{ start: tree[target].length, removed: "" }]
      : includeSites(tree[target], source, target);
  if (kind === "include") {
    for (const [name, text] of Object.entries(tree)) {
      if (name !== source && name !== target && includeSites(text, source, name).length) {
        throw new Error(`${source} is still included by ${name}`);
      }
    }
  }
  if (!sites.length) throw new Error(`No include site for ${source}`);
  let targetText = "";
  let cursor = 0;
  const edits = [];
  let sourceStart = 0;
  for (const [index, site] of sites.entries()) {
    targetText += tree[target].slice(cursor, site.start);
    const inserted =
      index === 0 || operation.repeat
        ? kind === "append"
          ? `\n${payload}\n`
          : `${payload}${payload.endsWith("\n") ? "" : "\n"}`
        : "";
    if (index === 0) sourceStart = targetText.length + (kind === "append" ? 1 : 0);
    edits.push({
      start: targetText.length,
      removed: site.removed,
      insertedLength: inserted.length,
      insertedHash: digest(inserted),
    });
    targetText += inserted;
    cursor = site.start + site.removed.length;
  }
  targetText += tree[target].slice(cursor);
  const next = { ...tree, [target]: targetText };
  delete next[source];
  return {
    tree: ordered(next),
    record: {
      operation,
      before: treeIdentity(tree),
      after: treeIdentity(next),
      sourceHash: digest(original),
      sourceStart,
      sourceLength: payload.length,
      edits,
    },
  };
}

/** Reverse a packing step by extracting current bundled code, not by restoring a snapshot. */
export function unpack(tree, record) {
  if (treeIdentity(tree) !== record.after)
    throw new Error("Packed tree identity does not match the operation record");
  const { source, target, renames = {} } = record.operation;
  let text = tree[target];
  const payload = text.slice(record.sourceStart, record.sourceStart + record.sourceLength);
  const original = rename(
    payload,
    Object.fromEntries(Object.entries(renames).map(([a, b]) => [b, a])),
  );
  if (digest(original) !== record.sourceHash)
    throw new Error("Extracted source identity does not match");
  for (const edit of [...record.edits].reverse()) {
    const inserted = text.slice(edit.start, edit.start + edit.insertedLength);
    if (digest(inserted) !== edit.insertedHash)
      throw new Error("Packed span identity does not match");
    text = text.slice(0, edit.start) + edit.removed + text.slice(edit.start + edit.insertedLength);
  }
  const result = ordered({ ...tree, [target]: text, [source]: original });
  if (treeIdentity(result) !== record.before)
    throw new Error("Restored tree identity does not match");
  return result;
}

/** Plan deterministic implementation merges, then header inlining in dependency-safe order. */
export function packingPlan(tree) {
  const plan = [];
  let current = tree;
  const append = (operation) => {
    current = pack(current, operation).tree;
    plan.push(operation);
  };
  for (const source of Object.keys(tree)
    .filter((name) => name.endsWith(".cpp") && name !== "main.cpp")
    .sort(
      (a, b) => Number(a.includes("/")) - Number(b.includes("/")) || (a < b ? -1 : a > b ? 1 : 0),
    )) {
    append({
      kind: "append",
      source,
      target: "main.cpp",
      renames:
        source === "yocto_trace.cpp"
          ? { parallel_for: "trace_parallel_for" }
          : source === "yocto_shape.cpp"
            ? { split_middle: "shape_split_middle", bvh_max_prims: "shape_bvh_max_prims" }
            : {},
    });
  }
  while (Object.keys(current).some((name) => name.endsWith(".h"))) {
    const headers = Object.keys(current)
      .filter((name) => name.endsWith(".h"))
      .sort();
    const source = headers.find(
      (candidate) =>
        includeSites(current["main.cpp"], candidate).length &&
        headers.every(
          (other) => other === candidate || !includeSites(current[other], candidate, other).length,
        ),
    );
    if (!source) throw new Error("Headers cannot be packed in dependency-safe order");
    append({
      kind: "include",
      source,
      target: "main.cpp",
      ...(source.startsWith("support/") ? { repeat: true } : {}),
    });
  }
  return plan;
}

/** Read a fixture as a relative-path UTF-8 tree. Reject symlinks and non-file entries. */
export async function readTree(directory) {
  const tree = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(directory, name));
        const text = bytes.toString("utf8");
        if (!Buffer.from(text).equals(bytes)) throw new Error(`Source is not valid UTF-8: ${name}`);
        tree[name] = text;
      } else throw new Error(`Unsupported source entry: ${name}`);
    }
  }
  await visit("");
  return ordered(tree);
}

/** Write a source tree into a new, empty directory. Never overwrite an existing tree. */
export async function writeTree(directory, tree) {
  validatePaths(tree);
  await mkdir(directory, { recursive: false });
  for (const [name, text] of Object.entries(ordered(tree))) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text, { flag: "wx" });
  }
}
