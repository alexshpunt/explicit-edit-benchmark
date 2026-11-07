import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { semanticSession } from "../cpp/clangd-renames.mjs";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { assignNames } from "../generation/name-vocabulary.mjs";
import { publicSignature } from "./assembly-prose.mjs";
import { renameKind } from "./assembly-renames.mjs";
import { loadFlatCase } from "./flat-case.mjs";
import { applyEdits, positions } from "./mixed-probe.mjs";

export const HARD_POOL_VERSION = "renderer-hard-pool-v4";
export const HARD_POOL_DEFAULTS = Object.freeze({
  overloads: 60,
  swaps: 60,
  fields: 5,
  locals: 5,
  // Overload and swap candidates whose traps are counted, hardest by use counts first.
  trapChecks: 700,
});
const FLAGS = ["-std=c++17", "-pthread"];
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const REFUSAL = /^(Cannot rename symbol|Rename crosses fixed source boundary|No semantic edits)/;
const KEEP = "Comments and string literals stay unchanged, and so does all other code.";
const run = promisify(execFile);
const hash = (text) => createHash("sha256").update(text).digest("hex");

const code = (text) => {
  assert.ok(!text.includes("`"), "Unsupported inline code");
  return "`" + text + "`";
};

/** The top-level comma-separated items inside the parentheses that open at `open`.
 * Literals and comments never split an item; brackets of every kind nest.
 */
export function parenthesizedItems(text, open, protectedTokens) {
  assert.equal(text[open], "(");
  const items = [];
  let depth = 0,
    from = open + 1,
    index = 0;
  while (index < protectedTokens.length && protectedTokens[index].end <= open) index++;
  for (let at = open; at < text.length; at++) {
    const token = protectedTokens[index];
    if (token && token.start === at) {
      at = token.end - 1;
      index++;
      continue;
    }
    const char = text[at];
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) {
      depth--;
      if (depth === 0) {
        if (text.slice(from, at).trim()) items.push(span(text, from, at));
        return { items, close: at };
      }
    } else if (char === "," && depth === 1) {
      items.push(span(text, from, at));
      from = at + 1;
    }
  }
  return null;
}

function span(text, from, to) {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return { start: from, end: to, text: text.slice(from, to) };
}

/** Build the hard task pool on the original main.cpp. Every task has an edit set
 * computed by clangd on the start file, keeps the project compiling on its own and
 * touches text no other task touches or names, so any set of finished tasks has
 * one well-defined snapshot.
 */
