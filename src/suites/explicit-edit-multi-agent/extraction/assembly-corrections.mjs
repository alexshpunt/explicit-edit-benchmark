import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  LINE_DIFFERENCE_CORRECTION_POLICY,
  block,
  code,
  hunkProse,
  lineDifferenceCorrections,
} from "../execution/line-difference-corrections.mjs";
import { describeNamed } from "./assembly-prose.mjs";

export const ASSEMBLY_CORRECTION_POLICY = Object.freeze({
  version: "renderer-assembly-corrections-v1",
  units: "named-units-and-blocks-described-by-problem-and-place",
  text: "only-when-no-exact-copy-exists-anywhere",
  otherLines: "changed-hunks-with-surrounding-lines",
  otherEntries: LINE_DIFFERENCE_CORRECTION_POLICY.version,
  grouping: "one-file-per-assignment",
  extraFiles: "moves-out-and-deletion-in-one-assignment",
  maximumItems: LINE_DIFFERENCE_CORRECTION_POLICY.maximumItems,
  maximumBytes: LINE_DIFFERENCE_CORRECTION_POLICY.maximumBytes,
});

const hash = (value) => createHash("sha256").update(value).digest("hex");
const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sentence = (text) => text[0].toUpperCase() + text.slice(1);

/** Compared lines of a text, as the line comparison sees them, with their offsets. */
function textLines(text) {
  const lines = [];
  let offset = 0;
  for (const [index, raw] of text.split("\n").entries()) {
    const trimmed = raw.trimEnd();
    if (trimmed)
      lines.push({ text: trimmed, line: index + 1, offset: offset + raw.length - raw.trimStart().length });
    offset += raw.length + 1;
  }
  return lines;
}

/** Reference lines of every region file, each owned by the unit it belongs to, if any. */
function referenceLayout(setup) {
  const files = new Map();
  for (const region of setup.regions) {
    let text = region.headerLines.map((line) => line + "\n").join("");
    const spans = [];
    let position = 0;
    const placed = region.items
      .map((item) => ({ item, at: region.body.indexOf(item.marker) }))
      .sort((left, right) => left.at - right.at);
    for (const { item, at } of placed) {
      assert.ok(at >= position, "Region placeholders are missing or out of order");
      text += region.body.slice(position, at);
      spans.push({ item, start: text.length, end: text.length + item.text.length });
      text += item.text;
      position = at + item.marker.length;
    }
    text += region.body.slice(position);
    assert.equal(text, setup.trees.final[region.file], "Region layout differs from the reference");
    const lines = textLines(text).map((line) => ({
      ...line,
      item: spans.find((span) => span.start <= line.offset && line.offset < span.end)?.item ?? null,
    }));
    files.set(region.file, lines);
  }
  const unitLines = new Map(),
    byLine = new Map(),
    firstAt = new Map(),
    starting = new Map();
  for (const [file, lines] of files) {
    byLine.set(file, new Map(lines.map((line) => [line.line, line])));
    lines.forEach((line, at) => {
      if (!line.item) return;
      if (!unitLines.has(line.item.id)) unitLines.set(line.item.id, []);
      unitLines.get(line.item.id).push(line.text);
      if (!firstAt.has(line.item.id)) firstAt.set(line.item.id, at);
    });
  }
  for (const [id, lines] of unitLines) {
    if (!starting.has(lines[0])) starting.set(lines[0], []);
    starting.get(lines[0]).push(id);
  }
  return { files, unitLines, byLine, firstAt, starting };
}

function describeUnit(item, lines) {
  if (item.kind === "named") return describeNamed(item.description);
  return lines.length === 1
    ? `the line ${code(lines[0])}`
    : `the block of ${lines.length} lines from ${code(lines[0])} to ${code(lines.at(-1))}`;
}

