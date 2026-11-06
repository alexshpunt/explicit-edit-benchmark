import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { semanticSession } from "../cpp/clangd-renames.mjs";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { assignNames } from "../generation/name-vocabulary.mjs";
import { cleanupAssemblyMarkers, prepareAssemblyCase } from "./assembly-case.mjs";
import { describeNamed } from "./assembly-prose.mjs";
import { renameKind, uniqueSpellings } from "./assembly-renames.mjs";

export const MIXED_PROBE_VERSION = "renderer-mixed-probe-v1";
export const MIXED_PROBE_DEFAULTS = Object.freeze({
  moves: 80,
  unique: 6,
  shared: 6,
  parameters: 6,
});
const FLAGS = ["-std=c++17", "-pthread"];
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const REFUSAL = /^(Cannot rename symbol|Rename crosses fixed source boundary|No semantic edits)/;
const SHARED =
  "Several agents are editing main.cpp at the same time. The file can change between the moment you read it and the moment you write it, and the risk of conflicting edits is high, so be as careful as possible with your edits.";
const KEEP = "Comments and string literals stay unchanged, and so does all other code.";

const code = (text) => {
  assert.ok(!text.includes("`"), "Unsupported inline code");
  return "`" + text + "`";
};
const words = (text) => new Set(text.match(/[A-Za-z_]\w*/g) ?? []);

/** Line starts of a text, to convert offsets into LSP positions. */
function positions(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++)
    if (text[index] === "\n") starts.push(index + 1);
  return (offset) => {
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: offset - starts[low] };
  };
}

/** Apply compiler edits and map each old offset to its new offset. */
function applyEdits(text, edits) {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  let result = "",
    position = 0;
  const shifts = [];
  let delta = 0;
  for (const edit of ordered) {
    assert.ok(edit.start >= position, "Overlapping rename edits");
    result += text.slice(position, edit.start) + edit.new;
    position = edit.start + edit.old.length;
    delta += edit.new.length - edit.old.length;
    shifts.push({ after: position, delta });
  }
  result += text.slice(position);
  const map = (offset) => {
    let shift = 0;
    for (const entry of shifts) if (entry.after <= offset) shift = entry.delta;
    return offset + shift;
  };
  return { text: result, map };
}

/** One parameter of a function header: its name and offset in the header. */
function parameters(header) {
  const open = header.indexOf("(");
  const result = [];
  let depth = 0,
    from = open + 1;
  for (let at = open; at < header.length; at++) {
    const char = header[at];
    if ("(<[".includes(char)) depth++;
    else if (")>]".includes(char)) depth--;
    if ((char === "," && depth === 1) || (char === ")" && depth === 0)) {
      const part = header.slice(from, at).replace(/=.*$/s, "");
      const match = /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$/.exec(part);
      if (match) result.push({ name: match[1], offset: from + match.index });
      from = at + 1;
      if (char === ")") break;
    }
  }
  return result;
}

/** Choose the tasks of a mixed probe and derive its reference. Moves are the first
 * assembly deliveries; renames come from clangd on the start file. No assignment
 * names a spelling that another assignment changes, and symbols with uses that
 * clangd cannot resolve, such as template-dependent ones, are not chosen.
 */
