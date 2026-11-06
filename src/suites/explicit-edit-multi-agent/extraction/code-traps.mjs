import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

export const CODE_TRAP_VERSION = "renderer-code-traps-v1";
export const CODE_TRAP_LEVELS = Object.freeze([0, 1, 2, 3]);

/** Percent of eligible units per trap kind and level step. Inside traps move with
 * their unit; traps between units stay where they are in main.cpp.
 */
const RATES = Object.freeze({
  insideComment: 6,
  insideLiteral: 4,
  insideRawString: 2,
  insideInitializer: 3,
  memberComment: 8,
  betweenComment: 5,
  commentedCopy: 2,
  betweenInitializer: 2,
  betweenRawString: 1,
  macro: 1,
  overload: 2,
});

const hash = (value) => createHash("sha256").update(value).digest();
const draw = (kind, id) => hash(`${CODE_TRAP_VERSION}\u0000${kind}\u0000${id}`).readUInt16BE(0) % 100;

/** Text outside comments and literals, with protected spans blanked to spaces. */
function code(text) {
  let result = "",
    position = 0;
  for (const token of cppTokens(text)) {
    if (/^[A-Za-z_]/.test(token.text) && !/^(?:u8|u|U|L)?R?["']/.test(token.text)) continue;
    result += text.slice(position, token.start) + " ".repeat(token.end - token.start);
    position = token.end;
  }
  return result + text.slice(position);
}

const lastLine = (text) => text.slice(text.lastIndexOf("\n") + 1);
const indentOf = (line) => /^[ \t]*/.exec(line)[0];

function shape(text) {
  const plain = code(text);
  const head = plain.slice(0, plain.search(/[{;]/) + 1);
  if (/^\s*(?:template\s*<[^]*?>\s*)?(?:struct|class|union)\b/.test(plain) && /};\s*$/.test(plain))
    return "record";
  if (/^\s*(?:template\s*<[^]*?>\s*)?enum\b/.test(plain) && /};\s*$/.test(plain)) return "enum";
  if (/\)[^()]*{$/.test(head.trimEnd()) && /}\s*$/.test(plain) && !/};\s*$/.test(plain))
    return "function";
  return "other";
}

/** A free, non-template, non-operator function whose parameter list can take one more tag. */
function overloadable(text) {
  const plain = code(text);
  const open = plain.indexOf("(");
  const brace = plain.indexOf("{");
  if (open < 0 || brace < open) return null;
  const head = plain.slice(0, open);
  if (/\btemplate\b|::|\boperator\b|\bmain\s*$|[<>]/.test(head)) return null;
  if (!/^[\s\w*&]+$/.test(head) || !/\w\s*$/.test(head)) return null;
  let depth = 0;
  for (let at = open; at < brace; at++) {
    if (plain[at] === "(") depth++;
    else if (plain[at] === ")" && --depth === 0) {
      if (/\.\.\.|=/.test(plain.slice(open, at))) return null;
      return { close: at, empty: !plain.slice(open + 1, at).trim() };
    }
  }
  return null;
}

/** Deterministically add code traps to a verified flat plan. Every fragment keeps
 * its identity; offsets, unit texts and destinations follow the inserted text.
 * Inserted code is inert: comments, unused literals and initializers, unused
 * macros and tag-typed overloads that no existing call can select.
 */