/** Every exact copy of a unit's lines in the candidate's text files. */
function occurrenceIndex(candidateTree) {
  const files = new Map();
  const starts = new Map();
  for (const file of Object.keys(candidateTree).sort(order)) {
    if (typeof candidateTree[file] !== "string") continue;
    const lines = textLines(candidateTree[file]);
    files.set(file, lines);
    lines.forEach(({ text }, index) => {
      if (!starts.has(text)) starts.set(text, []);
      starts.get(text).push({ file, index });
    });
  }
  const cache = new Map();
  return {
    files,
    find(lines) {
      const key = lines.join("\n");
      if (!cache.has(key))
        cache.set(
          key,
          (starts.get(lines[0]) ?? [])
            .filter(({ file, index }) =>
              lines.every((text, offset) => files.get(file)[index + offset]?.text === text),
            )
            .map(({ file, index }) => ({
              file,
              index,
              lines: files.get(file).slice(index, index + lines.length),
            })),
        );
      return cache.get(key);
    },
  };
}

/** Prose assignments for an assembly round: units are named by their problem and
 * place, never by their text, unless that text exists nowhere in the project.
 * Lines outside units, extra files and other entries are described as they are.
 */
export function assemblyCorrections(setup, prepared, comparison, candidateTree) {
  assert.equal(comparison.startIdentity, prepared.startIdentity);
  assert.equal(comparison.referenceIdentity, prepared.referenceIdentity);
  const layout = referenceLayout(setup);
  const index = occurrenceIndex(candidateTree);
  const special = new Set(
    comparison.differences
      .filter(({ kind, unit }) => kind === "unexpected-entry" || unit.kind === "bytes")
      .map(({ unit }) => unit.file),
  );
  const hunks = comparison.hunks.filter((hunk) => !special.has(hunk.file));

  // Units with a missing line where they belong, and the candidate lines to remove.
  const needs = new Map();
  const removed = new Map();
  const lineIds = new Map();
  for (const hunk of hunks) {
    const ids = hunk.differenceIds;
    hunk.remove.forEach((line, at) => {
      if (line.kind !== "line") return;
      lineIds.set(line, ids[at]);
      if (!removed.has(hunk.file)) removed.set(hunk.file, new Map());
      removed.get(hunk.file).set(line.line, ids[at]);
    });
    hunk.add.forEach((line, at) => {
      if (line.kind !== "line") return;
      const owner = layout.byLine.get(hunk.file)?.get(line.line)?.item;
      if (!owner) return;
      if (!needs.has(owner.id)) needs.set(owner.id, { item: owner, ids: [], hunks: new Set() });
      needs.get(owner.id).ids.push(ids[hunk.remove.length + at]);
      needs.get(owner.id).hunks.add(hunk);
    });
  }
  const extra = (occurrence) =>
    occurrence.lines.every(({ line }) => removed.get(occurrence.file)?.has(line));
  const claimed = new Set();
  const claim = (occurrence) => {
    for (const { line } of occurrence.lines) claimed.add(`${occurrence.file}:${line}`);
    return occurrence.lines.map(({ line }) => removed.get(occurrence.file).get(line));
  };
  const free = (occurrence) =>
    extra(occurrence) &&
    occurrence.lines.every(({ line }) => !claimed.has(`${occurrence.file}:${line}`));
  const covered = new Set(),
    created = new Set();

  const where = (occurrence) => {
    const lines = index.files.get(occurrence.file);
    const before = lines[occurrence.index - 1];
    return `around line ${occurrence.lines[0].line}${before ? `, after the line ${code(before.text)}` : ", at the beginning of the file"}`;
  };
  const place = (item) => {
    const lines = layout.files.get(item.file);
    const first = lines.findIndex((line) => line.item === item);
    const last = lines.findLastIndex((line) => line.item === item);
    const neighbour = (line) =>
      line.item
        ? describeUnit(line.item, layout.unitLines.get(line.item.id))
        : `the line ${code(line.text)}`;
    const after = lines[first - 1],
      before = lines[last + 1];
    return [
      after ? `after ${neighbour(after)}` : "at the beginning of the file",
      before ? `before ${neighbour(before)}` : "at the end of the file",
    ].join(" and ");
  };

  /** @type {Map<string, any[]>} */
  const entries = new Map();
  const add = (file, entry) => {
    if (!entries.has(file)) entries.set(file, []);
    entries.get(file).push(entry);
    for (const id of entry.differenceIds) covered.add(id);
  };
  const reference = (file) => (prepared.reference.files.get(file) ?? []).length > 0;

  // Destination order keeps the assignments stable and readable.
  const ordered = [...needs.values()].sort(
    (left, right) =>
      order(left.item.file, right.item.file) ||
      layout.firstAt.get(left.item.id) - layout.firstAt.get(right.item.id),
  );
  const items = new Map(setup.items.map((item) => [item.id, item]));
  const restores = [];
  for (const { item, ids, hunks: touched } of ordered) {
    const lines = layout.unitLines.get(item.id);
    const name = describeUnit(item, lines);
    const occurrences = index.find(lines);
    const source = occurrences.find(free);
    if (source) {
      const from =
        source.file === item.file ? `elsewhere in ${item.file}` : `in ${source.file}`;
      add(reference(source.file) ? item.file : source.file, {
        differenceIds: [...ids, ...claim(source)],
        prose: `${sentence(name)} belongs in ${item.file} ${place(item)}. It is currently ${from}, ${where(source)}. Move it there unchanged and remove it from its current place.`,
      });
    } else if (occurrences.length) {
      add(item.file, {
        differenceIds: ids,
        prose: `${sentence(name)} is missing from ${item.file}; it belongs ${place(item)}. An identical copy exists in ${occurrences[0].file}, ${where(occurrences[0])}, and stays where it is. Add another copy of it at the required place.`,
      });
    } else restores.push({ item, ids, touched, name, lines });
  }
  // Remaining exact copies of units in lines to remove are duplicates. An extra
  // file is deleted as a whole, so its copies need no separate removal.
  for (const [file, lines] of index.files) {
    if (!reference(file)) continue;
    for (const [at, line] of lines.entries()) {
      if (!removed.get(file)?.has(line.line) || claimed.has(`${file}:${line.line}`)) continue;
      for (const unitId of layout.starting.get(line.text) ?? []) {
        const item = items.get(unitId);
        const unit = layout.unitLines.get(unitId);
        const occurrence = index.find(unit).find((copy) => copy.file === file && copy.index === at);
        if (!occurrence || !free(occurrence)) continue;
        add(file, {
          differenceIds: claim(occurrence),
          prose: `An extra copy of ${describeUnit(item, unit)} is in ${file}, ${where(occurrence)}. Its required copy is in ${item.file}${file === item.file ? " at another place" : ""}; remove this extra copy.`,
        });
        break;
      }
    }
  }

  // Lost text is quoted. Unclaimed lines of the same hunks are its changed version.
  for (const { item, ids, touched, name, lines } of restores) {
    const changed = [...touched]
      .flatMap((hunk) => hunk.remove)
      .filter(({ kind, line }) => kind === "line" && !claimed.has(`${item.file}:${line}`));
    for (const { line } of changed) claimed.add(`${item.file}:${line}`);
    const current = changed.length
      ? ` Its changed version is around line ${changed[0].line} of ${item.file}, from the line ${code(changed[0].text)} to the line ${code(changed.at(-1).text)}; replace those lines with exactly these lines:`
      : " Put exactly these lines there:";
    add(item.file, {
      differenceIds: [...ids, ...changed.map((line) => lineIds.get(line))],
      prose: `${sentence(name)} is missing from ${item.file} or no longer matches its original text, and that exact text no longer exists anywhere in the project. It belongs ${place(item)}.${current}\n${block(lines)}`,
    });
  }

  // Lines outside units and stray lines, kept in their hunks with their surroundings.
  for (const hunk of hunks) {
    const ids = hunk.differenceIds;
    const remove = [],
      added = [],
      rest = [];
    hunk.remove.forEach((line, at) => {
      if (!covered.has(ids[at])) (remove.push(line), rest.push(ids[at]));
    });
    hunk.add.forEach((line, at) => {
      const id = ids[hunk.remove.length + at];
      if (!covered.has(id)) (added.push(line), rest.push(id));
    });
    if (!rest.length) continue;
    if (!reference(hunk.file)) {
      // The whole extra file goes, after any units in it have moved to their files.
      const moves = entries.has(hunk.file);
      add(hunk.file, {
        differenceIds: rest,
        prose: moves
          ? `After moving these units, delete the file ${hunk.file}. The required result has no such file; nothing else in it is needed.`
          : `Delete the file ${hunk.file}. The required result has no such file.`,
      });
      continue;
    }
    const presence = added.find(({ kind }) => kind === "file");
    if (presence) {
      created.add(hunk.file);
      add(hunk.file, {
        differenceIds: [],
        prose: `The file ${hunk.file} does not exist yet; create it first.`,
        first: true,
      });
    }
    // In a new file, its lines outside units come before the units placed after them.
    add(hunk.file, {
      differenceIds: rest,
      prose: hunkProse({ ...hunk, remove, add: added }, 0).replace(/^0\. /, ""),
      first: created.has(hunk.file),
    });
  }

  const assignments = [];
  const id = (file, part) => `units-${hash(file).slice(0, 16)}-${part}`;
  for (const file of [...entries.keys()].sort(order)) {
    const list = entries.get(file).sort((left, right) => Number(!!right.first) - Number(!!left.first));
    const groups = [];
    let current = [],
      bytes = 0;
    for (const entry of list) {
      const size = Buffer.byteLength(entry.prose);
      // A file to create or delete stays with one participant.
      if (
        reference(file) &&
        !created.has(file) &&
        current.length &&
        (current.length >= ASSEMBLY_CORRECTION_POLICY.maximumItems ||
          bytes + size > ASSEMBLY_CORRECTION_POLICY.maximumBytes)
      ) {
        groups.push(current);
        current = [];
        bytes = 0;
      }
      current.push(entry);
      bytes += size;
    }
    if (current.length) groups.push(current);
    groups.forEach((members, part) =>
      assignments.push({
        id: id(file, part + 1),
        file,
        differenceIds: members.flatMap(({ differenceIds }) => differenceIds),
        prompt: [
          `Correct the project file ${file}${groups.length > 1 ? ` (part ${part + 1} of ${groups.length})` : ""}.`,
          "A comparison with the required result found the problems listed below. Blank lines and spaces at the end of a line are not compared; everything else, including indentation and order, must match exactly. Units are named, not quoted: find them in the project.",
          "Inspect the current files before editing; line numbers may have shifted. Make only these changes and keep everything else unchanged. Other participants may be editing the project at the same time.",
          ...members
            .filter(({ prose }) => prose)
            .map(({ prose }, number) => `${number + 1}. ${prose}`),
        ].join("\n\n"),
      }),
    );
  }
  // Non-text entries and non-UTF-8 files keep the line correction wording.
  if (special.size)
    assignments.push(
      ...lineDifferenceCorrections(prepared, {
        ...comparison,
        hunks: comparison.hunks.filter((hunk) => special.has(hunk.file)),
        differences: comparison.differences.filter(({ unit }) => special.has(unit.file)),
      }),
    );
  const issued = new Set(assignments.flatMap(({ differenceIds }) => differenceIds));
  assert.ok(
    comparison.differenceIds.every((difference) => issued.has(difference)),
    "A difference has no correction assignment",
  );
  return assignments;
}
