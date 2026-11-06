import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { treeIdentity } from "../generation/generator.mjs";
import { assignNames } from "../generation/name-vocabulary.mjs";
import { semanticSession } from "../cpp/clangd-renames.mjs";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

export const ASSEMBLY_RENAME_VERSION = "renderer-assembly-renames-v1";
const FLAGS = ["-std=c++17", "-pthread"];
const IDENTIFIER = /^[A-Za-z_]\w*$/;
/** clangd refuses a rename it cannot make; any other failure stops the preparation. */
const REFUSAL = /^(Cannot rename symbol|Rename crosses fixed source boundary|No semantic edits)/;

/** Replace whole identifiers in code. Comments and literals stay unchanged. */
export function renameIdentifiers(text, names) {
  let result = "",
    position = 0;
  for (const token of cppTokens(text)) {
    const name = names.get(token.text);
    if (name === undefined) continue;
    result += text.slice(position, token.start) + name;
    position = token.end;
  }
  return result + text.slice(position);
}

/** Classify a compiler symbol by its USR: a function, type or field outside any
 * function body and outside the standard library, or null for everything else.
 */
export function renameKind(usr) {
  if (typeof usr !== "string" || /^c:[^@]*@\d|^c:@N@std@/.test(usr)) return null;
  if (/@E@\w+@\w+$|@EA@\w*$/.test(usr)) return null;
  if (/@FI@\w+$/.test(usr)) return "field";
  if (/@(S|ST>[^@]*|U|E|T|SA|UA)@\w+$/.test(usr)) return "type";
  // Parameter types follow a function's name; a local static variable follows them after "#@".
  const at = Math.max(usr.lastIndexOf("@F@"), usr.lastIndexOf("@FT@"));
  if (at >= 0 && !usr.slice(at).includes("#@")) return "function";
  return null;
}

/** Find the functions, types and fields whose spelling is unique in the code of
 * main.cpp: the compiler renames every occurrence of the identifier outside
 * comments and literals together with the symbol, so "rename X to Y everywhere"
 * has exactly one correct result. Returns them by number of uses, most first.
 */