export function applyCodeTraps(plan, level = 0, { rates = RATES } = {}) {
  assert.ok(CODE_TRAP_LEVELS.includes(level), `Unsupported code trap level ${level}`);
  if (level === 0) return plan;
  const chosen = (kind, id) => draw(kind, id) < rates[kind] * level;
  const source = plan.initial["main.cpp"];
  const insertions = [];
  let serial = 0;
  const name = () => `explicit_edit_trap_${++serial}`;
  for (const task of plan.tasks)
    for (const fragment of task.fragments) {
      const { id, start, end, text } = fragment;
      const kind = shape(text);
      const tail = lastLine(text);
      const lineStart = start === 0 || source[start - 1] === "\n";
      const inner = indentOf(tail) + "  ";
      // Traps inside a unit sit on their own line before its closing line.
      const closing = end - tail.length;
      if (kind === "function" && tail.trim() === "}" && text.includes("\n")) {
        if (chosen("insideComment", id))
          insertions.push({ at: closing, text: `${inner}// }; the unit does not end here {\n` });
        if (chosen("insideLiteral", id))
          insertions.push({ at: closing, text: `${inner}(void)"}; {";\n` });
        if (chosen("insideRawString", id))
          insertions.push({ at: closing, text: `${inner}(void)R"trap(};\n{)trap";\n` });
        if (chosen("insideInitializer", id))
          insertions.push({
            at: closing,
            text: `${inner}[[maybe_unused]] const int ${name()}[] = {0, 1};\n`,
          });
      }
      if ((kind === "record" || kind === "enum") && tail.trim() === "};" && text.includes("\n"))
        if (chosen("memberComment", id))
          insertions.push({ at: closing, text: `${inner}// };\n` });
      if (!lineStart) continue;
      if (chosen("betweenComment", id))
        insertions.push({ at: start, text: `// }; {\n` });
      // Unnamed blocks are found by their text, so only named units get a commented copy.
      if (
        kind !== "other" &&
        chosen("commentedCopy", id) &&
        !/\\\n/.test(text) &&
        !text.includes("*/")
      )
        insertions.push({
          at: start,
          text: `/*\n${text}\n*/\n`,
        });
      if (chosen("betweenInitializer", id))
        insertions.push({
          at: start,
          text: `[[maybe_unused]] static const int ${name()}[] = {1, 2};\n`,
        });
      if (chosen("betweenRawString", id))
        insertions.push({
          at: start,
          text: `[[maybe_unused]] static const char* const ${name()} = R"trap(\n};\n)trap";\n`,
        });
      if (chosen("macro", id))
        insertions.push({ at: start, text: `#define EXPLICIT_EDIT_TRAP_${++serial}(x) { x; }\n` });
      const overload = kind === "function" && overloadable(text);
      if (overload && chosen("overload", id)) {
        const tag = `ExplicitEditTrapTag${++serial}`;
        const copy =
          text.slice(0, overload.close) +
          (overload.empty ? tag : `, ${tag}`) +
          text.slice(overload.close);
        insertions.push({ at: end, text: `\n\nstruct ${tag} {};\n${copy}`, after: true });
      }
    }
  // Insertions at a unit's start precede it; insertions at its end follow it.
  insertions.sort((left, right) => left.at - right.at || Number(!left.after) - Number(!right.after));
  let next = "",
    position = 0;
  for (const insertion of insertions) {
    next += source.slice(position, insertion.at) + insertion.text;
    position = insertion.at;
  }
  next += source.slice(position);
  // A fragment starts after every insertion at its start and ends before those at its end.
  const shift = (offset, inclusive) =>
    offset +
    insertions
      .filter(({ at }) => at < offset || (at === offset && inclusive))
      .reduce((sum, { text }) => sum + text.length, 0);
  const tasks = plan.tasks.map((task) => {
    let destination = task.destination,
      cursor = task.preamble.length;
    const fragments = task.fragments.map((fragment) => {
      const start = shift(fragment.start, true);
      const end = shift(fragment.end, false);
      const text = next.slice(start, end);
      const at = destination.indexOf(fragment.text, cursor);
      assert.ok(at >= cursor, "Destination fragment is missing or out of order");
      destination = destination.slice(0, at) + text + destination.slice(at + fragment.text.length);
      cursor = at + text.length;
      return { ...fragment, start, end, text };
    });
    return { ...task, fragments, destination };
  });
  const { expected: _expected, ...rest } = plan;
  return {
    ...rest,
    initial: { ...plan.initial, "main.cpp": next },
    tasks,
    traps: { version: CODE_TRAP_VERSION, level, insertions: insertions.length },
  };
}
