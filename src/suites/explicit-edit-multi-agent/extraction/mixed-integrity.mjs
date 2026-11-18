import { diffArrays } from "diff";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

const OUTSIDE = "(outside regions)";

// Only the requested spelling substitutions are exempt. Missed substitutions
// and substitutions of a same-spelled symbol are handled by the rename checks.
function undoSpellings(source, renames) {
  const original = new Map(renames.map(({ name, newName }) => [newName, name]));
  const pieces = [];
  let offset = 0;
  for (const token of cppTokens(source)) {
    const name = original.get(token.text);
    if (name === undefined) continue;
    pieces.push(source.slice(offset, token.start), name);
    offset = token.end;
  }
  pieces.push(source.slice(offset));
  return pieces.join("");
}

function indexLines(rows) {
  const index = new Map();
  for (const [i, { text }] of rows.entries()) {
    if (!index.has(text)) index.set(text, []);
    index.get(text).push(i);
  }
  return index;
}

function numberedLines(source) {
  const rows = [];
  const regions = [];
  for (const [index, raw] of source.split("\n").entries()) {
    const text = raw.trim();
    if (!text) continue;
    const open = /^#pragma region (\S+)$/.exec(text);
    if (open) regions.push(open[1]);
    const region = regions.at(-1) ?? OUTSIDE;
    rows.push({ text, region, line: index + 1 });
    if (text === "#pragma endregion") regions.pop();
  }
  return rows;
}

function matchingUnits(rows, moves) {
  const index = indexLines(rows);
  const used = new Set();
  const matches = new Map();
  for (const { id, file, text } of moves) {
    const unit = numberedLines(text).map((row) => row.text);
    if (!unit.length) continue;
    const possible = (index.get(unit[0]) ?? []).filter((from) =>
      unit.every((line, i) => rows[from + i]?.text === line && !used.has(from + i)),
    );
    const from = possible.find((i) => rows[i].region === file) ?? possible[0];
    if (from === undefined) continue;
    const span = Array.from({ length: unit.length }, (_, i) => from + i);
    matches.set(id, span);
    for (const i of span) used.add(i);
  }
  return matches;
}

/** Measure non-task differences in marker-free main.cpp. Exempt one intact copy
 * of each assigned unit on each side, regardless of whether its move passed.
 * Never exempt surrounding code or a second copy. If the unit is missing or
 * edited, retain it in the comparison so the content loss remains visible.
 */
export function gradeMixedIntegrity(expected, candidate, { moves, renames }) {
  const expectedRows = numberedLines(undoSpellings(expected, renames));
  const candidateRows = numberedLines(undoSpellings(candidate, renames));
  const knownLines = indexLines(expectedRows);
  const expectedUnits = matchingUnits(expectedRows, moves);
  const candidateUnits = matchingUnits(candidateRows, moves);
  const hideExpected = new Set();
  const hideCandidate = new Set();
  for (const [id, span] of expectedUnits) {
    if (!candidateUnits.has(id)) continue;
    for (const i of span) hideExpected.add(i);
    for (const i of candidateUnits.get(id)) hideCandidate.add(i);
  }
  const before = expectedRows.filter((_, i) => !hideExpected.has(i));
  const after = candidateRows.filter((_, i) => !hideCandidate.has(i));

  const lines = { changed: 0, lost: 0, duplicated: 0, misplaced: 0, added: 0 };
  const affected = new Map();
  const record = (kind, left, right) => {
    lines[kind]++;
    if (left) affected.set(left, { side: "reference", kind });
    if (right) affected.set(right, { side: "candidate", kind });
  };
  const hunks = [];
  let hunk;
  let from = 0;
  let to = 0;
  for (const { added, removed, value } of diffArrays(before, after, {
    comparator: (a, b) => a.text === b.text && a.region === b.region,
  })) {
    if (added || removed) {
      if (!hunk) hunks.push((hunk = { removed: [], added: [] }));
      if (removed) hunk.removed.push(...before.slice(from, from + value.length));
      if (added) hunk.added.push(...after.slice(to, to + value.length));
    } else hunk = undefined;
    if (!added) from += value.length;
    if (!removed) to += value.length;
  }

  // Recover unchanged text relocated across a diff hunk or pragma region.
  const removed = new Map();
  for (const hunk of hunks)
    for (const row of hunk.removed) {
      if (!removed.has(row.text)) removed.set(row.text, []);
      removed.get(row.text).push(row);
    }
  for (const hunk of hunks)
    for (const row of hunk.added) {
      const old = removed.get(row.text)?.pop();
      if (old) record("misplaced", old, row);
      else if (knownLines.has(row.text)) record("duplicated", null, row);
    }
  for (const hunk of hunks) {
    const old = hunk.removed.filter((row) => !affected.has(row));
    const next = hunk.added.filter((row) => !affected.has(row));
    const shared = Math.min(old.length, next.length);
    for (let i = 0; i < shared; i++) record("changed", old[i], next[i]);
    for (const row of old.slice(shared)) record("lost", row, null);
    for (const row of next.slice(shared)) record("added", null, row);
  }

  const byRegion = new Map();
  const ranges = [];
  for (const row of [...before, ...after]) {
    if (!affected.has(row)) continue;
    const { side, kind } = affected.get(row);
    if (!byRegion.has(row.region)) byRegion.set(row.region, { reference: {}, candidate: {} });
    const counts = byRegion.get(row.region)[side];
    counts[kind] = (counts[kind] ?? 0) + 1;
    const last = ranges.at(-1);
    if (
      last?.side === side &&
      last.region === row.region &&
      last.kind === kind &&
      last.end + 1 === row.line
    )
      last.end = row.line;
    else ranges.push({ side, region: row.region, kind, start: row.line, end: row.line });
  }
  return {
    passed: !affected.size,
    affectedLines: Object.values(lines).reduce((sum, n) => sum + n, 0),
    lines,
    byRegion: Object.fromEntries(byRegion),
    ranges,
  };
}