export async function prepareHardPool(casePath, options = {}) {
  const counts = { ...HARD_POOL_DEFAULTS, ...options };
  const { plan, manifest } = await loadFlatCase(casePath);
  const start = plan.initial["main.cpp"];
  const tokens = cppTokens(start);
  const protectedTokens = tokens.filter((token) => !IDENTIFIER.test(token.text));
  const occurrences = new Map();
  for (const token of tokens) {
    if (!IDENTIFIER.test(token.text)) continue;
    if (!occurrences.has(token.text)) occurrences.set(token.text, []);
    occurrences.get(token.text).push(token.start);
  }
  const units = cppStructure(start).units;
  const enclosing = (offset) => units.find((unit) => unit.start <= offset && offset < unit.end);
  const signatureOf = (unit) => {
    const text = start.slice(unit.start, unit.end);
    const brace = text.indexOf("{");
    if (brace < 0 || !text.slice(0, brace).includes("(")) return null;
    return publicSignature(text.slice(0, brace).replace(/\/\/[^\n]*/g, ""));
  };
  const lineAt = (offset) => {
    const from = start.lastIndexOf("\n", offset - 1) + 1;
    const to = start.indexOf("\n", offset);
    return start.slice(from, to < 0 ? start.length : to);
  };

  const candidates = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), "hard-pool-"));
  try {
    const sourcePath = path.join(directory, "main.cpp");
    await writeFile(sourcePath, start);
    const session = await semanticSession(sourcePath, start, FLAGS);
    try {
      const position = positions(start);
      const editsAt = async (name, offset, usr) => {
        try {
          return await session.edits([
            {
              name,
              offset: Buffer.byteLength(start.slice(0, offset)),
              newName: `${name}_pool`,
              family: usr,
            },
          ]);
        } catch (error) {
          if (REFUSAL.test(error?.message ?? "")) return null;
          throw error;
        }
      };
      for (const [name, offsets] of occurrences) {
        if (offsets.length < 4 || name === "main") continue;
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
        if (groups.size < 2) continue;
        for (const group of groups.values()) {
          const role = renameKind(group.usr);
          const local = /^c:main\.cpp@\d+@F@/.test(group.usr) ? "local" : null;
          const kind = role === "function" ? "overload" : role === "field" ? "field" : local;
          if (!kind || group.offsets.length < (kind === "local" ? 4 : 3)) continue;
          // Global symbols need every same-spelled use resolved; locals only their own.
          if (kind !== "local" && unresolved) continue;
          const others = [...groups.values()]
            .filter((other) => other !== group)
            .reduce((sum, other) => sum + other.offsets.length, 0);
          const edits = await editsAt(name, group.offsets[0], group.usr);
          const at = new Set(edits?.map((edit) => edit.start));
          if (
            !edits ||
            edits.length !== group.offsets.length ||
            !group.offsets.every((offset) => at.has(offset))
          )
            continue;
          const base = { name, usr: group.usr, uses: edits.length, others, edits };
          if (kind === "overload") {
            // A declaration: only type words before the name on its line, then a
            // parameter list that may continue over several lines.
            const declarationAt = (edit) => {
              const lineStart = start.lastIndexOf("\n", edit.start - 1) + 1;
              const before = start.slice(lineStart, edit.start);
              const first = /^\s*(\w+)/.exec(before)?.[1];
              if (!/^\s*([\w:<>,&*]+\s+)+[&*]*$/.test(before)) return null;
              if (["return", "else", "case", "throw", "co_return", "new", "delete"].includes(first))
                return null;
              let open = edit.start + name.length;
              while (/\s/.test(start[open])) open++;
              if (start[open] !== "(") return null;
              const list = parenthesizedItems(start, open, protectedTokens);
              return list && { lineStart, close: list.close };
            };
            const named = edits.find(declarationAt);
            if (!named) continue;
            const { lineStart, close } = declarationAt(named);
            const signature = publicSignature(start.slice(lineStart, close + 1));
            // The prompt quotes this declaration, so no other task may change it.
            base.quoted = [lineStart, close + 1];
            // Calls of the other overloads: a wrong rename of one of them may still compile.
            base.siblingCalls = [...groups.values()]
              .filter((other) => other !== group && renameKind(other.usr) === "function")
              .flatMap((other) => other.offsets)
              .filter((offset) => !declarationAt({ start: offset }));
            candidates.push({ ...base, kind: "overload", role: "function", signature });
            // A swap needs every occurrence to open a call or declaration with two or more items.
            const lists = edits.map((edit) => {
              let open = edit.start + name.length;
              while (/\s/.test(start[open])) open++;
              return start[open] === "(" ? parenthesizedItems(start, open, protectedTokens) : null;
            });
            if (
              lists.every(
                (list) =>
                  list &&
                  list.items.length >= 2 &&
                  list.items.every((item) => !/(^|[^=!<>])=($|[^=])/.test(item.text)),
              ) &&
              new Set(lists.map((list) => list.items.length)).size === 1
            ) {
              const swapEdits = lists.flatMap(({ items: [first, second] }) => [
                { start: first.start, old: first.text, new: second.text },
                { start: second.start, old: second.text, new: first.text },
              ]);
              candidates.push({
                ...base,
                kind: "swap",
                role: "function",
                signature,
                spans: lists.map(({ items: [first, second] }) => [first.start, second.end]),
                edits: swapEdits,
              });
            }
          } else if (kind === "field") {
            const container = (group.container ?? "").replace(/::$/, "");
            if (!IDENTIFIER.test(container)) continue;
            candidates.push({ ...base, kind: "field", role: "field", container });
          } else {
            const unit = enclosing(edits[0].start);
            const signature = unit && signatureOf(unit);
            if (
              !signature ||
              !edits.every((edit) => edit.start >= unit.start && edit.start < unit.end)
            )
              continue;
            // Another variable with the same spelling in this function would make the task ambiguous.
            const inUnit = offsets.filter((offset) => offset >= unit.start && offset < unit.end);
            if (inUnit.length !== edits.length) continue;
            candidates.push({ ...base, kind: "local", role: "local", signature, unit });
          }
        }
      }
    } finally {
      session.close();
    }

    // Many uses of the target and of its same-spelled siblings, so neither a short
    // list nor one dominant meaning gives the answer away.
    const difficulty = (task) => Math.min(task.uses, task.others);
    candidates.sort(
      (a, b) => difficulty(b) - difficulty(a) || b.uses - a.uses || (a.name < b.name ? -1 : 1),
    );
    // Traps: calls of sibling overloads that still compile when renamed or swapped
    // like the target, so the compiler cannot reveal the mistake. Counted with one
    // compile per candidate that applies the target's edits to every sibling call too.
    const errorLines = async (text, label) => {
      const file = path.join(directory, `${label}.cpp`);
      await writeFile(file, text);
      try {
        await run("clang++", [...FLAGS, "-fsyntax-only", "-ferror-limit=0", file], {
          maxBuffer: 1 << 26,
        });
        return new Set();
      } catch (error) {
        const lines = new Set();
        const pattern = new RegExp(`${label}\\.cpp:(\\d+):\\d+: error:`, "g");
        for (const match of String(error.stderr ?? "").matchAll(pattern))
          lines.add(Number(match[1]));
        return lines;
      } finally {
        await rm(file, { force: true });
      }
    };
    const toPosition = positions(start);
    const lineOf = (offset) => toPosition(offset).line + 1;
    const trapped = candidates
      .filter((task) => task.kind === "overload" || task.kind === "swap")
      .slice(0, counts.trapChecks);
    for (let index = 0; index < trapped.length; index += 8)
      await Promise.all(
        trapped.slice(index, index + 8).map(async (task, offset) => {
          const sibling = [];
          for (const call of task.siblingCalls ?? []) {
            if (task.kind === "overload") {
              sibling.push({
                call,
                edits: [{ start: call, old: task.name, new: `${task.name}_trap` }],
              });
              continue;
            }
            let open = call + task.name.length;
            while (/\s/.test(start[open])) open++;
            const list = start[open] === "(" && parenthesizedItems(start, open, protectedTokens);
            if (!list || list.items.length < 2) continue;
            const [first, second] = list.items;
            sibling.push({
              call,
              edits: [
                { start: first.start, old: first.text, new: second.text },
                { start: second.start, old: second.text, new: first.text },
              ],
            });
          }
          const own =
            task.kind === "overload"
              ? task.edits.map((edit) => ({ ...edit, new: `${task.name}_trap` }))
              : task.edits;
          let text;
          try {
            text = applyEdits(start, [...own, ...sibling.flatMap(({ edits }) => edits)]).text;
          } catch (error) {
            // Nested calls make sibling swaps overlap; such a candidate is not counted.
            if (!/Overlapping rename edits/.test(error?.message ?? "")) throw error;
            task.traps = 0;
            return;
          }
          const errors = await errorLines(text, `trap-${index + offset}`);
          task.traps = sibling.filter(({ call }) => !errors.has(lineOf(call))).length;
        }),
      );
    candidates.sort(
      (a, b) =>
        (b.traps ?? 0) - (a.traps ?? 0) ||
        difficulty(b) - difficulty(a) ||
        b.uses - a.uses ||
        (a.name < b.name ? -1 : 1),
    );
    const tasks = [];
    const taken = [];
    const spellings = new Set();
    const overlaps = (ranges) =>
      ranges.some(([from, to]) => taken.some(([left, right]) => from < right && left < to));
    const rangesOf = (task) =>
      task.kind === "swap"
        ? task.spans
        : task.edits.map((edit) => [edit.start, edit.start + edit.old.length]);
    const quoted = (task) =>
      task.kind === "local"
        ? [task.unit.start, task.unit.start + start.slice(task.unit.start).indexOf("{")]
        : (task.quoted ?? null);
    for (const candidate of candidates) {
      const limit = {
        overload: counts.overloads,
        swap: counts.swaps,
        field: counts.fields,
        local: counts.locals,
      }[candidate.kind];
      if (tasks.filter((task) => task.kind === candidate.kind).length >= limit) continue;
      // One task per symbol. Tasks on other overloads of the same spelling stay apart
      // because no task may change text that another task edits or quotes.
      if (spellings.has(candidate.usr)) continue;
      const ranges = rangesOf(candidate);
      const header = quoted(candidate);
      if (overlaps(header ? [...ranges, header] : ranges)) continue;
      if (
        candidate.kind === "local" &&
        tasks.some((task) => task.kind === "local" && task.unit === candidate.unit)
      )
        continue;
      tasks.push(candidate);
      spellings.add(candidate.usr);
      taken.push(...ranges, ...(header ? [header] : []));
    }

    // Fresh names for renames; then each task alone must keep the project compiling.
    const renames = tasks.filter((task) => task.kind !== "swap");
    const named = assignNames(
      renames.map((task) => ({
        name: task.name,
        family: task.usr,
        scope: "",
        role: task.role === "local" ? "local" : task.role,
      })),
      new Set(start.match(/[A-Za-z_]\w*/g)),
    );
    renames.forEach((task, index) => {
      task.newName = named[index].newName;
      task.edits = task.edits.map((edit) => ({ ...edit, new: task.newName }));
    });
    const compiles = async (text, label) => {
      const file = path.join(directory, `${label}.cpp`);
      await writeFile(file, text);
      try {
        await run("clang++", [...FLAGS, "-fsyntax-only", file], { maxBuffer: 1 << 26 });
        return true;
      } catch {
        return false;
      } finally {
        await rm(file, { force: true });
      }
    };
    const checked = [];
    for (let index = 0; index < tasks.length; index += 8)
      checked.push(
        ...(await Promise.all(
          tasks
            .slice(index, index + 8)
            .map((task, offset) =>
              compiles(applyEdits(start, task.edits).text, `task-${index + offset}`),
            ),
        )),
      );
    const kept = tasks.filter((_task, index) => checked[index]);

    const queue = kept.map((task) => ({
      id: `${task.kind}-${task.name}-${hash(task.usr).slice(0, 6)}`,
      task: "hard",
      kind: task.kind,
      name: task.name,
      newName: task.newName ?? null,
      uses: task.uses,
      traps: task.traps ?? null,
      prompt: hardProse(task),
      edits: task.edits,
    }));
    const snapshot = (done) =>
      applyEdits(
        start,
        queue.filter((entry) => done.has(entry.id)).flatMap((entry) => entry.edits),
      ).text;
    const all = new Set(queue.map(({ id }) => id));
    const expected = { "main.cpp": snapshot(all) };
    assert.ok(await compiles(expected["main.cpp"], "all"), "The full reference does not compile");
    return {
      version: HARD_POOL_VERSION,
      counts,
      setup: { markers: new Set(), manifest },
      start: { "main.cpp": start },
      expected,
      queue,
      snapshot,
      rejected: tasks.length - kept.length,
      identities: { start: treeIdentity({ "main.cpp": start }), expected: treeIdentity(expected) },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One hard task in prose: only the change, nothing about other agents. */
export function hardProse(task) {
  const { name } = task;
  const ask =
    task.kind === "overload"
      ? `In main.cpp, rename the overload ${code(task.signature)} of the function ${code(name)} to ${code(task.newName)}. Change its declarations, its definition and every call that resolves to this overload. The other overloads of ${code(name)} and every call to them stay unchanged.`
      : task.kind === "swap"
        ? `In main.cpp, swap the first two parameters of the overload ${code(task.signature)} of the function ${code(name)}: in its declarations and its definition swap the first and second parameter, and in every call that resolves to this overload swap the first and second argument. The other overloads of ${code(name)} and every call to them stay unchanged.`
        : task.kind === "field"
          ? `In main.cpp, rename the field ${code(name)} of the struct ${code(task.container)} to ${code(task.newName)}. Change its declaration and every place in the code that refers to this field. Other structs also have fields named ${code(name)}; those fields and every use of them stay unchanged.`
          : `In main.cpp, in the function definition ${code(task.signature)}, rename the local variable or parameter ${code(name)} to ${code(task.newName)}. Change its declaration and every use of it inside this function. Other functions also have variables named ${code(name)}; they stay unchanged.`;
  return [ask, KEEP].join("\n\n");
}