export async function prepareMixedProbe(casePath, options = {}) {
  const counts = { ...MIXED_PROBE_DEFAULTS, ...options };
  const setup = await prepareAssemblyCase(casePath);
  const start = setup.trees.scaffold["main.cpp"];
  const source = setup.plan.initial["main.cpp"];
  const shift = start.length - source.length;
  assert.equal(start.slice(setup.regionStart + shift), source.slice(setup.regionStart));
  // Whole regions whose project includes are moved too, so the moved code still
  // follows everything it uses and the reference builds; at most `moves` deliveries.
  const selected = new Set();
  let total = 0;
  for (const region of setup.regions) {
    const size = setup.deliveries.filter((delivery) => delivery.file === region.file).length;
    const required = region.headerLines
      .map((line) => /^#include\s+[<"]([^>"]+)[>"]/.exec(line)?.[1])
      .filter(Boolean)
      .map((include) =>
        setup.regions.find(({ file }) => file === include || file.endsWith(`/${include}`)),
      )
      .filter(Boolean);
    if (total + size > counts.moves || !required.every(({ file }) => selected.has(file))) continue;
    selected.add(region.file);
    total += size;
  }
  assert.ok(total > 0, "No region fits the move budget");
  const moves = setup.deliveries.filter((delivery) => selected.has(delivery.file));
  const moved = new Set(moves.flatMap((delivery) => delivery.items.map((item) => item.id)));
  const reserved = new Set();
  for (const delivery of moves) for (const word of words(delivery.prompt)) reserved.add(word);

  const directory = await mkdtemp(path.join(os.tmpdir(), "mixed-probe-"));
  const renames = [];
  try {
    const sourcePath = path.join(directory, "main.cpp");
    await writeFile(sourcePath, start);
    const session = await semanticSession(sourcePath, start, FLAGS);
    try {
      const position = positions(start);
      const occurrences = new Map();
      for (const token of cppTokens(start)) {
        if (!IDENTIFIER.test(token.text)) continue;
        if (!occurrences.has(token.text)) occurrences.set(token.text, []);
        occurrences.get(token.text).push(token.start);
      }
      const edits = async (name, offset, usr) => {
        try {
          return await session.edits([
            {
              name,
              offset: Buffer.byteLength(start.slice(0, offset)),
              newName: `${name}_probe`,
              family: usr,
            },
          ]);
        } catch (error) {
          if (REFUSAL.test(error?.message ?? "")) return null;
          throw error;
        }
      };
      const lineAt = (offset) => {
        const from = start.lastIndexOf("\n", offset - 1) + 1;
        const to = start.indexOf("\n", offset);
        return start.slice(from, to < 0 ? start.length : to);
      };
      /** An assignment conflicts with a rename when its prose names the renamed
       * spelling; a parameter rename changes only its own unmoved function.
       */
      const accept = (candidate) => {
        const names = renames.map(({ name }) => name);
        if (names.includes(candidate.name) || candidate.name === "main") return false;
        if (candidate.kind !== "parameter" && reserved.has(candidate.name)) return false;
        for (const other of renames) {
          if (other.kind !== "parameter" && candidate.mentions.has(other.name)) return false;
          if (candidate.kind !== "parameter" && other.mentions.has(candidate.name)) return false;
        }
        renames.push(candidate);
        return true;
      };
      const count = (kind) => renames.filter((rename) => rename.kind === kind).length;

      // Uniquely spelled symbols: the compiler rename edits every code occurrence.
      const { unique } = await uniqueSpellings(start);
      for (const entry of unique) {
        if (count("unique") >= counts.unique) break;
        if (reserved.has(entry.name)) continue;
        const found = await edits(entry.name, occurrences.get(entry.name)[0], entry.usr);
        if (!found) continue;
        accept({
          kind: "unique",
          name: entry.name,
          role: entry.kind,
          usr: entry.usr,
          mentions: new Set([entry.name]),
          edits: found,
        });
      }

      // One symbol among several with the same spelling: a field or an overload,
      // alternating so that both appear.
      const shared = { field: [], function: [] };
      for (const [name, offsets] of [...occurrences].sort((a, b) => b[1].length - a[1].length)) {
        if (offsets.length < 20) break;
        if (shared.field.length + shared.function.length >= counts.shared * 4) break;
        if (reserved.has(name) || name === "main") continue;
        const groups = new Map();
        let unresolved = 0;
        for (const offset of offsets) {
          const symbols = await session.symbols(position(offset));
          const usr =
            Array.isArray(symbols) && symbols.length === 1 && symbols[0].name === name
              ? symbols[0].usr
              : null;
          if (!usr) {
            unresolved++;
            continue;
          }
          if (!groups.has(usr))
            groups.set(usr, { usr, container: symbols[0].containerName, offsets: [] });
          groups.get(usr).offsets.push(offset);
        }
        if (unresolved || groups.size < 2) continue;
        const [group] = [...groups.values()].sort((a, b) => b.offsets.length - a.offsets.length);
        const role = renameKind(group.usr);
        if (role !== "field" && role !== "function") continue;
        const found = await edits(name, group.offsets[0], group.usr);
        const at = new Set(found?.map((edit) => edit.start));
        if (
          !found ||
          found.length !== group.offsets.length ||
          !group.offsets.every((offset) => at.has(offset))
        )
          continue;
        const entry = { kind: "shared", name, role, usr: group.usr, edits: found };
        if (role === "field") {
          entry.container = (group.container ?? "").replace(/::$/, "");
          if (!IDENTIFIER.test(entry.container)) continue;
          entry.mentions = new Set([name, entry.container]);
        } else {
          // The overload is named by its declaration's signature.
          const declaration = found
            .map((edit) => lineAt(edit.start).trim())
            .find((line) => new RegExp(`^[\\w\\s:&*<>,]*\\b${name}\\s*\\([^()]*\\)`).test(line));
          if (!declaration) continue;
          entry.signature = declaration.slice(0, declaration.indexOf(")") + 1);
          entry.mentions = words(entry.signature);
        }
        shared[role].push(entry);
      }
      for (let index = 0; count("shared") < counts.shared; index++) {
        const next = [shared.field[index], shared.function[index]].filter(Boolean);
        if (!next.length) break;
        for (const entry of next) if (count("shared") < counts.shared) accept(entry);
      }

      // A parameter of one unmoved function, where other functions use the same spelling.
      for (const item of setup.items) {
        if (count("parameter") >= counts.parameters) break;
        if (moved.has(item.id) || item.kind !== "named" || item.copies !== 1) continue;
        if (item.description.kind !== "function-definition") continue;
        const header = item.text.slice(0, item.text.indexOf("{"));
        for (const parameter of parameters(header)) {
          const { name } = parameter;
          if ((occurrences.get(name)?.length ?? 0) < 50) continue;
          const body = item.text.slice(header.length);
          if ((body.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length < 3) continue;
          const usr = `parameter:${item.id}:${name}`;
          const found = await edits(name, item.start + shift + parameter.offset, usr);
          const from = item.start + shift,
            to = item.end + shift;
          if (!found || !found.every((edit) => edit.start >= from && edit.start < to)) continue;
          const description = describeNamed(item.description);
          if (
            accept({
              kind: "parameter",
              name,
              role: "parameter",
              usr,
              function: description,
              mentions: words(description),
              edits: found,
            })
          )
            break;
        }
      }
    } finally {
      session.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  for (const kind of ["unique", "shared", "parameter"]) {
    const wanted = counts[kind === "parameter" ? "parameters" : kind];
    const found = renames.filter((rename) => rename.kind === kind).length;
    assert.equal(found, wanted, `Found ${found} of ${wanted} ${kind} renames`);
  }

  // Fresh names that appear nowhere in the source.
  const used = words(start);
  const named = assignNames(
    renames.map((rename) => ({
      name: rename.name,
      family: rename.usr,
      scope: "",
      role: rename.role,
    })),
    used,
  );
  renames.forEach((rename, index) => (rename.newName = named[index].newName));
  const fresh = new Set(renames.map(({ newName }) => newName));
  assert.equal(fresh.size, renames.length, "Rename targets collide");

  // Reference: all renames on the start file, then the moves of the renamed units.
  const allEdits = renames.flatMap((rename) =>
    rename.edits.map((edit) => ({ ...edit, new: rename.newName })),
  );
  const renamed = applyEdits(start, allEdits);
  const movedItems = moves.flatMap((delivery) => delivery.items);
  const pieces = movedItems.map((item) => {
    const from = renamed.map(item.start + shift),
      to = renamed.map(item.end + shift);
    return { item, from, to, text: renamed.text.slice(from, to) };
  });
  let main = renamed.text;
  for (const piece of [...pieces].sort((a, b) => b.from - a.from))
    main = main.slice(0, piece.from) + main.slice(piece.to);
  for (const piece of pieces) {
    const at = main.indexOf(piece.item.marker);
    assert.ok(at >= 0 && at === main.lastIndexOf(piece.item.marker), "Marker changed");
    main = main.slice(0, at) + piece.text + main.slice(at + piece.item.marker.length);
  }
  const expected = cleanupAssemblyMarkers({ "main.cpp": main }, setup.markers).tree;

  const assignments = [
    ...renames.map((rename) => ({
      id: `rename-${rename.kind}-${rename.name}`,
      rename,
      prompt: renameProse(rename),
    })),
  ];
  // Spread the renames through the move queue so they run while units move.
  const queue = [];
  const every = Math.max(1, Math.floor(moves.length / Math.max(1, assignments.length)));
  let next = 0;
  moves.forEach((delivery, index) => {
    queue.push({ ...delivery, task: "move" });
    if ((index + 1) % every === 0 && next < assignments.length)
      queue.push({ ...assignments[next++], task: "rename" });
  });
  while (next < assignments.length) queue.push({ ...assignments[next++], task: "rename" });

  return {
    version: MIXED_PROBE_VERSION,
    counts,
    setup,
    start: { "main.cpp": start },
    expected,
    queue,
    moves: movedItems,
    renames: renames.map(({ edits, ...rename }) => ({ ...rename, edits: edits.length })),
    identities: { start: treeIdentity({ "main.cpp": start }), expected: treeIdentity(expected) },
  };
}

/** One rename assignment in prose. */
export function renameProse(rename) {
  const { name, newName } = rename;
  const ask =
    rename.kind === "unique"
      ? `In main.cpp, rename the ${rename.role} ${code(name)} to ${code(newName)}. Every occurrence of the identifier ${code(name)} in the code refers to this ${rename.role}; change every one of them.`
      : rename.kind === "parameter"
        ? `In main.cpp, in ${rename.function}, rename the parameter ${code(name)} to ${code(newName)}. Change the parameter and every use of it inside this function. Other functions also have parameters and variables named ${code(name)}; they stay unchanged.`
        : rename.role === "field"
          ? `In main.cpp, rename the field ${code(name)} of the struct ${code(rename.container.replace(/::$/, ""))} to ${code(newName)}. Change its declaration and every place in the code that refers to this field. Other structs also have fields named ${code(name)}; those fields and every use of them stay unchanged.`
          : `In main.cpp, rename the overload ${code(rename.signature)} of the function ${code(name)} to ${code(newName)}. Change its declarations, its definition and every call that resolves to this overload. The other overloads of ${code(name)} and every call to them stay unchanged.`;
  return [SHARED, ask, KEEP].join("\n\n");
}

const lines = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Grade one candidate main.cpp: one check per moved unit and per rename. A move
 * passes when the unit, with renames undone, stands exactly once in its region and
 * the file holds as many copies as the reference. A rename passes when, other
 * renames undone, every reference line with its new name is present as often as in
 * the reference and no other line has it: a missed occurrence drops a line and a
 * wrong one adds a line. Moves never change line text.
 */
export function gradeMixedProbe(probe, candidateMain) {
  const candidate = cleanupAssemblyMarkers({ "main.cpp": candidateMain }, probe.setup.markers).tree[
    "main.cpp"
  ];
  const expected = probe.expected["main.cpp"];
  const byNewName = new Map(probe.renames.map((rename) => [rename.newName, rename]));
  const undo = (text, except) =>
    text.replace(/[A-Za-z_]\w*/g, (word) => {
      const rename = byNewName.get(word);
      return rename && rename !== except ? rename.name : word;
    });
  const normal = (text) => lines(text).join("\n");
  const regionsOf = (text) => {
    const regions = new Map();
    for (const match of text.matchAll(/^#pragma region (\S+)\n([\s\S]*?)^#pragma endregion$/gm))
      regions.set(match[1], (regions.get(match[1]) ?? "") + match[2]);
    return regions;
  };
  const original = undo(candidate),
    reference = undo(expected);
  const regions = regionsOf(original);
  const flat = normal(original),
    wanted = normal(reference);
  const moves = probe.moves.map((item) => {
    const text = normal(item.text);
    const count = flat.split(text).length - 1;
    const inside = normal(regions.get(item.file) ?? "").split(text).length - 1;
    return {
      id: item.id,
      kind: "move",
      passed: inside === 1 && count === wanted.split(text).length - 1,
    };
  });
  const renames = probe.renames.map((rename) => {
    const pattern = new RegExp(`\\b${rename.newName}\\b`);
    const mentions = (text) => {
      const counts = new Map();
      for (const line of lines(undo(text, rename)))
        if (pattern.test(line)) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const got = mentions(candidate),
      want = mentions(expected);
    // Extra copies of correct lines belong to a failed move, not to the rename.
    return {
      id: `rename-${rename.kind}-${rename.name}`,
      kind: rename.kind,
      passed:
        [...want].every(([line, count]) => (got.get(line) ?? 0) >= count) &&
        [...got.keys()].every((line) => want.has(line)),
    };
  });
  const tally = (checks) => ({
    passed: checks.filter(({ passed }) => passed).length,
    total: checks.length,
  });
  return {
    moves: tally(moves),
    unique: tally(renames.filter(({ kind }) => kind === "unique")),
    shared: tally(renames.filter(({ kind }) => kind === "shared")),
    parameters: tally(renames.filter(({ kind }) => kind === "parameter")),
    all: tally([...moves, ...renames]),
    exact: candidate === expected,
    lines: { candidate: candidate.split("\n").length, expected: expected.split("\n").length },
    failed: [...moves, ...renames].filter(({ passed }) => !passed).map(({ id }) => id),
  };
}
