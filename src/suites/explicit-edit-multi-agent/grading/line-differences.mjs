import { createHash } from "node:crypto";
import { diffArrays } from "diff";

export const LINE_DIFFERENCE_POLICY = Object.freeze({
  version: "renderer-line-differences-v1",
  lines: "trailing-whitespace-removed-blank-lines-ignored",
  diff: "myers-per-file",
  presence: "one-line-per-file",
  bytes: "one-line-per-non-utf8-file",
  weight: 1,
});

const hash = (value) => createHash("sha256").update(value).digest("hex");
const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
/** Private marker for a file's presence; it never appears in agent-facing text. */
const PRESENCE = "\u0000file";
const CONTEXT = 3;

/** Comparable lines of one file with their 1-based physical line numbers. */
function fileLines(content) {
  if (Buffer.isBuffer(content)) {
    const text = content.toString("utf8");
    if (!Buffer.from(text).equals(content))
      return [
        { text: PRESENCE, line: 0, kind: "file" },
        {
          text: `${content.length} bytes, SHA-256 ${hash(content)}`,
          line: 1,
          kind: "bytes",
        },
      ];
    content = text;
  }
  if (typeof content !== "string") throw new TypeError("Tree contents must be text or bytes");
  const lines = [{ text: PRESENCE, line: 0, kind: "file" }];
  for (const [index, raw] of content.split("\n").entries()) {
    const text = raw.trimEnd();
    if (text) lines.push({ text, line: index + 1, kind: "line" });
  }
  return lines;
}

function normalizeTree(tree) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree))
    throw new TypeError("Line comparison input must be a source tree");
  const files = new Map();
  for (const file of Object.keys(tree).sort(order)) files.set(file, fileLines(tree[file]));
  const identity = hash(
    JSON.stringify([...files].map(([file, lines]) => [file, lines.map(({ text }) => text)])),
  );
  return { files, identity };
}

/** Diff every file of a candidate against the reference: changed hunks and their lines. */
function compareTrees(reference, candidate) {
  const hunks = [];
  const files = [...new Set([...reference.files.keys(), ...candidate.files.keys()])].sort(order);
  for (const file of files) {
    const have = candidate.files.get(file) ?? [];
    const want = reference.files.get(file) ?? [];
    const parts = diffArrays(
      have.map(({ text }) => text),
      want.map(({ text }) => text),
    );
    let at = 0,
      wanted = 0,
      current = null;
    const close = () => {
      if (!current) return;
      current.after = have.slice(at, at + 1).map(({ text, line }) => ({ text, line }));
      hunks.push(current);
      current = null;
    };
    for (const part of parts) {
      const count = part.value.length;
      if (!part.added && !part.removed) {
        close();
        at += count;
        wanted += count;
        continue;
      }
      current ??= {
        file,
        line: have[at]?.line ?? (have.at(-1)?.line ?? 0) + 1,
        before: have
          .slice(Math.max(0, at - CONTEXT), at)
          .filter(({ kind }) => kind === "line")
          .map(({ text, line }) => ({ text, line })),
        remove: [],
        add: [],
      };
      if (part.removed) {
        current.remove.push(...have.slice(at, at + count));
        at += count;
      } else {
        current.add.push(...want.slice(wanted, wanted + count));
        wanted += count;
      }
    }
    close();
  }
  return hunks;
}

function differencesOf(hunks, extraUnits) {
  const copies = new Map();
  const differences = [];
  const add = (kind, action, unit, hunk) => {
    const key = `${kind}:${hash(`${unit.file}\u0000${unit.kind}\u0000${unit.text}`)}`;
    const copy = (copies.get(key) ?? 0) + 1;
    copies.set(key, copy);
    const id = `${key}:${copy}`;
    differences.push({ id, kind, action, unit, hunk });
    return id;
  };
  hunks.forEach((hunk, index) => {
    hunk.differenceIds = [
      ...hunk.remove.map(({ text, kind }) =>
        add("extra-line", "remove", { file: hunk.file, kind, text }, index),
      ),
      ...hunk.add.map(({ text, kind }) =>
        add("missing-line", "add", { file: hunk.file, kind, text }, index),
      ),
    ];
  });
  for (const unit of extraUnits) add("unexpected-entry", "remove", unit, null);
  return differences;
}

function comparison(prepared, candidate, extraUnits) {
  const hunks = compareTrees(prepared.reference, candidate);
  const differences = differencesOf(hunks, extraUnits);
  return {
    version: LINE_DIFFERENCE_POLICY.version,
    policy: LINE_DIFFERENCE_POLICY,
    startIdentity: prepared.startIdentity,
    referenceIdentity: prepared.referenceIdentity,
    actualIdentity: candidate.identity,
    totalUnits: prepared.totalUnits,
    differences,
    differenceIds: differences.map(({ id }) => id),
    hunks,
    files: [...new Set(differences.map(({ unit }) => unit.file))].sort(order),
  };
}

/** Trusted preparation: N is the line difference from the trusted start to the endpoint. */
export function prepareLineDifferences(startTree, referenceTree) {
  const start = normalizeTree(startTree);
  const reference = normalizeTree(referenceTree);
  const prepared = {
    version: LINE_DIFFERENCE_POLICY.version,
    policy: LINE_DIFFERENCE_POLICY,
    startIdentity: start.identity,
    referenceIdentity: reference.identity,
    reference,
    totalUnits: 0,
  };
  prepared.totalUnits = comparison(prepared, start, []).differences.length;
  if (!prepared.totalUnits)
    throw Object.assign(new Error("The round has no observable reference line changes"), {
      code: "LINE_DIFFERENCES_EMPTY_REFERENCE",
    });
  return Object.freeze(prepared);
}

/** Any candidate content is accepted; non-regular entries are supplied as extra units. */
export function compareLineDifferences(prepared, candidateTree, { extraUnits = [] } = {}) {
  return comparison(prepared, normalizeTree(candidateTree), extraUnits);
}

export const LINE_PRESENCE = PRESENCE;