export async function uniqueSpellings(main) {
  const spellings = new Map();
  for (const token of cppTokens(main)) {
    if (!IDENTIFIER.test(token.text)) continue;
    if (!spellings.has(token.text)) spellings.set(token.text, []);
    spellings.get(token.text).push(token.start);
  }
  const starts = [0];
  for (let index = 0; index < main.length; index++)
    if (main[index] === "\n") starts.push(index + 1);
  const position = (offset) => {
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: offset - starts[low] };
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "assembly-renames-"));
  const unique = [];
  let refused = 0,
    shared = 0;
  try {
    const sourcePath = path.join(directory, "main.cpp");
    await writeFile(sourcePath, main);
    const session = await semanticSession(sourcePath, main, FLAGS);
    try {
      for (const [name, offsets] of spellings) {
        const symbols = await session.symbols(position(offsets[0]));
        if (!Array.isArray(symbols) || symbols.length !== 1 || symbols[0].name !== name) continue;
        const kind = renameKind(symbols[0].usr);
        // The program entry point keeps its name.
        if (!kind || symbols[0].usr === "c:@F@main#") continue;
        let edits;
        try {
          edits = await session.edits([
            {
              name,
              offset: Buffer.byteLength(main.slice(0, offsets[0])),
              newName: `${name}_renamed`,
              family: symbols[0].usr,
            },
          ]);
        } catch (error) {
          if (!REFUSAL.test(error?.message ?? "")) throw error;
          refused++;
          continue;
        }
        const edited = new Set(edits.map((edit) => edit.start));
        if (
          edits.length === offsets.length &&
          edits.every((edit) => edit.old === name) &&
          offsets.every((offset) => edited.has(offset))
        )
          unique.push({ name, kind, uses: offsets.length, usr: symbols[0].usr });
        else shared++;
      }
    } finally {
      session.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  unique.sort((left, right) => right.uses - left.uses || (left.name < right.name ? -1 : 1));
  return { unique, refused, shared };
}

/** Count the old names still used in the code of each text file and return the
 * tree as it would be with those renames complete. Line numbers do not change.
 */
export function renameLeftovers(tree, selected) {
  const names = new Map(selected.map(({ name, newName }) => [name, newName]));
  const leftovers = new Map();
  const renamed = {};
  for (const [file, text] of Object.entries(tree)) {
    renamed[file] = text;
    if (typeof text !== "string" || !names.size) continue;
    const counts = new Map();
    for (const token of cppTokens(text))
      if (names.has(token.text)) counts.set(token.text, (counts.get(token.text) ?? 0) + 1);
    if (!counts.size) continue;
    leftovers.set(
      file,
      selected
        .filter(({ name }) => counts.has(name))
        .map(({ name, newName }) => ({ name, newName, count: counts.get(name) })),
    );
    renamed[file] = renameIdentifiers(text, names);
  }
  return { tree: renamed, leftovers };
}

/** One rename assignment. It names no position, so it stays valid after an imperfect assembly. */
export function renameProse({ name, newName, kind }) {
  return [
    "Several agents are editing main.cpp at the same time.",
    `Rename the ${kind} \`${name}\` to \`${newName}\` in main.cpp. Every occurrence of the identifier \`${name}\` in the code of main.cpp refers to this ${kind}: its declarations, its definition and all of its uses. Replace each of them with \`${newName}\`.`,
    `Do not change comments, string literals or character literals, even where they contain \`${name}\`. Do not change longer identifiers that only contain \`${name}\` as a part. Leave all other code unchanged.`,
  ].join("\n\n");
}

/** Select the most used uniquely spelled symbols of the assembled main.cpp and
 * derive their rename deliveries and the renamed reference. `percent` is the
 * share of all uniquely spelled symbols, rounded up; 0 adds no rename phase.
 * Assembly keeps the original units; corrections and the score use the renamed
 * reference view, whose regions, units and final files carry the new names.
 */
export async function prepareAssemblyRenames(setup, percent) {
  assert.ok(Number.isInteger(percent) && percent >= 0 && percent <= 100, "Invalid rename share");
  const reference = {
    regions: setup.regions,
    items: setup.items,
    trees: { final: setup.trees.final },
  };
  if (percent === 0)
    return {
      renames: { version: ASSEMBLY_RENAME_VERSION, percent, eligible: 0, selected: [] },
      renameDeliveries: [],
      reference,
    };
  const main = setup.trees.assembled["main.cpp"];
  const { unique } = await uniqueSpellings(main);
  const count = Math.ceil((unique.length * percent) / 100);
  assert.ok(count > 0, "No uniquely spelled symbol can be renamed");
  const used = new Set();
  for (const text of [...Object.values(setup.trees.assembled), ...Object.values(setup.trees.final)])
    for (const word of text.match(/[A-Za-z_]\w*/g) ?? []) used.add(word);
  const selected = assignNames(
    unique.slice(0, count).map(({ name, kind, uses, usr }) => ({
      name,
      kind,
      uses,
      family: usr,
      scope: "",
      role: kind,
    })),
    used,
  ).map(({ name, newName, kind, uses }) => ({ name, newName, kind, uses }));
  const names = new Map(selected.map(({ name, newName }) => [name, newName]));
  const rename = (text) => renameIdentifiers(text, names);
  const describe = (description) =>
    description && {
      ...description,
      scope: rename(description.scope),
      signature: rename(description.signature),
    };
  const items = new Map(
    setup.items.map((item) => [
      item.id,
      {
        ...item,
        text: rename(item.text),
        description: describe(item.description),
        before: describe(item.before),
        after: describe(item.after),
      },
    ]),
  );
  const final = Object.fromEntries(
    Object.entries(setup.trees.final).map(([file, text]) => [file, rename(text)]),
  );
  return {
    renames: { version: ASSEMBLY_RENAME_VERSION, percent, eligible: unique.length, selected },
    renameDeliveries: selected.map((entry, index) => ({
      id: `rename-${String(index + 1).padStart(3, "0")}`,
      file: "main.cpp",
      rename: entry,
      prompt: renameProse(entry),
    })),
    reference: {
      regions: setup.regions.map((region) => ({
        ...region,
        headerLines: region.headerLines.map(rename),
        body: rename(region.body),
        replacement: rename(region.replacement),
        items: region.items.map((item) => items.get(item.id)),
      })),
      items: [...items.values()],
      trees: { final },
    },
    trees: { ...setup.trees, final },
    identities: { ...setup.identities, final: treeIdentity(final) },
  };
}
