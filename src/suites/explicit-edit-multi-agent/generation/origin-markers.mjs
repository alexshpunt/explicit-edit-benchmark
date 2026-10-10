import { createHash } from "node:crypto";
import { cppTokens, treeIdentity } from "./generator.mjs";

/** Neutral five-letter words keep physical token spans and line splices unchanged. */
export const originVocabulary = {
  version: "renderer-origin-v1",
  names: [
    "nacre",
    "sedge",
    "copse",
    "bract",
    "whorl",
    "loess",
    "scree",
    "sprig",
    "glade",
    "heath",
    "bough",
    "frond",
    "grove",
    "knoll",
    "shale",
    "flint",
  ],
};
/** Map fixture source paths to the same neutral identity as its namespace and guards. */
export function neutralSourcePath(file, name) {
  if (!originVocabulary.names.includes(name)) throw new Error("Unknown neutral project name");
  return file.replace(/(^|\/)yocto_/g, `$1${name}_`);
}

/** Rename project files and their quoted include directives, leaving other literals untouched. */
export function neutralFiles(tree, name) {
  const result = {};
  for (const [file, source] of Object.entries(tree)) {
    const target = neutralSourcePath(file, name);
    if (Object.hasOwn(result, target)) throw new Error("Neutral source path collision");
    let text = "",
      cursor = 0;
    for (const token of cppTokens(source)) {
      if (!token.text.startsWith('"') || !token.text.endsWith('"')) continue;
      const prefix = source.slice(0, token.start);
      if (!/(?:^|\n)[ \t]*#[ \t]*include[ \t]*(?:\\\r?\n[ \t]*)*$/.test(prefix)) continue;
      const include = token.text.slice(1, -1);
      const replacement = neutralSourcePath(include, name);
      if (replacement === include) continue;
      text += source.slice(cursor, token.start) + `"${replacement}"`;
      cursor = token.end;
    }
    result[target] = text + source.slice(cursor);
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Reject origin clues in any agent-visible source path or source text, including inactive code. */
export function assertNeutralSource(file, source) {
  if (/yocto/i.test(file) || /yocto/i.test(source.replace(/\\\r?\n/g, "")))
    throw new Error("Original project origin is exposed");
}
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
const replacement = (token, name) =>
  token === "yocto"
    ? name
    : /^_?YOCTO_[A-Z0-9_]+$/.test(token)
      ? token.replace("YOCTO", name.toUpperCase())
      : token;

function applyEdits(source, edits, inverse = false) {
  let boundary = source.length;
  for (const edit of [...edits].reverse()) {
    const from = inverse ? edit.new : edit.old;
    const to = inverse ? edit.old : edit.new;
    if (
      !Number.isInteger(edit.start) ||
      edit.start < 0 ||
      edit.start + from.length > boundary ||
      source.slice(edit.start, edit.start + from.length) !== from
    ) {
      throw new Error("Origin token span does not match");
    }
    source = source.slice(0, edit.start) + to + source.slice(edit.start + from.length);
    boundary = edit.start;
  }
  return source;
}

/** Replace only the fixture's Yocto namespace/macro tokens with a deterministic, collision-free dictionary name. */
export function maskOrigin(tree, { seed = "renderer-origin-v1", name: fixedName } = {}) {
  if (Object.keys(tree).length !== 1 || typeof tree["main.cpp"] !== "string")
    throw new Error("Origin masking requires only main.cpp");
  const source = tree["main.cpp"];
  let logical = "";
  const positions = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\" && /^\r?\n/.test(source.slice(index + 1))) {
      index += source[index + 1] === "\r" ? 2 : 1;
      continue;
    }
    positions.push(index);
    logical += source[index];
  }
  const tokens = cppTokens(logical).filter((token) => identifier.test(token.text));
  const occupied = new Set(tokens.map((token) => token.text));
  const marked = tokens.filter((token) => replacement(token.text, "nacre") !== token.text);
  const offset = createHash("sha256")
    .update(originVocabulary.version + ":" + seed)
    .digest()
    .readUInt32BE(0);
  if (fixedName !== undefined && !originVocabulary.names.includes(fixedName))
    throw new Error("Unknown fixed origin name");
  const candidates = fixedName
    ? [fixedName]
    : originVocabulary.names.map(
        (_, index) => originVocabulary.names[(offset + index) % originVocabulary.names.length],
      );
  let name;
  for (const candidate of candidates) {
    if (
      !occupied.has(candidate) &&
      marked.every((token) => !occupied.has(replacement(token.text, candidate)))
    ) {
      name = candidate;
      break;
    }
  }
  if (!name) throw new Error("No collision-free origin dictionary name");
  const edits = marked.map((token) => {
    const start = positions[token.start];
    const end = positions[token.end - 1] + 1;
    const spelling = replacement(token.text, name);
    let changed = "",
      cursor = start;
    for (let index = 0; index < spelling.length; index++) {
      const physical = positions[token.start + index];
      changed += source.slice(cursor, physical) + spelling[index];
      cursor = physical + 1;
    }
    return { start, old: source.slice(start, end), new: changed };
  });
  const next = { "main.cpp": applyEdits(source, edits) };
  return {
    tree: next,
    record: {
      kind: "origin-markers",
      vocabulary: originVocabulary.version,
      seed,
      name,
      before: treeIdentity(tree),
      after: treeIdentity(next),
      edits,
    },
  };
}

/** Restore namespace and macro spelling from guarded token edits, never from saved source bodies. */
export function restoreOrigin(tree, record) {
  if (record.kind !== "origin-markers" || treeIdentity(tree) !== record.after)
    throw new Error("Origin-masked tree identity does not match");
  const restored = { "main.cpp": applyEdits(tree["main.cpp"], record.edits, true) };
  if (treeIdentity(restored) !== record.before)
    throw new Error("Restored origin tree identity does not match");
  return restored;
}
