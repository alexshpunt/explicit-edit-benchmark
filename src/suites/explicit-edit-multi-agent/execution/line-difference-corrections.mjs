import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const LINE_DIFFERENCE_CORRECTION_POLICY = Object.freeze({
  version: "renderer-line-difference-corrections-v1",
  grouping: "one-file-per-assignment",
  item: "one-changed-hunk-with-surrounding-lines",
  maximumItems: 20,
  maximumBytes: 12_000,
});

const hash = (value) => createHash("sha256").update(value).digest("hex");

export function block(lines) {
  const text = lines.join("\n");
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}\n${text}\n${fence}`;
}

export const code = (line) => {
  let tick = "`";
  while (line.includes(tick)) tick += "`";
  return `${tick}${line.startsWith("`") || line.endsWith("`") ? ` ${line} ` : line}${tick}`;
};

function place(hunk) {
  const where = hunk.before.length
    ? `Around line ${hunk.line} of the file at the time of the check, right after these lines:\n${block(hunk.before.map(({ text }) => text))}`
    : `At the beginning of the file${hunk.after.length ? `, before the line ${code(hunk.after[0].text)}` : ""}:`;
  const until =
    hunk.before.length && hunk.after.length
      ? `\nThe line that follows this place is ${code(hunk.after[0].text)}.`
      : "";
  return where + until;
}

function contentLines(lines) {
  return lines.filter(({ kind }) => kind === "line").map(({ text }) => text);
}

/** One numbered prose item for a changed hunk: where it is and which lines change. */
export function hunkProse(hunk, number) {
  const removed = contentLines(hunk.remove);
  const added = contentLines(hunk.add);
  const bytes = [...hunk.remove, ...hunk.add].filter(({ kind }) => kind === "bytes");
  const parts = [];
  if (bytes.length)
    parts.push(
      `The file content is not UTF-8 text. ${hunk.add.some(({ kind }) => kind === "bytes") ? `It must have the specific content described as ${bytes.at(-1).text}; restore that exact content.` : "Replace it with the required text."}`,
    );
  if (removed.length && added.length)
    parts.push(
      `${place(hunk)}\nRemove these lines:\n${block(removed)}\nand put these lines in their place:\n${block(added)}`,
    );
  else if (removed.length) parts.push(`${place(hunk)}\nRemove these lines:\n${block(removed)}`);
  else if (added.length) parts.push(`${place(hunk)}\nAdd these lines:\n${block(added)}`);
  return parts.length ? `${number}. ${parts.join("\n")}` : "";
}

function heading(file, part, parts) {
  return [
    `Correct the project file ${file}${parts > 1 ? ` (part ${part} of ${parts})` : ""}.`,
    "A line-by-line comparison with the required result found the differences listed below. Blank lines and spaces at the end of a line are not compared; everything else, including indentation and order, must match exactly.",
    "Inspect the current file before editing; line numbers may have shifted. Make only these changes and keep all other lines unchanged. Other participants may be editing the project at the same time.",
  ].join("\n\n");
}

/** Prose assignments that describe every differing hunk of a comparison, grouped by file. */
export function lineDifferenceCorrections(prepared, comparison) {
  assert.equal(comparison.startIdentity, prepared.startIdentity);
  assert.equal(comparison.referenceIdentity, prepared.referenceIdentity);
  const assignments = [];
  const byFile = new Map();
  for (const hunk of comparison.hunks) {
    if (!byFile.has(hunk.file)) byFile.set(hunk.file, []);
    byFile.get(hunk.file).push(hunk);
  }
  const files = new Set([...byFile.keys()]);
  for (const difference of comparison.differences)
    if (difference.kind === "unexpected-entry") files.add(difference.unit.file);
  for (const file of [...files].sort()) {
    const hunks = byFile.get(file) ?? [];
    const entries = comparison.differences.filter(
      (difference) => difference.kind === "unexpected-entry" && difference.unit.file === file,
    );
    const exists = (prepared.reference.files.get(file) ?? []).length > 0;
    const created = hunks.some((hunk) => hunk.add.some(({ kind }) => kind === "file"));
    const deleted = hunks.some((hunk) => hunk.remove.some(({ kind }) => kind === "file"));
    const ids = [...hunks.flatMap((hunk) => hunk.differenceIds), ...entries.map(({ id }) => id)];
    const id = (index) => `lines-${hash(file).slice(0, 16)}-${index}`;
    if (entries.length) {
      assignments.push({
        id: id(1),
        file,
        differenceIds: ids,
        prompt: `The path ${file} must not be a ${entries[0].unit.text}. Remove that entry${exists ? ` and create ${file} as a regular file with its required content` : ""}. Make no other changes.`,
      });
      continue;
    }
    if (deleted && !exists) {
      assignments.push({
        id: id(1),
        file,
        differenceIds: ids,
        prompt: `Delete the file ${file}. The required result has no such file. Make no other changes; other participants may be editing the project at the same time.`,
      });
      continue;
    }
    if (created) {
      const lines = contentLines(hunks.flatMap((hunk) => hunk.add));
      assignments.push({
        id: id(1),
        file,
        differenceIds: ids,
        prompt: `Create the project file ${file}, which does not exist yet, with exactly these lines in this order. Blank lines and spaces at the end of a line are not compared.\n\n${block(lines)}`,
      });
      continue;
    }
    const groups = [];
    let current = [],
      bytes = 0;
    for (const hunk of hunks) {
      const size = Buffer.byteLength(hunkProse(hunk, 0));
      if (
        current.length &&
        (current.length >= LINE_DIFFERENCE_CORRECTION_POLICY.maximumItems ||
          bytes + size > LINE_DIFFERENCE_CORRECTION_POLICY.maximumBytes)
      ) {
        groups.push(current);
        current = [];
        bytes = 0;
      }
      current.push(hunk);
      bytes += size;
    }
    if (current.length) groups.push(current);
    groups.forEach((members, index) => {
      assignments.push({
        id: id(index + 1),
        file,
        differenceIds: members.flatMap((hunk) => hunk.differenceIds),
        prompt: [
          heading(file, index + 1, groups.length),
          ...members.map((hunk, number) => hunkProse(hunk, number + 1)).filter(Boolean),
        ].join("\n\n"),
      });
    });
  }
  return assignments;
}
