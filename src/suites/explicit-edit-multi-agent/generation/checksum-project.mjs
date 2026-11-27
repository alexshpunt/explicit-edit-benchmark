import assert from "node:assert/strict";

/** A generated C++ project for Multi-Agent: one main.cpp whose functions each add a
 * weighted contribution to a checksum that main prints. A seed fixes the program, its
 * edits and the reference. Every edit is a mechanical change stated as exact text, as
 * in the original suite, and belongs to one of five clusters; each cluster has trap
 * edits, which contain one difficulty, and control edits, which are the same edit
 * without it. No two edits touch the same text, so the reference does not depend on
 * the order in which agents finish.
 *
 * Density sets how many edits share one zone: a host function and the paragraphs
 * next to it. With density 1 every edit has a zone of its own; with density 3 three
 * agents edit neighbouring lines of one function at the same moment.
 */
export const CHECKSUM_PROJECT_VERSION = "multi-agent-checksum-project-v14";
export const CHECKSUM_CLUSTERS = Object.freeze({
  A: "completeness",
  B: "target selection",
  C: "block extent",
  D: "supplied text",
  E: "byte exactness",
  F: "scoped replacement",
  G: "scoped rename",
  H: "deletion target",
  I: "in-place target",
  J: "overlapping pair",
  K: "namespace target",
  L: "shifted lines",
  M: "bulk deletion",
  N: "commented copy",
  O: "raw string",
  P: "located by a call in main",
  Q: "located by its callee",
  R: "located by its neighbour",
  S: "located by a constant",
  T: "rename in code only",
  U: "unused functions",
  V: "unqualified call",
  W: "line endings",
  X: "byte order mark",
  Y: "end of file",
  Z: "computed replacement",
  a: "not UTF-8",
  b: "Unicode look-alike",
  c: "large reordering",
  d: "recipe tabs",
  e: "class method target",
  f: "out-of-class definition",
  g: "nested branch",
  h: "class end",
  i: "lambda and init list",
  j: "overload",
  k: "constructor overload",
  l: "template overload",
  m: "override",
  n: "disabled copy",
  o: "friend declaration",
  p: "signature in a comment",
  q: "placeholder in a note",
  r: "region extraction",
  s: "preprocessor twin",
  t: "batch move order",
  u: "rename by owner",
});
export const CHECKSUM_PROJECT_DEFAULTS = Object.freeze({
  // Clusters to generate, by letter.
  clusters: "BCFGHIJ",
  // Trap edits and control edits per cluster.
  perVariant: 2,
  // Edits per zone.
  density: 1,
  // Edits per task; more than one makes composite tasks.
  edits: 1,
  // The least number of lines of the start main.cpp; 0 adds no extra functions.
  lines: 0,
});
const MODULUS = 1000003;
// Library functions have prototypes and are the only functions other functions call,
// so every other function can stand anywhere above main.
const LIBRARY_SIZE = 6;
// String literals of a D function, written as they stand in main.cpp. A trap's
// literals need care at every layer between the prompt and the file: JSON escapes,
// C++ escapes, shell quoting and expansion, and printf-style formats.
const SUPPLIED_LITERALS = 5;
const ESCAPED_LITERALS = [
  String.raw`C:\\temp\\$USER\\new`,
  String.raw`say \"hi\" to ` + "`whoami`" + String.raw` at 100%\n`,
  String.raw`tab\there, \\n is not a newline`,
  String.raw`${"$"}{HOME} and $(date) stay literal`,
  String.raw`quote ' and \" and \\\" mixed`,
  String.raw`100% of $5 \\ 2 is %d`,
  String.raw`line one\nline two\r\n`,
  String.raw`back\\slash and \\\\ double`,
];
const PLAIN_LITERALS = [
  "temp user folder",
  "say hi to the team",
  "tab here is not a newline",
  "home and date stay literal",
  "quote and mixed text",
  "five of ten in two",
  "line one line two",
  "back slash and double",
];
// Variable names: "i" is the loop variable of nested blocks, and "e" would make an
// expression such as "e * 37 + 11" part of "value * 37 + 11" in supplied text.
const VARIABLES = "abcdfghjkmnpqrtuwxyz";
const ADJECTIVES = [
  "amber",
  "brisk",
  "calm",
  "dusty",
  "early",
  "faint",
  "gentle",
  "hollow",
  "icy",
  "jagged",
  "keen",
  "lunar",
  "mellow",
  "narrow",
  "olive",
  "pale",
  "quiet",
  "rapid",
  "silver",
  "tidal",
  "upper",
  "vivid",
  "woven",
  "young",
];
const NOUNS = [
  "anchor",
  "bridge",
  "canyon",
  "delta",
  "ember",
  "forge",
  "glacier",
  "harbor",
  "island",
  "lantern",
  "meadow",
  "needle",
  "orbit",
  "prism",
  "quarry",
  "ridge",
  "summit",
  "thicket",
  "valley",
  "willow",
];
// Constant names share no word with function names.
const CONSTANT_WORDS = [
  "bias",
  "boost",
  "damping",
  "decay",
  "drift",
  "gain",
  "lift",
  "phase",
  "pulse",
  "scale",
  "skew",
  "spread",
  "sway",
  "tilt",
];
const CONSTANT_SUFFIXES = ["base", "rate", "span", "step", "unit"];
const COMMENTS = [
  ["tuned", "factor"],
  ["calibrated", "step"],
  ["measured", "weight"],
  ["fixed", "scale"],
  ["reviewed", "offset"],
];

/** Mulberry32: a small deterministic generator, so one seed gives one project. */
function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const integer = (low, high) => low + Math.floor(next() * (high - low + 1));
  const pick = (items) => items[integer(0, items.length - 1)];
  const shuffle = (items) => {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const other = integer(0, index);
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  };
  return { integer, pick, shuffle };
}

/** A function's signature; moves name a function only by it, so an agent finds the
 * extent of the definition itself.
 */
const signature = (name) => `long long ${name}(long long value)`;

/** The first line of a function definition. */
const header = (name) => `${signature(name)} {`;

/** Exact text in a prompt, as the original suite writes it: JSON string notation. */
const q = (value) => JSON.stringify(value);

/** The definition of a function in a main.cpp, from its first line through the
 * next line that is a lone "}", or undefined. It does not rely on the blank lines
 * around it, which another agent's mistake can remove.
 */
export function definitionText(text, name) {
  const first = text.startsWith(header(name)) ? 0 : text.indexOf(`\n${header(name)}`) + 1;
  if (first === 0 && !text.startsWith(header(name))) return undefined;
  const end = text.indexOf("\n}", first);
  return end < 0 ? undefined : text.slice(first, end + 2);
}

/** The definition of a class in a main.cpp, from its first line through the next
 * line that starts with "};", or undefined. The first line may name a base class.
 */
export function classText(text, name) {
  const open = text.startsWith(`class ${name} `) ? 0 : text.indexOf(`\nclass ${name} `) + 1;
  if (open === 0 && !text.startsWith(`class ${name} `)) return undefined;
  const close = text.indexOf("\n};", open);
  return close < 0 ? undefined : text.slice(open, close + 3);
}

/** Whole-identifier occurrences of a name: a longer identifier is another name. */
export const identifierCount = (text, name) =>
  text.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;

/** The expression of one declaration; `context` holds renamed constants and
 * changed factors.
 */
function expressionText(statement, context) {
  const factor = context.factors.get(statement.id) ?? statement.factor;
  const { left, right, offset } = statement;
  // A Z trap writes one declaration with its factor first.
  if (statement.kind === "linear")
    return statement.swapped
      ? `${factor} * ${left} + ${offset}`
      : `${left} * ${factor} + ${offset}`;
  if (statement.kind === "product") return `${left} * ${right} + ${offset}`;
  if (statement.kind === "mix") return `(${left} ^ ${factor}) + ${right}`;
  // A call passes the previous variable; a P decoy's call passes a number and adds
  // the previous variable.
  if (statement.kind === "call") {
    // A call inside a namespace can name a function of the namespace without it.
    const callee = statement.spelling ?? context.call?.(statement.callee) ?? statement.callee;
    return statement.literal === undefined
      ? `${callee}(${left}) + ${offset}`
      : `${callee}(${statement.literal}) + ${left}`;
  }
  if (statement.kind === "constant")
    return `${left} * ${context.name(statement.constant)} + ${offset}`;
  throw new Error(`Unknown statement kind ${statement.kind}`);
}

/** The lines of one body item at a nesting depth. */
function itemLines(item, depth, context) {
  const pad = "  ".repeat(depth);
  if (item.type === "let") {
    const text = `long long ${item.variable} = (${expressionText(item, context)}) % kModulus;`;
    // E sites: a comment above the edited line. A trap uses a tab, trailing spaces
    // and a no-break space; these are the only such characters in the file.
    if (item.format === "trap") return [`\t// ${item.comment.join("\u00a0")}`, `\t${text}  `];
    if (item.format === "control") return [`${pad}// ${item.comment.join(" ")}`, pad + text];
    return [pad + text];
  }
  if (item.type === "raw") return item.lines;
  throw new Error(`Unknown body item ${item.type}`);
}

/** One edit as a mechanical instruction of exact text. */
function instruction(edit) {
  if (edit.kind === "rename")
    return `In main.cpp, replace every occurrence of the identifier ${q(edit.name)} with ${q(edit.newName)}; there are ${edit.occurrences} occurrences. Longer identifiers that contain this spelling stay unchanged.`;
  if (edit.kind === "function-rename" && edit.cluster === "u")
    return `In main.cpp, rename the function ${q(signature(edit.name))} of the global namespace to ${q(edit.newName)}: change its prototype, its definition and every call of it. The functions of the namespace ${q(edit.namespace)} and the calls of them stay unchanged.`;
  if (edit.kind === "function-rename")
    return `In main.cpp, rename the function ${q(edit.name)} to ${q(edit.newName)}: change its prototype, its definition and every call of it. Comments and string literals that mention the function stay unchanged.`;
  if (edit.kind === "prune")
    return `In main.cpp, delete the complete definition of every function in the namespace ${q(edit.namespace)} that no code calls, and the empty line that directly followed each deleted definition. Keep the namespace and the functions that are called.`;
  if (edit.kind === "file-delete")
    return `In ${edit.file}, delete the complete definition of the function ${q(signature(edit.name))}. Also delete the empty line that directly followed the definition.`;
  if (edit.kind === "file-insert")
    return `In ${edit.file}, replace the placeholder line ${q(edit.marker)} with the following ${edit.lines} lines: ${q(edit.text)}.`;
  if (edit.kind === "factor-shift")
    return `In main.cpp, in the definition of the function ${q(signature(edit.host))}, add ${FACTOR_STEP} to every integer literal that multiplies a variable. The other numbers stay unchanged.`;
  if (edit.kind === "reorder")
    return `In main.cpp, reorder the function definitions in the namespace ${q(edit.namespace)} so that they stand in alphabetical order of their names. Keep each definition unchanged, with one empty line between definitions.`;
  if (edit.kind === "region-extract")
    return `In main.cpp, move the region that starts with the line ${q(edit.open)} into a new file ${edit.file}. The region ends with the line ${q(REGION_END)} that closes it. The new file holds the lines between those two lines, unchanged, each line ending with a newline. In main.cpp, replace the region, its first and last lines included, with the line ${q(`#include "${edit.file}"`)}.`;
  if (edit.kind === "batch-move") {
    // The prompt lists the functions in alphabetical order, not in file order.
    const listed = [...edit.names].sort().map((name) => q(signature(name)));
    const list = `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`;
    return `In main.cpp, move the complete definitions of the functions ${list} to the placeholder line ${q(edit.marker)}: the definitions replace that placeholder line, in the order in which they stand in main.cpp now, with one empty line between two definitions. Also delete the empty line that directly followed each definition in its old place. Keep the text of each definition unchanged.`;
  }
  if (edit.kind === "move" && edit.cluster === "s")
    return `In main.cpp, move the complete definition of the function ${q(signature(edit.name))} that stands between the lines ${q("#else")} and ${q("#endif")} to the placeholder line ${q(edit.marker)}: the definition replaces that placeholder line. Also delete the empty line that directly followed the definition in its old place. Keep the text of the definition unchanged.`;
  if (edit.kind === "move")
    return `In main.cpp, move the complete definition of the function ${q(signature(edit.name))} to the placeholder line ${q(edit.marker)}: the definition replaces that placeholder line. Also delete the empty line that directly followed the definition in its old place. Keep the text of the definition unchanged.`;
  if (edit.kind === "insert")
    return `In main.cpp, replace the placeholder line ${q(edit.marker)} with the following ${edit.lines} lines: ${q(edit.text)}.`;
  if (edit.kind === "member-delete")
    return `In main.cpp, delete the complete definition of the member function ${q(`${signature(edit.name)} const`)} in the class ${q(edit.cls)}. Also delete the empty line that directly followed the definition.`;
  if (edit.kind === "block-delete")
    return `In main.cpp, delete the complete definition that starts with the line ${q(edit.firstLine)}. Also delete the empty line that directly followed the definition.`;
  if (edit.kind === "branch-replace")
    return `In main.cpp, in the definition of the function ${q(signature(edit.host))}, in the block of the branch ${q(edit.branch)}, replace ${q(edit.before)} with ${q(edit.after)}. That block holds it once.`;
  if (edit.kind === "constructor-delete")
    return `In main.cpp, delete the complete definition of the constructor ${q(edit.signature)} of the class ${q(edit.cls)}. Also delete the empty line that directly followed the definition.`;
  if (edit.kind === "template-delete")
    return `In main.cpp, delete the complete definition of the function template ${q(edit.name)}. Also delete the empty line that directly followed the definition.`;
  const replacement = `replace ${q(edit.before)} with ${q(edit.after)}. The definition holds it once.`;
  if (edit.kind === "overload-replace")
    return `In main.cpp, in the definition of the member function ${q(edit.signature)} of the class ${q(edit.cls)}, ${replacement}`;
  if (edit.kind === "member-replace" || edit.kind === "override-replace")
    return `In main.cpp, in the definition of the member function ${q(`${signature(edit.name)} const`)} of the class ${q(edit.cls)}, ${replacement}`;
  if (edit.cluster === "P")
    return `In main.cpp, main passes the argument ${edit.argument} to exactly one function. In the definition of that function, ${replacement}`;
  if (edit.cluster === "Q")
    return `In main.cpp, exactly one function calls the function ${q(edit.callee)}. In the definition of that calling function, ${replacement}`;
  if (edit.cluster === "R")
    return `In main.cpp, in the function definition that directly follows the definition of the function ${q(signature(edit.anchor))}, ${replacement}`;
  if (edit.cluster === "S")
    return `In main.cpp, exactly one function uses the constant ${q(edit.constant)}. In the definition of that function, ${replacement}`;
  if (edit.kind === "scoped-replace")
    return `In main.cpp, in the definition of the function ${q(signature(edit.host))}, ${replacement}`;
  if (edit.kind === "delete" || edit.kind === "disabled-delete")
    return `In main.cpp, delete the complete definition of the function ${q(signature(edit.name))}. Also delete the empty line that directly followed the definition.`;
  if (edit.kind === "local-rename")
    return `In main.cpp, in the definition of the function ${q(signature(edit.name))}, rename the local variable ${q(edit.local)} to ${q(edit.newName)}: replace each of its ${edit.occurrences} occurrences in that definition.`;
  if (edit.kind === "namespace-delete")
    return `In main.cpp, delete the complete definition of the function ${q(signature(edit.name))} in the namespace ${q(edit.namespace)}. Also delete the empty line that directly followed the definition.`;
  if (edit.kind === "commented-delete")
    return `In main.cpp, delete the complete definition of the function ${q(signature(edit.name))} together with the comment lines directly above it. Also delete the empty line that directly followed the definition.`;
  if (edit.kind === "bulk-delete")
    return `In main.cpp, delete each line that calls the function ${q(edit.name)}; there are ${edit.occurrences} lines. Keep its definition.`;
  return `In main.cpp, replace its one occurrence of ${q(edit.before)} with ${q(edit.after)}.`;
}

/** The frame of the original suite's prompts around one instruction. */
function mechanicalPrompt(text) {
  return [
    "Perform only the following mechanical file edits. The required change is fully specified; no bug investigation is needed.",
    "All file paths are relative to the current working directory. Open explicitly named files directly; search for their location only if the supplied path cannot be resolved. Searching within files for the requested content is allowed.",
    "Quoted text in this request uses JSON string notation: decode escapes to the actual characters. Treat it as literal text, not a regular expression.",
    text,
    "Leave all text outside the requested edits unchanged. Do not create extra files. Choose any available tools. Complete the edits and then finish.",
  ].join("\n\n");
}

const KIND = {
  A: "rename",
  B: "move",
  C: "move",
  D: "insert",
  E: "expression",
  F: "scoped-replace",
  G: "local-rename",
  H: "delete",
  I: "scoped-replace",
  // J pairs a move with an expression edit; see generateChecksumProject.
  J: "move",
  K: "namespace-delete",
  // L gives two neighbours an insert each; see generateChecksumProject.
  L: "commented-delete",
  M: "bulk-delete",
  N: "delete",
  O: "move",
  // P, Q, R and S replace an expression in a function the prompt names by a property.
  P: "scoped-replace",
  Q: "scoped-replace",
  R: "scoped-replace",
  S: "scoped-replace",
  T: "function-rename",
  U: "prune",
  V: "prune",
  // W and X delete a function from a file of its own that main.cpp includes.
  W: "file-delete",
  X: "file-delete",
  Y: "file-delete",
  a: "file-delete",
  // Z adds a step to every factor of one function.
  Z: "factor-shift",
  // b replaces a string literal's text that a decoy above it seems to repeat.
  b: "literal-replace",
  c: "reorder",
  // d inserts a rule into a makefile beside main.cpp.
  d: "file-insert",
  // e deletes a member function of a class, f replaces an expression in one, g in one
  // branch of an if chain, h deletes a definition named by its first line, and i
  // moves a function with a lambda.
  e: "member-delete",
  f: "member-replace",
  g: "branch-replace",
  h: "block-delete",
  i: "move",
  // j replaces an expression in one overload, k deletes a constructor, l a function
  // template, and m replaces an expression in an override.
  j: "overload-replace",
  k: "constructor-delete",
  l: "template-delete",
  m: "override-replace",
  // n deletes a function below a disabled copy; o and p replace an expression in a
  // function whose signature a friend declaration or a comment repeats above.
  n: "disabled-delete",
  o: "scoped-replace",
  p: "scoped-replace",
  // q moves a function to a slot that a note above repeats, r moves a region into a
  // file of its own, s moves a function out of an #else branch, t moves four
  // functions to one slot, and u renames a global function that a namespace
  // function shares its name with.
  q: "move",
  r: "region-extract",
  s: "move",
  t: "batch-move",
  u: "function-rename",
};
// The line that closes a region.
const REGION_END = "#pragma endregion";
// The first line of the region nested in an r trap's region.
const NESTED_REGION = "#pragma region details";
// The note after an earlier slot's text on a q decoy line.
const SLOT_NOTE = "  // reserved for a later move";
// The branch whose block a g edit changes.
const BRANCH = "else if ((a + j) % 3 == 1)";
// The step a Z edit adds to each factor.
const FACTOR_STEP = 1000;
// The UTF-8 byte order mark of an X trap's file. Files beside main.cpp are byte
// strings: one character per byte.
const BOM = "\xef\xbb\xbf";
// The comment of a kept function in an a file; a trap's holds a Latin-1 degree sign.
const MEASURED = { trap: "  // Measured at 20\xb0C.", control: "  // Measured at 20 degrees C." };
// Functions in a c namespace.
const REORDERED = { trap: 12, control: 3 };
// String literals of b functions, in composed form. Each holds a letter with a
// diacritic, so its decomposed form differs.
const PHRASES = [
  "caf\u00e9 menu",
  "r\u00e9sum\u00e9 draft",
  "cr\u00e8me br\u00fbl\u00e9e",
  "pi\u00f1ata stock",
  "\u00fcber mode",
  "na\u00efve guess",
  "d\u00e9j\u00e0 vu",
  "jalape\u00f1o mix",
  "fa\u00e7ade plan",
  "se\u00f1or table",
  "fianc\u00e9e note",
  "p\u00e2t\u00e9 board",
  "co\u00f6perate flag",
  "ma\u00f1ana queue",
];
// Namespace names of U, V and c edits.
const PRUNED_NAMESPACES = [
  "diag",
  "debug",
  "inspect",
  "survey",
  "sample",
  "monitor",
  "bench",
  "stats",
  "checks",
  "metrics",
  "report",
  "timing",
  "profile",
  "verify",
  "health",
  "status",
  "archive",
  "ledger",
  "catalog",
  "digest",
  "roster",
  "journal",
  "atlas",
  "registry",
];
// Namespace names of u edits.
const OWNER_NAMESPACES = [
  "engine",
  "codec",
  "parser",
  "render",
  "scene",
  "storage",
  "network",
  "physics",
  "audio",
  "input",
  "script",
  "shader",
];
// Namespace names of K edits: the first namespace of a pair in the file holds the
// decoy, the second the target.
const NAMESPACES = [
  ["fast", "slow"],
  ["draft", "release"],
  ["legacy", "modern"],
  ["local", "remote"],
  ["primary", "backup"],
  ["front", "back"],
  ["north", "south"],
  ["cold", "warm"],
  ["coarse", "fine"],
  ["stable", "preview"],
  ["east", "west"],
  ["upstream", "downstream"],
];
// Comment lines above L functions; each gets its own number.
const NOTES = [
  "Kept for report format",
  "Owner note",
  "Checked against batch",
  "Superseded with the table lookup in step",
  "Retired with input range",
  "Do not inline, see ticket",
];
// Functions whose calls an M edit deletes.
const TRACE_VERBS = ["trace", "audit", "probe", "record"];
const TRACE_NOUNS = ["entry", "exit", "step", "state"];
// Lines that call an M trap's or an M control's function.
const BULK_LINES = { trap: 32, control: 3 };
// String literals of an L neighbour's supplied function.
const SHIFT_LITERALS = 20;
// New names of G variables; no other identifier uses them.
const LOCAL_NAMES = ["carry", "pivot", "tally", "stage", "inner", "accum", "blend", "sweep"];
// Original names of G control variables, used by no other function.
const UNIQUE_LOCALS = ["bq", "bx", "bk", "bj", "bv", "bw", "bz", "by"];
// Words in the C functions' strings.
const LAYOUT_KINDS = ["grid", "panel", "table", "chart", "frame", "board"];
// Third words of function names in a large file.
const NAME_SUFFIXES = ["core", "aux", "edge", "path", "node", "link", "hub", "tip", "arc", "rim"];
// The note above an N function's commented-out earlier version.
const OLD_VERSION_NOTE = "// Previous version, kept until the new one is verified:";

/** Generate one project with its tasks and references. */
export function generateChecksumProject(seed, options = {}) {
  assert.ok(Number.isSafeInteger(seed) && seed >= 0, "Seed must be a non-negative integer");
  /** @type {{ clusters: string, perVariant: number, density: number, edits: number, lines: number }} */
  const counts = { ...CHECKSUM_PROJECT_DEFAULTS, ...options };
  for (const key of ["perVariant", "density", "edits"])
    assert.ok(Number.isSafeInteger(counts[key]) && counts[key] >= 1, `${key} must be positive`);
  assert.ok(Number.isSafeInteger(counts.lines) && counts.lines >= 0, "lines must not be negative");
  // A compact file puts the edits' functions side by side, with no fillers between
  // them. The option stands in the counts only when it is set, so other projects
  // keep their counts.
  assert.ok([undefined, true, false].includes(options.compact), "compact must be a boolean");
  const compact = options.compact === true;
  assert.ok(!compact || counts.lines === 0, "A compact file has no size option");
  const clusters = [...new Set(counts.clusters)].sort();
  assert.ok(
    clusters.length > 0 && clusters.every((cluster) => cluster in CHECKSUM_CLUSTERS),
    `Unknown clusters ${counts.clusters}`,
  );
  const random = generator(seed);

  // Distinct numbers keep every changed expression unique in the file; more edits
  // and a larger file draw them from a wider range. A J pair counts two edits and an
  // L group three.
  const taken = new Set();
  const editCount =
    2 *
    counts.perVariant *
    clusters.reduce((sum, cluster) => sum + ({ J: 2, L: 3 }[cluster] ?? 1), 0);
  const highest = Math.max(1999, 60 * editCount) + 4 * counts.lines;
  const number = () => {
    assert.ok(taken.size < (highest - 11) / 2, "Too few distinct numbers");
    for (;;) {
      const value = random.integer(11, highest);
      if (!taken.has(value)) {
        taken.add(value);
        return value;
      }
    }
  };
  const vocabulary = (first, second) =>
    random.shuffle(first.flatMap((word) => second.map((other) => `${word}_${other}`)));
  const twoWords = vocabulary(ADJECTIVES, NOUNS);
  const functionNames = [...twoWords];
  // A large file needs more names: three-word names come after the two-word ones run
  // out, so a project without the size option keeps its names. A project with many
  // edits adds them once the two-word names run out.
  let extended = counts.lines > 0;
  if (extended) functionNames.unshift(...vocabulary(twoWords, NAME_SUFFIXES));
  const constantNames = vocabulary(CONSTANT_WORDS, CONSTANT_SUFFIXES);
  const take = (names) => {
    if (names === functionNames && names.length === 0 && !extended) {
      extended = true;
      names.push(...vocabulary(twoWords, NAME_SUFFIXES));
    }
    const name = names.pop();
    assert.ok(name, "Name vocabulary exhausted");
    return name;
  };

  // Edits, then zones in a random order. A zone holds the edits of `density` tasks,
  // so that many agents work in it at the same moment.
  const edits = [];
  for (const cluster of clusters)
    for (const variant of ["trap", "control"])
      for (let index = 1; index <= counts.perVariant; index++) {
        edits.push({ cluster, variant, kind: KIND[cluster] });
        // A J pair: one agent moves a function, another changes an expression.
        if (cluster === "J")
          edits.push({ cluster, variant, kind: "expression", partner: edits.at(-1) });
        // An L group: one agent deletes a function, two neighbours insert text.
        if (cluster === "L") {
          const partner = edits.at(-1);
          edits.push({ cluster, variant, kind: "insert", partner });
          edits.push({ cluster, variant, kind: "insert", partner });
        }
      }
  assert.equal(edits.length % counts.edits, 0, "Edits do not divide into tasks");
  const zones = [];
  const ordered = random.shuffle(edits);
  // Neutral ids: an agent can see the id in its working directory.
  ordered.forEach((edit, index) => (edit.id = `edit-${String(index + 1).padStart(2, "0")}`));
  const zoneSize = counts.density * counts.edits;
  for (let first = 0; first < ordered.length; first += zoneSize)
    zones.push(ordered.slice(first, first + zoneSize));
  zones.forEach((zone, index) => zone.forEach((edit) => (edit.zone = index + 1)));
  const ofCluster = (cluster) => edits.filter((edit) => edit.cluster === cluster);

  // A: global constants. A trap has two longer identifiers that contain its spelling.
  const constants = [];
  const fillerUses = [];
  for (const edit of ofCluster("A")) {
    edit.name = take(constantNames);
    edit.newName = take(constantNames);
    // Occurrences: the declaration, one use in the zone's host, the rest in fillers.
    edit.occurrences = random.integer(12, 20);
    constants.push({ name: edit.name, value: random.integer(2, 97) });
    for (let use = 0; use < edit.occurrences - 2; use++) fillerUses.push(edit.name);
    edit.lookAlikes = edit.variant === "trap" ? [`${edit.name}_limit`, `max_${edit.name}`] : [];
    for (const name of edit.lookAlikes) {
      constants.push({ name, value: random.integer(2, 97) });
      for (let use = random.integer(3, 5); use > 0; use--) fillerUses.push(name);
    }
  }
  const values = new Map(constants.map(({ name, value }) => [name, value]));

  // Functions. A plan lists one entry per declaration: "plain", a constant use or an
  // E site.
  const functions = [];
  const library = [];
  const build = (
    name,
    plan,
    { callees = library.map((entry) => entry.name), prototyped, variables = VARIABLES },
  ) => {
    const body = [];
    const available = ["value"];
    for (const [index, entry] of plan.entries()) {
      const variable = variables[index];
      assert.ok(variable, "Too many declarations in one function");
      const left = available[available.length - 1];
      const right = random.pick(available);
      const base = { type: "let", id: `${name}:${variable}`, variable, left, right };
      let statement;
      if (entry === "plain") {
        const kinds = ["linear", "linear", "product", "mix"];
        if (callees.length > 0) kinds.push("call");
        const kind = random.pick(kinds);
        statement = { ...base, kind };
        if (kind === "linear" || kind === "mix") statement.factor = number();
        if (kind !== "mix") statement.offset = number();
        if (kind === "call") statement.callee = random.pick(callees);
      } else if (entry.constant)
        statement = { ...base, kind: "constant", constant: entry.constant, offset: number() };
      // A call of one named function, or of a library function with a number.
      else if (entry.callee || entry.literal !== undefined)
        statement = {
          ...base,
          kind: "call",
          callee: entry.callee ?? random.pick(callees),
          spelling: entry.spelling,
          literal: entry.literal,
          offset: number(),
        };
      else if (entry.scoped) {
        // An F site: a plain line whose text other functions may repeat.
        statement = { ...base, kind: "linear", factor: number(), offset: number() };
        Object.assign(entry.scoped, {
          host: name,
          position: index,
          statement: statement.id,
          factor: statement.factor,
          before: expressionText(statement, { factors: new Map() }),
        });
      } else if (entry.shift) {
        // A Z declaration, whose factor the edit changes; a trap writes one of them
        // with its factor first.
        statement = { ...base, kind: "linear", factor: number(), offset: number() };
        if (entry.swapped) statement.swapped = true;
        entry.shift.shifts.push({
          statement: statement.id,
          newFactor: statement.factor + FACTOR_STEP,
        });
      } else {
        statement = {
          ...base,
          kind: "linear",
          factor: number(),
          offset: number(),
          format: entry.site.variant,
          comment: random.pick(COMMENTS),
        };
        entry.site.statement = statement.id;
        entry.site.factor = statement.factor;
        entry.site.before = expressionText(statement, { factors: new Map() });
      }
      body.push(statement);
      available.push(variable);
    }
    const result = [available[available.length - 1], random.pick(available.slice(0, -1))];
    const entry = { name, body, result, prototyped };
    functions.push(entry);
    return entry;
  };
  const plain = (length) => Array.from({ length }, () => "plain");
  // The text of a supplied function, given its string literals as they stand in
  // main.cpp.
  const supplied = (name, literals) => {
    const lines = [
      header(name),
      "  const char* labels[] = {",
      ...literals.map((literal) => `    "${literal}",`),
      "  };",
      `  long long total = (value * ${number()} + ${number()}) % kModulus;`,
      "  for (const char* label : labels)",
      "    for (const char* p = label; *p != 0; ++p) total = (total * 31 + *p) % kModulus;",
      "  return total;",
      "}",
    ];
    return { text: lines.join("\n"), lines: lines.length };
  };

  // Fillers hold the constant uses that are not in a host; the first few are the
  // library. There are enough fillers to keep zones and slots apart at density 1,
  // and one more for each host that a higher density saves, so the file keeps its
  // size across densities.
  const moves = edits.filter(({ kind }) => kind === "move");
  // J pairs, K namespace pairs, L groups and N functions with their commented-out
  // copies stand in gaps of their own.
  const ownGaps =
    ofCluster("J").length / 2 +
    ofCluster("K").length +
    ofCluster("L").length / 3 +
    ofCluster("N").length +
    // P, R and S stand with a decoy or an anchor; Q also has a helper of its own.
    ofCluster("P").length +
    2 * ofCluster("Q").length +
    ofCluster("R").length +
    ofCluster("S").length +
    // T stands in two gaps, U and V with their callers in one.
    2 * ofCluster("T").length +
    ofCluster("U").length +
    ofCluster("V").length +
    // A W, X, Y or a file's include line stands in a gap of its own, and so do a Z
    // function, a b pair and a c namespace. A d makefile is not in main.cpp.
    ofCluster("W").length +
    ofCluster("X").length +
    ofCluster("Y").length +
    ofCluster("a").length +
    ofCluster("Z").length +
    ofCluster("b").length +
    ofCluster("c").length +
    // An e pair of classes, an f class, a g function and an h definition too.
    ofCluster("e").length +
    ofCluster("f").length +
    ofCluster("g").length +
    ofCluster("h").length +
    // A j, k or m class and an l template too.
    ofCluster("j").length +
    ofCluster("k").length +
    ofCluster("l").length +
    ofCluster("m").length +
    // An n function with its copy, an o class with its function and a p pair too.
    ofCluster("n").length +
    ofCluster("o").length +
    ofCluster("p").length +
    // An r region and an s #if block too; a t edit has four functions and a slot,
    // and a u edit its function with its caller and a namespace.
    ofCluster("r").length +
    ofCluster("s").length +
    5 * ofCluster("t").length +
    2 * ofCluster("u").length;
  // A compact file has only the fillers that something needs: the library, room for
  // the constant uses, and two F decoys per F trap. They are longer, so there are
  // fewer of them, and their first declarations, where F sites stand, hold no
  // constant use, so every filler can be a decoy.
  const reserved = compact ? zoneSize + 2 : 0;
  assert.ok(reserved + 4 <= VARIABLES.length, "A compact file allows zones of at most 14 edits");
  const decoys = 2 * ofCluster("F").filter(({ variant }) => variant === "trap").length;
  const lengths = [];
  while (
    lengths.length <
      (compact
        ? Math.max(LIBRARY_SIZE, decoys)
        : Math.max(LIBRARY_SIZE, 2 * edits.length - zones.length + moves.length + ownGaps - 1)) ||
    lengths.reduce((sum, length) => sum + Math.max(0, length - reserved), 0) <
      fillerUses.length * 1.4
  )
    lengths.push(
      compact
        ? Math.min(VARIABLES.length, random.integer(reserved + 8, reserved + 14))
        : random.integer(3, 5),
    );
  // The size option adds longer fillers until they alone reach the line count; a
  // filler takes its declarations, three more lines and an empty line.
  while (lengths.reduce((sum, length) => sum + length + 4, 0) < counts.lines)
    lengths.push(random.integer(8, 16));
  const plans = lengths.map(plain);
  const places = random.shuffle(
    plans.flatMap((plan, filler) =>
      plan.flatMap((_, index) => (index < reserved ? [] : [[filler, index]])),
    ),
  );
  fillerUses.forEach((constant, index) => {
    const [filler, at] = places[index];
    plans[filler][at] = { constant };
  });
  const fillers = plans.map((plan, index) => {
    const entry = build(take(functionNames), plan, {
      callees: index < LIBRARY_SIZE ? library.map(({ name }) => name) : undefined,
      prototyped: index < LIBRARY_SIZE,
    });
    if (index < LIBRARY_SIZE) library.push(entry);
    return entry;
  });

  // Hosts: one per zone, with the zone's A uses and E and F sites on neighbouring
  // lines.
  const hosts = zones.map((zone) => {
    const sites = zone
      .filter(({ cluster }) => "AEF".includes(cluster))
      .map((edit) =>
        edit.cluster === "A"
          ? { constant: edit.name }
          : edit.cluster === "E"
            ? { site: edit }
            : { scoped: edit },
      );
    return build(take(functionNames), ["plain", ...random.shuffle(sites), "plain"], {
      prototyped: false,
    });
  });

  // B: moved functions; a trap has a prototype.
  for (const edit of ofCluster("B"))
    edit.name = build(take(functionNames), plain(random.integer(2, 4)), {
      prototyped: edit.variant === "trap",
    }).name;

  // C: moved functions that scan a string for one character. In a trap that
  // character is a closing brace, so counting braces in the text, without reading
  // literals, ends the definition in the middle of its body, and nothing reports
  // it; a control scans for a closing bracket. Nothing calls them, so the scan does
  // not enter the checksum.
  for (const edit of ofCluster("C")) {
    const name = take(functionNames);
    const kind = random.pick(LAYOUT_KINDS);
    const target = edit.variant === "trap" ? "}" : "]";
    const lines = [
      `  const char* layout = "${kind}: ${random.integer(2, 99)}, ${random.integer(2, 99)}";`,
    ];
    const scan = [
      "  for (const char* p = layout; *p != 0; ++p)",
      `    if (*p == '${target}') a = (a * 31 + ${random.integer(2, 99)}) % kModulus;`,
    ];
    functions.push({
      name,
      uncalled: true,
      body: [
        { type: "raw", lines },
        {
          type: "let",
          id: `${name}:a`,
          variable: "a",
          kind: "linear",
          left: "value",
          factor: number(),
          offset: number(),
        },
        {
          type: "raw",
          lines: scan,
        },
      ],
      result: ["a", "value"],
      prototyped: false,
    });
    edit.name = name;
  }

  // G: functions with one local variable to rename. A trap's variable is "b", which
  // every other function also declares; a control's name is its own.
  const locals = random.shuffle(UNIQUE_LOCALS);
  const newLocals = random.shuffle(LOCAL_NAMES);
  for (const edit of ofCluster("G")) {
    edit.local = edit.variant === "trap" ? "b" : take(locals);
    edit.newName = take(newLocals);
    const variables = [VARIABLES[0], edit.local, ...VARIABLES.slice(2).split("")];
    edit.name = build(take(functionNames), plain(4), { prototyped: false, variables }).name;
  }

  // J: a move and an expression edit given to two agents at once. In a trap the
  // expression is inside the moved function, so an agent that writes the function
  // from a copy read before its partner's edit loses that edit; in a control it is
  // in the function right next to it. Every order of the two edits gives the same
  // file.
  const pairs = [];
  for (const edit of ofCluster("J").filter(({ kind }) => kind === "expression")) {
    const site = { scoped: edit };
    const mover = build(
      take(functionNames),
      edit.variant === "trap" ? ["plain", site, "plain"] : plain(3),
      { prototyped: false },
    );
    edit.partner.name = mover.name;
    const unit = [{ function: mover.name }];
    if (edit.variant === "control")
      unit.push({
        function: build(take(functionNames), ["plain", site, "plain"], { prototyped: false }).name,
      });
    pairs.push(random.shuffle(unit));
  }

  // K: a function to delete in the second of two namespaces with two functions
  // each. In a trap the first namespace holds a function with the same signature,
  // so the first match of the signature is the wrong definition, and deleting it
  // still builds; in a control the first namespace's function has another name.
  // Nothing calls them.
  const namespaces = random.shuffle(NAMESPACES);
  const namespaced = (space, name) => {
    const entry = build(`${space}::${name}`, plain(random.integer(2, 4)), { prototyped: false });
    Object.assign(entry, { display: name, uncalled: true });
    return { function: entry.name };
  };
  const namespaceBlock = (space, members) => [
    { raw: `namespace ${space} {` },
    ...random.shuffle(members),
    { raw: `}  // namespace ${space}` },
  ];
  for (const edit of ofCluster("K")) {
    const pair = namespaces.pop();
    assert.ok(pair, "Namespace names exhausted");
    [edit.decoy, edit.namespace] = pair;
    edit.name = take(functionNames);
    edit.key = `${edit.namespace}::${edit.name}`;
    const decoyName = edit.variant === "trap" ? edit.name : take(functionNames);
    pairs.push([
      ...namespaceBlock(edit.decoy, [
        namespaced(edit.decoy, decoyName),
        namespaced(edit.decoy, take(functionNames)),
      ]),
      ...namespaceBlock(edit.namespace, [
        namespaced(edit.namespace, edit.name),
        namespaced(edit.namespace, take(functionNames)),
      ]),
    ]);
  }

  // L: a function to delete with the comment lines above it, whose number the
  // prompt does not give, so the agent reads the file before it edits. In the same
  // wave two neighbours each insert a long function next to it: above it in a trap,
  // which moves its lines down between the agent's read and its edit, and below it
  // in a control. Nothing calls these functions.
  const shifted = [];
  for (const edit of ofCluster("L").filter(({ kind }) => kind === "commented-delete")) {
    const entry = build(take(functionNames), plain(random.integer(2, 4)), { prototyped: false });
    entry.uncalled = true;
    entry.comment = random
      .shuffle(NOTES)
      .slice(0, random.integer(2, 5))
      .map((note) => `// ${note} ${number()}.`);
    Object.assign(edit, { name: entry.name, comment: entry.comment });
    shifted.push(edit);
  }
  for (const edit of ofCluster("L").filter(({ kind }) => kind === "insert")) {
    const name = take(functionNames);
    const literals = Array.from(
      { length: SHIFT_LITERALS },
      () => `${random.pick(ADJECTIVES)} ${random.pick(NOUNS)} ${number()}`,
    );
    Object.assign(edit, { name }, supplied(name, literals));
  }

  // N: functions to delete, each with a commented-out earlier version in the
  // paragraph above it. A trap's earlier version has the same signature, so the first
  // match of the signature is inside the comment, whose braces balance and which ends
  // before an empty line: deleting it still builds. A control's earlier version had
  // another name. Nothing calls these functions.
  for (const edit of ofCluster("N")) {
    const entry = build(take(functionNames), plain(random.integer(2, 4)), { prototyped: false });
    entry.uncalled = true;
    edit.name = entry.name;
    const old = edit.variant === "trap" ? entry.name : take(functionNames);
    const lines = [header(old)];
    const steps = ["a", "c", "d"].slice(0, random.integer(2, 3));
    steps.forEach((variable, step) => {
      const left = step === 0 ? "value" : steps[step - 1];
      lines.push(`  long long ${variable} = (${left} * ${number()} + ${number()}) % kModulus;`);
    });
    lines.push(`  return ${steps.at(-1)};`, "}");
    edit.copy = [OLD_VERSION_NOTE, ...lines.map((line) => `// ${line}`)].join("\n");
    pairs.push([{ raw: edit.copy }, { function: entry.name }]);
  }

  // O: moved functions with a raw string literal that holds a line of its own and an
  // empty line after it. In a trap that line is a lone closing brace, so both
  // counting braces and taking the first lone "}" end the definition inside the
  // literal, right before an empty line, as if it were the definition's end; a
  // control's line is a lone "]". Nothing calls them, so the literal does not enter
  // the checksum.
  for (const edit of ofCluster("O")) {
    const name = take(functionNames);
    const closing = edit.variant === "trap" ? "}" : "]";
    functions.push({
      name,
      uncalled: true,
      body: [
        { type: "raw", lines: ['  const char* closing = R"(', closing, "", ')";'] },
        {
          type: "let",
          id: `${name}:a`,
          variable: "a",
          kind: "linear",
          left: "value",
          factor: number(),
          offset: number(),
        },
        {
          type: "raw",
          lines: ["  for (const char* p = closing; *p != 0; ++p) a = (a * 31 + *p) % kModulus;"],
        },
      ],
      result: ["a", "value"],
      prototyped: false,
    });
    edit.name = name;
  }

  // P, Q and S: one expression to replace inside a function that the prompt names
  // only by a property: main passes it a given number (P), it is the only function
  // that calls a given function (Q), or it is the only function that uses a given
  // constant (S). A decoy function above it holds the same expression. In a trap
  // the decoy also holds the property's text where it is not the property: the
  // number as another call's argument, a call in a comment, or the constant's name
  // in a string literal. A control's decoy holds another number, name or word there.
  const located = (edit, plan, decoy) => {
    const target = build(take(functionNames), plan, { prototyped: false });
    const copy = build(take(functionNames), decoy, { prototyped: false });
    const statement = copy.body[edit.position];
    Object.assign(statement, {
      kind: "linear",
      factor: edit.factor,
      offset: Number(edit.before.split(" + ")[1]),
    });
    edit.decoy = copy.name;
    pairs.push([{ function: copy.name }, { function: target.name }]);
    return { target, copy };
  };
  for (const edit of ofCluster("P")) {
    // The decoy's number is set once main has its arguments.
    const { copy } = located(
      edit,
      ["plain", { scoped: edit }, "plain"],
      ["plain", "plain", { literal: 0 }],
    );
    edit.literalCall = copy.body[2];
  }
  for (const edit of ofCluster("Q")) {
    // A helper with a prototype that only the target calls: library calls never
    // pick it, and main does not call it.
    const helper = build(take(functionNames), plain(random.integer(2, 3)), {
      callees: [],
      prototyped: true,
    });
    helper.uncalled = true;
    edit.callee = helper.name;
    pairs.push([{ function: edit.callee }]);
    const { copy } = located(
      edit,
      ["plain", { scoped: edit }, { callee: edit.callee }],
      ["plain", "plain", "plain"],
    );
    const commented = edit.variant === "trap" ? edit.callee : take(functionNames);
    copy.body.splice(2, 0, {
      type: "raw",
      lines: [`  // long long c = (${commented}(b) + ${number()}) % kModulus;  // disabled`],
    });
  }
  for (const edit of ofCluster("S")) {
    edit.constant = take(constantNames);
    const value = random.integer(2, 97);
    constants.push({ name: edit.constant, value });
    values.set(edit.constant, value);
    const { copy } = located(
      edit,
      ["plain", { scoped: edit }, { constant: edit.constant }],
      ["plain", "plain", "plain"],
    );
    // The decoy reads its label, so nothing calls it and the label stays out of
    // the checksum.
    const word = edit.variant === "trap" ? edit.constant : take(constantNames);
    copy.uncalled = true;
    copy.body.unshift({ type: "raw", lines: [`  const char* label = "${word} is tuned";`] });
    copy.body.push({
      type: "raw",
      lines: ["  for (const char* p = label; *p != 0; ++p) a = (a * 31 + *p) % kModulus;"],
    });
  }

  // T: a function to rename in code only: its prototype, its definition, the calls
  // in its two callers and main's call. A trap's function is also named in a comment
  // of one caller and in a string literal of a function that nothing calls, and both
  // stay unchanged; a control's comment and literal name a function that does not
  // exist.
  for (const edit of ofCluster("T")) {
    edit.name = build(take(functionNames), plain(random.integer(2, 4)), { prototyped: true }).name;
    edit.newName = take(functionNames);
    const mention = edit.variant === "trap" ? edit.name : take(functionNames);
    const callers = [0, 1].map(() =>
      build(take(functionNames), ["plain", { callee: edit.name }, "plain"], {
        prototyped: false,
      }),
    );
    const comment = `  // Calls ${mention}(a) once; keep it cheap.`;
    callers[0].body.splice(1, 0, { type: "raw", lines: [comment] });
    const label = `  const char* label = "${mention} feeds the total";`;
    const reporter = take(functionNames);
    functions.push({
      name: reporter,
      uncalled: true,
      body: [
        { type: "raw", lines: [label] },
        {
          type: "let",
          id: `${reporter}:a`,
          variable: "a",
          kind: "linear",
          left: "value",
          factor: number(),
          offset: number(),
        },
        {
          type: "raw",
          lines: ["  for (const char* p = label; *p != 0; ++p) a = (a * 31 + *p) % kModulus;"],
        },
      ],
      result: ["a", "value"],
      prototyped: false,
    });
    edit.mentions = [comment, label];
    pairs.push(
      random.shuffle([{ function: edit.name }, { function: callers[0].name }]),
      random.shuffle([{ function: callers[1].name }, { function: reporter }]),
    );
  }

  // U: the functions of a namespace that no code calls, to delete. Of four
  // functions, a caller right after the namespace calls two. The caller also holds a
  // commented-out call: in a trap of a function to delete, so a search for its calls
  // finds one; in a control of a called function.
  const pruned = random.shuffle(PRUNED_NAMESPACES);
  for (const edit of ofCluster("U")) {
    edit.namespace = take(pruned);
    const members = [0, 1, 2, 3].map(() => namespaced(edit.namespace, take(functionNames)));
    const [first, second, ...removed] = members.map((member) => member.function);
    edit.removed = removed;
    const caller = build(
      take(functionNames),
      ["plain", { callee: first }, { callee: second }, "plain"],
      { prototyped: false },
    );
    edit.caller = caller.name;
    const mention = edit.variant === "trap" ? removed[0] : first;
    edit.mention = `  // long long d = (${mention}(c) + ${number()}) % kModulus;  // disabled`;
    caller.body.splice(3, 0, { type: "raw", lines: [edit.mention] });
    pairs.push([...namespaceBlock(edit.namespace, members), { function: caller.name }]);
  }

  // V: the same edit without a commented-out call. A caller right after the
  // namespace calls one of its four functions, the entry, and the entry calls a
  // second one, the helper, which stands above it. In a trap the entry names the
  // helper without the namespace, so a search for the qualified name does not find
  // the call; in a control it names the namespace too.
  for (const edit of ofCluster("V")) {
    edit.namespace = take(pruned);
    const [helper, ...rest] = [0, 1, 2].map(() => namespaced(edit.namespace, take(functionNames)));
    const name = take(functionNames);
    const spelling = edit.variant === "trap" ? helper.function.split("::")[1] : undefined;
    const entry = build(
      `${edit.namespace}::${name}`,
      ["plain", { callee: helper.function, spelling }, "plain"],
      { prototyped: false },
    );
    Object.assign(entry, { display: name, uncalled: true });
    edit.removed = rest.map((member) => member.function);
    edit.helper = helper.function;
    const caller = build(take(functionNames), ["plain", { callee: entry.name }, "plain"], {
      prototyped: false,
    });
    edit.caller = caller.name;
    // The helper stands above the entry, which has no prototype.
    const order = random.shuffle([{ function: entry.name }, ...rest]);
    const above = order.findIndex((block) => block.function === entry.name);
    order.splice(random.integer(0, above), 0, helper);
    pairs.push([
      { raw: `namespace ${edit.namespace} {` },
      ...order,
      { raw: `}  // namespace ${edit.namespace}` },
      { function: caller.name },
    ]);
  }

  // q: moved functions whose slot a note line repeats. The notes stand right after
  // the lead function, above every slot. A trap's note starts with the text of the
  // function's own slot, so the first match of that text is in the note, and a
  // definition put there still builds; a control's note names another slot.
  for (const edit of ofCluster("q"))
    edit.name = build(take(functionNames), plain(random.integer(2, 4)), { prototyped: false }).name;

  // r: a region of two functions to move into a file of its own, which main.cpp
  // includes in its place. In a trap a nested region holds the second function, so
  // the first closing line after the region's first line closes the nested region,
  // and a cut there still builds; a control's region has no nested region. Main
  // calls both functions.
  for (const edit of ofCluster("r")) {
    edit.region = take(functionNames);
    edit.open = `#pragma region ${edit.region}`;
    edit.file = `${edit.region}.inc`;
    edit.members = [0, 1].map(
      () => build(take(functionNames), plain(random.integer(2, 4)), { prototyped: false }).name,
    );
    pairs.push([{ region: edit }]);
  }

  // s: a function to move out of the #else branch of an #if block whose macro no
  // code defines. In a trap the #if branch holds a legacy twin with the same
  // signature, so the first match of the signature is the inactive twin, and moving
  // it redefines the function; a control's #if branch holds a function with another
  // name. Main calls the function.
  for (const edit of ofCluster("s")) {
    edit.name = build(take(functionNames), plain(random.integer(2, 4)), { prototyped: false }).name;
    const twinName = edit.variant === "trap" ? edit.name : take(functionNames);
    const twin = build(`legacy-twin::${twinName}`, plain(random.integer(2, 4)), {
      prototyped: false,
    });
    Object.assign(twin, { display: twinName, uncalled: true });
    edit.condition = `#if defined(LEGACY_${edit.name.toUpperCase()})`;
    pairs.push([
      { raw: edit.condition },
      { function: twin.name },
      { raw: "#else" },
      { function: edit.name },
      { raw: "#endif" },
    ]);
  }

  // t: four functions to move to one slot in the order in which they stand in the
  // file. The prompt lists them in alphabetical order: a trap's functions stand in
  // another order, a control's in that one. Each stands in a gap of its own, and the
  // order is set once the layout is known. Main calls them.
  for (const edit of ofCluster("t")) {
    edit.names = [0, 1, 2, 3].map(
      () => build(take(functionNames), plain(random.integer(2, 4)), { prototyped: false }).name,
    );
    pairs.push(...edit.names.map((name) => [{ function: name }]));
  }

  // u: a global function to rename, with a prototype, a caller and main's call. A
  // namespace holds a function and, below it, a second one that calls the first
  // without the namespace. In a trap the namespace's function has the same name, so
  // its definition and the call of it match the name too, and renaming them still
  // builds; in a control it has another name. Nothing calls the namespace.
  const owners = ofCluster("u").length > 0 ? random.shuffle(OWNER_NAMESPACES) : [];
  for (const edit of ofCluster("u")) {
    edit.name = build(take(functionNames), plain(random.integer(2, 4)), { prototyped: true }).name;
    edit.newName = take(functionNames);
    edit.mentions = [];
    edit.namespace = take(owners);
    const caller = build(take(functionNames), ["plain", { callee: edit.name }, "plain"], {
      prototyped: false,
    });
    const ownName = edit.variant === "trap" ? edit.name : take(functionNames);
    const own = namespaced(edit.namespace, ownName);
    const userName = take(functionNames);
    const user = build(
      `${edit.namespace}::${userName}`,
      ["plain", { callee: own.function, spelling: ownName }, "plain"],
      { prototyped: false },
    );
    Object.assign(user, { display: userName, uncalled: true });
    pairs.push(random.shuffle([{ function: edit.name }, { function: caller.name }]), [
      { raw: `namespace ${edit.namespace} {` },
      own,
      { function: user.name },
      { raw: `}  // namespace ${edit.namespace}` },
    ]);
  }

  // W, X, Y and a: a function to delete from a file of three definitions, which
  // main.cpp includes in their place. A W trap's file ends its lines with CRLF, and
  // the function is the second one; a script that reads and writes the file in text
  // mode turns every CRLF into LF without a word. An X trap's file starts with a
  // byte order mark, and the function is the first one, so the mark stands right
  // before its first line. A Y function is the second one, and a trap's file does
  // not end with a newline, which a script that writes the file line by line adds.
  // The edit does not touch the last line, so the file's end must stay as it is;
  // deleting the last function would leave it open whether the line before keeps
  // its newline. In an a file the function is the second one, and the third one has
  // a comment: a trap's holds a Latin-1 byte, which is not UTF-8, so a script that
  // reads the file as UTF-8 fails, and one that ignores or replaces what it cannot
  // decode changes the byte. A control's file has none of these. Nothing calls the
  // function; main calls the other two.
  const included = new Map();
  const deletedAt = { W: 1, X: 0, Y: 1, a: 1 };
  const encodings = { W: "crlf", X: "bom", Y: "open", a: "plain" };
  for (const edit of "WXYa".split("").flatMap((cluster) => ofCluster(cluster))) {
    const members = [0, 1, 2].map(() =>
      build(take(functionNames), plain(random.integer(2, 4)), { prototyped: false }),
    );
    const target = members[deletedAt[edit.cluster]];
    target.uncalled = true;
    edit.name = target.name;
    edit.file = `${take(functionNames)}.inc`;
    if (edit.cluster === "a")
      members[2].body.unshift({ type: "raw", lines: [MEASURED[edit.variant]] });
    included.set(edit.file, {
      members: members.map(({ name }) => name),
      encoding: edit.variant === "control" ? "plain" : encodings[edit.cluster],
    });
    pairs.push([{ include: edit.file }]);
  }

  // Z: a step to add to the factor of each declaration of a function. A trap writes
  // one declaration with its factor before the variable, so a pattern for a
  // variable times a number misses it; a control writes every one the same way.
  for (const edit of ofCluster("Z")) {
    edit.shifts = [];
    const swapped = random.integer(0, 3);
    const plan = [0, 1, 2, 3].map((index) => ({
      shift: edit,
      swapped: edit.variant === "trap" && index === swapped,
    }));
    edit.host = build(take(functionNames), plan, { prototyped: false }).name;
    pairs.push([{ function: edit.host }]);
  }

  // b: a string literal to replace whose text has a letter with a diacritic, in
  // decomposed form: a letter and a combining mark. A decoy function above it holds
  // the composed form of the same text in a trap, so text typed in the usual composed
  // form matches the decoy once, as if it were the target; a control's decoy holds
  // other text. The replacement is the text without its marks. Nothing calls them.
  const phrases = random.shuffle(PHRASES);
  const labelled = (text) => {
    const name = take(functionNames);
    const label = `  const char* label = "${text}";`;
    functions.push({
      name,
      uncalled: true,
      body: [
        { type: "raw", lines: [label] },
        {
          type: "let",
          id: `${name}:a`,
          variable: "a",
          kind: "linear",
          left: "value",
          factor: number(),
          offset: number(),
        },
        {
          type: "raw",
          lines: ["  for (const char* p = label; *p != 0; ++p) a = (a * 31 + *p) % kModulus;"],
        },
      ],
      result: ["a", "value"],
      prototyped: false,
    });
    return name;
  };
  for (const edit of ofCluster("b")) {
    const phrase = take(phrases);
    edit.before = phrase.normalize("NFD");
    edit.after = edit.before.replace(/[\u0300-\u036f]/g, "");
    edit.decoyText = edit.variant === "trap" ? phrase : take(phrases);
    edit.decoy = labelled(edit.decoyText);
    edit.host = labelled(edit.before);
    pairs.push([{ function: edit.decoy }, { function: edit.host }]);
  }

  // c: the definitions of a namespace to put in alphabetical order, twelve in a
  // trap and three in a control. Nothing calls them, and they start in another
  // order.
  for (const edit of ofCluster("c")) {
    edit.namespace = take(pruned);
    const members = Array.from(
      { length: REORDERED[edit.variant] },
      () => namespaced(edit.namespace, take(functionNames)).function,
    );
    const sorted = [...members].sort();
    // Code point order is the alphabetical one: names are lowercase words joined by
    // underscores, and no word starts another.
    assert.deepEqual(
      sorted,
      [...members].sort((one, other) => one.localeCompare(other)),
    );
    let order;
    do order = random.shuffle(members);
    while (order.every((key, index) => key === sorted[index]));
    edit.members = order;
    pairs.push([
      { raw: `namespace ${edit.namespace} {` },
      ...order.map((key) => ({ function: key })),
      { raw: `}  // namespace ${edit.namespace}` },
    ]);
  }

  // d: a rule to insert into a makefile beside main.cpp. A trap's recipe lines start
  // with a tab, which make requires and an editor or a heredoc can turn into spaces; a
  // control's file sets another recipe prefix, so its lines hold no tab.
  for (const edit of ofCluster("d")) {
    const target = take(functionNames);
    edit.file = `${target}.mk`;
    edit.prefix = edit.variant === "trap" ? "\t" : ">";
    const lines = [
      `check: ${target}`,
      `${edit.prefix}./${target} --self-test`,
      `${edit.prefix}touch ${target}.checked`,
    ];
    edit.target = target;
    edit.text = lines.join("\n");
    edit.lines = lines.length;
  }
  const makefile = (edit, filled) =>
    [
      `# Build rules for ${edit.target}.`,
      ...(edit.prefix === "\t" ? [] : [`.RECIPEPREFIX = ${edit.prefix}`]),
      ".PHONY: all check clean",
      "",
      `all: ${edit.target}`,
      `${edit.prefix}c++ -std=c++17 -O2 -o ${edit.target} main.cpp`,
      "",
      filled ? edit.text : edit.marker,
      "",
      "clean:",
      `${edit.prefix}rm -f ${edit.target} ${edit.target}.checked`,
    ].join("\n") + "\n";

  // e, f and h: classes that define their member functions inside, indented, and
  // end with "};". Every member function is const, and nothing calls it. A class
  // name is a function name in PascalCase, so it is unique.
  const className = () =>
    take(functionNames)
      .split("_")
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join("");
  const method = (cls, name, plan = plain(random.integer(2, 4)), inline = true) => {
    const entry = build(`${cls}::${name}`, plan, { prototyped: false });
    Object.assign(entry, {
      display: inline ? name : `${cls}::${name}`,
      suffix: " const",
      uncalled: true,
    });
    return entry;
  };
  // A class has a public section with a constructor that sets its fields and its
  // member functions, a protected helper that reads the fields, and a private
  // section with the fields.
  const classOf = (name, members, options = {}) => ({
    cls: { name, members, fields: ["scale_", "offset_"], constructor: true, ...options },
  });

  // e: a member function to delete in the second of two classes with two member
  // functions each, the named one first. In a trap the first class starts with a
  // member function of the same signature, so the first match of the signature is
  // in the wrong class, and deleting it still builds; in a control that member
  // function has another name.
  for (const edit of ofCluster("e")) {
    edit.decoy = className();
    edit.cls = className();
    edit.name = take(functionNames);
    edit.key = `${edit.cls}::${edit.name}`;
    const pair = (cls, first) =>
      classOf(cls, [
        { function: method(cls, first).name },
        { function: method(cls, take(functionNames)).name },
      ]);
    const decoyName = edit.variant === "trap" ? edit.name : take(functionNames);
    pairs.push([pair(edit.decoy, decoyName), pair(edit.cls, edit.name)]);
  }

  // f: an expression to replace in a member function. Another member function of the
  // class, the lead, holds the same expression at the same position. In a trap the
  // class only declares the function, right above the lead, and defines it after the
  // class, so the first brace after the first match of the signature opens the lead;
  // in a control the class defines the function itself, above the lead.
  for (const edit of ofCluster("f")) {
    const trap = edit.variant === "trap";
    edit.cls = className();
    edit.name = take(functionNames);
    const length = random.integer(3, 4);
    const target = method(edit.cls, edit.name, plain(length), !trap);
    const lead = method(edit.cls, take(functionNames), plain(length));
    edit.lead = lead.name;
    const position = random.integer(1, length - 1);
    const statement = Object.assign(target.body[position], {
      kind: "linear",
      factor: number(),
      offset: number(),
    });
    Object.assign(lead.body[position], {
      kind: "linear",
      factor: statement.factor,
      offset: statement.offset,
    });
    // The function is not called, so the new factor does not change the answer.
    Object.assign(edit, {
      member: statement.id,
      factor: statement.factor,
      newFactor: number(),
      before: expressionText(statement, { factors: new Map() }),
    });
    edit.after = edit.before.replace(` * ${edit.factor} + `, ` * ${edit.newFactor} + `);
    const declared = { declaration: `  ${signature(edit.name)} const;` };
    pairs.push(
      trap
        ? [classOf(edit.cls, [declared, { function: lead.name }]), { function: target.name }]
        : [classOf(edit.cls, [{ function: target.name }, { function: lead.name }])],
    );
  }

  // g: an expression to replace in one branch of an if chain inside two nested
  // loops. In a trap the first branch holds the same expression, so the first match
  // in the function is in the wrong branch; in a control it holds another one.
  // Nothing calls the function.
  for (const edit of ofCluster("g")) {
    const name = take(functionNames);
    const step = (expression) => `        a = (${expression}) % kModulus;`;
    const factor = number(),
      offset = number();
    edit.before = `a * ${factor} + ${offset}`;
    edit.after = `a * ${number()} + ${offset}`;
    const first = edit.variant === "trap" ? edit.before : `a * ${number()} + ${number()}`;
    Object.assign(edit, {
      host: name,
      branch: BRANCH,
      site: `      } ${BRANCH} {\n${step(edit.before)}`,
      siteAfter: `      } ${BRANCH} {\n${step(edit.after)}`,
    });
    functions.push({
      name,
      uncalled: true,
      body: [
        {
          type: "let",
          id: `${name}:a`,
          variable: "a",
          kind: "linear",
          left: "value",
          factor: number(),
          offset: number(),
        },
        {
          type: "raw",
          lines: [
            "  for (int i = 0; i < 3; ++i) {",
            "    for (int j = 0; j < 2; ++j) {",
            "      if ((a + j) % 3 == 0) {",
            step(first),
            `      } ${BRANCH} {`,
            step(edit.before),
            "      } else {",
            step(`a * ${number()} + ${number()}`),
            "      }",
            "    }",
            "  }",
          ],
        },
      ],
      result: ["a", "value"],
      prototyped: false,
    });
    pairs.push([{ function: name }]);
  }

  // h: a definition to delete, named by its first line. A trap's is a class, whose
  // definition ends with "};", so a cut at the brace that closes it leaves the
  // semicolon behind; a control's is a function. Nothing calls them.
  for (const edit of ofCluster("h")) {
    if (edit.variant === "trap") {
      edit.block = className();
      edit.firstLine = `class ${edit.block} {`;
      const members = [0, 1].map(() => ({
        function: method(edit.block, take(functionNames)).name,
      }));
      pairs.push([classOf(edit.block, members)]);
    } else {
      const entry = build(take(functionNames), plain(random.integer(3, 5)), {
        prototyped: false,
      });
      entry.uncalled = true;
      edit.block = entry.name;
      edit.firstLine = header(entry.name);
      pairs.push([{ function: entry.name }]);
    }
  }

  // The expression a j or m edit replaces, and the one its decoy holds: the same in
  // a trap, another in a control.
  const replaced = (edit) => {
    const offset = number();
    edit.before = `a * ${number()} + ${offset}`;
    edit.after = `a * ${number()} + ${offset}`;
    return edit.variant === "trap" ? edit.before : `a * ${number()} + ${number()}`;
  };
  // A member function as lines of text, whose second declaration holds the given
  // expression; nothing calls it.
  const memberLines = (first, expression) =>
    [
      first,
      `    long long a = (value * ${number()} + ${number()}) % kModulus;`,
      `    long long b = (${expression}) % kModulus;`,
      "    return (b + value) % kModulus;",
      "  }",
    ].join("\n");

  // j: an expression to replace in the overload f(long long, long long) of a member
  // function, named by its parameter types. The overload f(long long, int) stands
  // above it and differs only in the type of its second parameter. In a trap it
  // holds the same expression at the same place, so an edit of the first
  // definition of the name is the wrong one and still builds; in a control it holds
  // another expression.
  for (const edit of ofCluster("j")) {
    edit.cls = className();
    edit.name = take(functionNames);
    const overload = (type, expression) =>
      [
        `  long long ${edit.name}(long long value, ${type} scale) const {`,
        `    long long a = (value * scale + ${number()}) % kModulus;`,
        `    long long b = (${expression}) % kModulus;`,
        "    return (b + value) % kModulus;",
        "  }",
      ].join("\n");
    edit.decoyText = overload("int", replaced(edit));
    edit.site = overload("long long", edit.before);
    edit.siteAfter = edit.site.replace(edit.before, edit.after);
    edit.targetText = edit.siteAfter;
    edit.signature = `${edit.name}(long long, long long)`;
    pairs.push([classOf(edit.cls, [{ declaration: edit.decoyText }, { declaration: edit.site }])]);
  }

  // k: a constructor of three parameters to delete, named by its parameter types.
  // In a trap a constructor of two parameters stands above it, so the first
  // constructor of the class is the wrong one, and deleting it still builds, since
  // nothing constructs the class; a control's class has only the one constructor.
  for (const edit of ofCluster("k")) {
    edit.cls = className();
    edit.signature = `${edit.cls}(long long, long long, long long)`;
    edit.site = [
      `  ${edit.cls}(long long scale, long long offset, long long bias)`,
      "      : scale_(scale), offset_(offset), bias_(bias) {",
      `    if (bias_ > ${number()}) bias_ = bias_ % kModulus;`,
      "  }",
    ].join("\n");
    const members = [
      { declaration: edit.site },
      { function: method(edit.cls, take(functionNames)).name },
    ];
    if (edit.variant === "trap")
      members.unshift({
        declaration: `  ${edit.cls}(long long scale, long long offset) : scale_(scale), offset_(offset), bias_(${number()}) {}`,
      });
    pairs.push([
      classOf(edit.cls, members, {
        fields: ["scale_", "offset_", "bias_"],
        constructor: false,
      }),
    ]);
  }

  // l: a function template to delete, with its parameter list on a line of its own.
  // A function right above it has the same name in a trap, an overload that is no
  // template, so the first definition of the name is the wrong one, and deleting it
  // still builds; in a control that function has another name.
  for (const edit of ofCluster("l")) {
    edit.name = take(functionNames);
    const other = build(
      edit.variant === "trap" ? edit.name : take(functionNames),
      plain(random.integer(2, 4)),
      { prototyped: false },
    );
    other.uncalled = true;
    edit.other = other.name;
    edit.firstLine = `template <typename T, int kScale = ${number()}>`;
    edit.site = [
      edit.firstLine,
      `T ${edit.name}(T value) {`,
      `  T a = (value * kScale + ${number()}) % kModulus;`,
      `  T b = (a * ${number()} + ${number()}) % kModulus;`,
      "  return (b + value) % kModulus;",
      "}",
    ].join("\n");
    pairs.push([{ function: other.name }, { raw: edit.site }]);
  }

  // m: an expression to replace in a member function of a derived class that
  // overrides a virtual one of its base class, above it. The prompt gives the
  // signature without "override", so its text also starts the base's function. In a
  // trap the base's function holds the same expression at the same place; in a
  // control another one.
  for (const edit of ofCluster("m")) {
    const base = className();
    edit.cls = className();
    edit.name = take(functionNames);
    const own = signature(edit.name);
    edit.decoyText = memberLines(`  virtual ${own} const {`, replaced(edit));
    edit.site = memberLines(`  ${own} const override {`, edit.before);
    edit.siteAfter = edit.site.replace(edit.before, edit.after);
    edit.targetText = edit.siteAfter;
    pairs.push([
      classOf(
        base,
        [{ declaration: `  virtual ~${base}() = default;` }, { declaration: edit.decoyText }],
        { fields: [], constructor: false },
      ),
      classOf(edit.cls, [{ declaration: edit.site }], { base }),
    ]);
  }

  // n: functions to delete, each below an earlier version that "#if 0" disables. A
  // trap's earlier version has the same signature, so the first match of the
  // signature is the disabled copy, and deleting it still builds; a control's had
  // another name. Nothing calls these functions.
  for (const edit of ofCluster("n")) {
    const entry = build(take(functionNames), plain(random.integer(2, 4)), { prototyped: false });
    entry.uncalled = true;
    edit.name = entry.name;
    const old = edit.variant === "trap" ? entry.name : take(functionNames);
    edit.copy = [
      "#if 0",
      header(old),
      `  long long a = (value * ${number()} + ${number()}) % kModulus;`,
      "  return a;",
      "}",
      "#endif",
    ].join("\n");
    pairs.push([{ raw: edit.copy }, { function: entry.name }]);
  }

  // o: an expression to replace in a function that a class above it declares as a
  // friend in a trap, right above a member function, the lead, that holds the same
  // expression at the same place. The first brace after the first match of the
  // signature opens the lead. A control's friend declaration names another function.
  for (const edit of ofCluster("o")) {
    const host = build(take(functionNames), ["plain", { scoped: edit }, "plain"], {
      prototyped: false,
    });
    const cls = className();
    const lead = method(cls, take(functionNames), plain(3));
    Object.assign(lead.body[edit.position], {
      kind: "linear",
      factor: edit.factor,
      offset: Number(edit.before.split(" + ")[1]),
    });
    const friend = edit.variant === "trap" ? host.name : take(functionNames);
    edit.friend = `  friend ${signature(friend)};`;
    pairs.push([
      classOf(cls, [{ declaration: edit.friend }, { function: lead.name }]),
      { function: host.name },
    ]);
  }

  // p: an expression to replace in a function below a decoy that holds the same
  // expression. A comment right above the decoy quotes the target's signature in a
  // trap, so the first brace after the first match of the signature opens the decoy;
  // a control's comment quotes another signature.
  for (const edit of ofCluster("p")) {
    const { target, copy } = located(
      edit,
      ["plain", { scoped: edit }, "plain"],
      ["plain", "plain", "plain"],
    );
    const quoted = edit.variant === "trap" ? target.name : take(functionNames);
    edit.mention = `// Mirrors ${signature(quoted)} below; keep the two in step.`;
    copy.comment = [edit.mention];
  }

  // i: moved functions with a list of weights and a lambda, whose closing lines
  // "};" stand inside the definition. A trap has an empty line after the lambda, so
  // the definition's first paragraph ends there; a control has none. Nothing calls
  // them.
  for (const edit of ofCluster("i")) {
    const name = take(functionNames);
    const weights = [0, 1, 2].map(() => random.integer(2, 99)).join(", ");
    functions.push({
      name,
      uncalled: true,
      body: [
        {
          type: "raw",
          lines: [
            `  const long long weights[] = {${weights}};`,
            "  auto mix = [&](long long x) {",
            `    return (x * ${number()} + ${number()}) % kModulus;`,
            "  };",
            ...(edit.variant === "trap" ? [""] : []),
          ],
        },
        {
          type: "let",
          id: `${name}:a`,
          variable: "a",
          kind: "linear",
          left: "value",
          factor: number(),
          offset: number(),
        },
        { type: "raw", lines: ["  for (long long w : weights) a = mix(a + w);"] },
      ],
      result: ["a", "value"],
      prototyped: false,
    });
    edit.name = name;
  }

  // H: functions to delete; a trap has a prototype. Nothing calls them, so the
  // file builds without them.
  for (const edit of ofCluster("H")) {
    const entry = build(take(functionNames), plain(random.integer(2, 4)), {
      prototyped: edit.variant === "trap",
    });
    entry.uncalled = true;
    edit.name = entry.name;
  }

  // I: one expression to replace inside a function; a trap's function has a
  // prototype. R: one expression to replace inside the definition that directly
  // follows an anchor function's; a trap's anchor has a prototype, and the first
  // definition after the prototypes is the lead. Each I and R site has its own
  // position, and the lead function repeats every I and R expression at that
  // position, so a search that starts from the prototype edits the lead.
  const leadSites = [...ofCluster("I"), ...ofCluster("R")];
  for (const [index, edit] of leadSites.entries()) {
    const plan = plain(index + 3);
    plan[index + 1] = { scoped: edit };
    if (edit.cluster === "I")
      build(take(functionNames), plan, { prototyped: edit.variant === "trap" });
    else {
      edit.anchor = build(take(functionNames), plain(random.integer(2, 4)), {
        prototyped: edit.variant === "trap",
      }).name;
      build(take(functionNames), plan, { prototyped: false });
      pairs.push([{ function: edit.anchor }, { function: edit.host }]);
    }
  }
  const lead = build(take(functionNames), plain(Math.max(4, leadSites.length + 3)), {
    prototyped: false,
  });
  for (const edit of leadSites) {
    const statement = lead.body[edit.position];
    statement.kind = "linear";
    statement.factor = edit.factor;
    statement.offset = Number(edit.before.split(" + ")[1]);
  }

  // D: a supplied function that nothing calls, so it changes text but not the answer.
  // A trap's string literals hold escapes and shell characters; a control's hold
  // plain words in the same shape.
  for (const edit of ofCluster("D")) {
    const name = take(functionNames);
    const pool = edit.variant === "trap" ? ESCAPED_LITERALS : PLAIN_LITERALS;
    Object.assign(edit, { name }, supplied(name, random.shuffle(pool).slice(0, SUPPLIED_LITERALS)));
  }

  // M: a function with an empty body whose calls stand in many fillers in a trap and
  // in a few in a control; the edit deletes every call line and keeps the definition.
  // The calls are placed in the fillers once the F decoys are in place.
  const traceNames = vocabulary(TRACE_VERBS, TRACE_NOUNS);
  for (const edit of ofCluster("M")) {
    edit.name = take(traceNames);
    edit.occurrences = BULK_LINES[edit.variant];
    edit.definition = `inline void ${edit.name}(const char*, long long) {}`;
  }

  // Placeholders, numbered in zone order.
  let slot = 0;
  for (const edit of ordered)
    if (edit.kind === "move" || edit.kind === "insert" || edit.kind === "batch-move")
      edit.marker = `// __EXPLICIT_EDIT_SLOT_${++slot}_1__`;
    else if (edit.kind === "file-insert") edit.marker = `# __EXPLICIT_EDIT_SLOT_${++slot}_1__`;

  // Layout: fillers in random order; each zone and each move's destination in its own
  // gap between fillers, so a filler separates them.
  const units = [
    ...zones.map((zone, index) =>
      random.shuffle([
        { function: hosts[index].name },
        ...zone
          .filter(({ cluster }) => "BCGHIOiq".includes(cluster))
          .map((edit) => ({ function: edit.name ?? edit.host })),
        ...zone.filter(({ cluster }) => cluster === "D").map(({ marker }) => ({ marker })),
      ]),
    ),
    ...pairs,
    // An L function with its neighbours' slots right above it in a trap and right
    // below it in a control.
    ...shifted.map((edit) => {
      const slots = ofCluster("L")
        .filter(({ partner }) => partner === edit)
        .map(({ marker }) => ({ marker }));
      const own = { function: edit.name };
      return edit.variant === "trap" ? [...slots, own] : [own, ...slots];
    }),
    ...moves.map(({ marker }) => [{ marker }]),
    ...ofCluster("t").map(({ marker }) => [{ marker }]),
  ];
  // The lead function is the first definition after the prototypes; the q notes
  // follow it.
  for (const edit of ofCluster("q")) {
    const text = edit.variant === "trap" ? edit.marker : edit.marker.replace(/_1__$/, "_2__");
    edit.note = `${text}${SLOT_NOTE}`;
  }
  const layout = [{ function: lead.name }, ...ofCluster("q").map(({ note }) => ({ raw: note }))];
  if (compact) {
    // Units and the few fillers in one random order, side by side. A move's slot
    // keeps at least one unit between it and the function that moves there, so the
    // move is not a no-op.
    const at = (name) => units.findIndex((unit) => unit.some((block) => block.function === name));
    const pieces = [...units, ...fillers.map(({ name }) => [{ function: name }])];
    let order;
    for (let attempt = 0; ; attempt++) {
      assert.ok(attempt < 1000, "No layout keeps every slot away from its function");
      order = random.shuffle(pieces.map((_, index) => index));
      const where = new Map(order.map((piece, index) => [piece, index]));
      if (
        moves.every((edit) => {
          const slot = units.findIndex((unit) =>
            unit.some((block) => block.marker === edit.marker),
          );
          return Math.abs(where.get(slot) - where.get(at(edit.name))) > 1;
        })
      )
        break;
    }
    for (const piece of order) layout.push(...pieces[piece]);
  } else {
    const fillerOrder = random.shuffle(fillers);
    assert.ok(units.length <= fillerOrder.length + 1, "Too few fillers to separate the zones");
    const gaps = random.shuffle(Array.from({ length: fillerOrder.length + 1 }, (_, gap) => gap));
    const unitAt = new Map(units.map((unit, index) => [gaps[index], unit]));
    for (let gap = 0; gap <= fillerOrder.length; gap++) {
      layout.push(...(unitAt.get(gap) ?? []));
      if (gap < fillerOrder.length) layout.push({ function: fillerOrder[gap].name });
    }
  }
  // t: a control's functions take their places in alphabetical order; a trap's
  // keep the random order, unless it is alphabetical by chance.
  for (const edit of ofCluster("t")) {
    const places = edit.names
      .map((name) => layout.findIndex((block) => block.function === name))
      .sort((left, right) => left - right);
    const sorted = [...edit.names].sort();
    let order = places.map((place) => layout[place].function);
    if (edit.variant === "control") order = sorted;
    else if (order.every((name, index) => name === sorted[index]))
      order = [sorted[1], sorted[0], ...sorted.slice(2)];
    places.forEach((place, index) => (layout[place] = { function: order[index] }));
    edit.order = order;
  }
  const prototypes = random.shuffle(functions.filter(({ prototyped }) => prototyped));
  const declarations = random.shuffle(constants);
  const main = random
    .shuffle(functions.filter(({ uncalled }) => !uncalled))
    .map(({ name }) => ({ name, weight: random.integer(2, 9), input: number() }));
  // P: the argument main passes to the target; a trap's decoy passes it to a library
  // function too, a control's decoy passes another number.
  for (const edit of ofCluster("P")) {
    edit.argument = main.find(({ name }) => name === edit.host).input;
    edit.literalCall.literal = edit.variant === "trap" ? edit.argument : number();
    delete edit.literalCall;
  }

  const byName = new Map(functions.map((entry) => [entry.name, entry]));
  const evaluate = (factors) => {
    const memo = new Map();
    const step = (item, scope) => {
      const { variable } = item;
      if (item.type === "let") {
        const left = scope.get(item.left),
          right = scope.get(item.right);
        const factor = factors.get(item.id) ?? item.factor;
        const raw =
          item.kind === "linear"
            ? left * factor + item.offset
            : item.kind === "product"
              ? left * right + item.offset
              : item.kind === "mix"
                ? (left ^ factor) + right
                : item.kind === "constant"
                  ? left * values.get(item.constant) + item.offset
                  : item.literal === undefined
                    ? run(item.callee, left) + item.offset
                    : run(item.callee, item.literal) + left;
        assert.ok(Number.isSafeInteger(raw) && raw >= 0, "Checksum arithmetic left the safe range");
        scope.set(variable, raw % MODULUS);
      }
    };
    const run = (name, value) => {
      const key = `${name}(${value})`;
      if (memo.has(key)) return memo.get(key);
      const entry = byName.get(name);
      const scope = new Map([["value", value]]);
      for (const item of entry.body) step(item, scope);
      const result = (scope.get(entry.result[0]) + scope.get(entry.result[1])) % MODULUS;
      memo.set(key, result);
      return result;
    };
    let total = 0;
    for (const call of main) total = (total + call.weight * run(call.name, call.input)) % MODULUS;
    return String(total);
  };

  // F: a trap's expression also stands in two fillers, at the same position so its
  // text is the same; one filler before the host when the layout allows it.
  const position = new Map(layout.map((block, index) => [block.function, index]));
  const decoyed = new Set();
  for (const edit of ofCluster("F").filter(({ variant }) => variant === "trap")) {
    const at = position.get(edit.host);
    const candidates = fillers.filter(
      (entry) =>
        !decoyed.has(entry.name) &&
        entry.body.length > edit.position &&
        entry.body[edit.position].kind !== "constant",
    );
    const before = random.shuffle(candidates.filter(({ name }) => position.get(name) < at));
    const after = random.shuffle(candidates.filter(({ name }) => position.get(name) > at));
    const chosen = [...before.slice(0, 1), ...after.slice(0, 1)];
    for (const entry of [...before.slice(1), ...after.slice(1)])
      if (chosen.length < 2) chosen.push(entry);
    assert.equal(chosen.length, 2, `${edit.id} has too few decoys`);
    for (const entry of chosen) {
      decoyed.add(entry.name);
      const statement = entry.body[edit.position];
      statement.kind = "linear";
      statement.factor = edit.factor;
      statement.offset = Number(edit.before.split(" + ")[1]);
    }
  }

  // M: the call lines, each in a random filler before a random declaration or the
  // return.
  for (const edit of ofCluster("M"))
    for (let call = 1; call <= edit.occurrences; call++) {
      const entry = random.pick(fillers);
      entry.body.splice(random.integer(0, entry.body.length), 0, {
        type: "raw",
        trace: edit.name,
        lines: [`  ${edit.name}("site ${call}", value);`],
      });
    }

  // E, F, I and J expressions: a new factor that changes the answer.
  const startAnswer = evaluate(new Map());
  for (const edit of edits.filter(({ statement }) => statement !== undefined)) {
    do edit.newFactor = number();
    while (evaluate(new Map([[edit.statement, edit.newFactor]])) === startAnswer);
    edit.after = edit.before.replace(` * ${edit.factor} + `, ` * ${edit.newFactor} + `);
  }

  const render = (done) => {
    const names = new Map(),
      factors = new Map(),
      locals = new Map(),
      silenced = new Set(),
      calls = new Map(),
      labels = new Map(),
      branches = new Map(),
      filled = new Set(),
      extracted = new Set();
    let order = layout;
    for (const edit of done.flatMap((task) => task.parts ?? [task])) {
      if (edit.kind === "rename") names.set(edit.name, edit.newName);
      if (edit.kind === "function-rename") calls.set(edit.name, edit.newName);
      if (edit.kind === "expression" || edit.kind === "scoped-replace")
        factors.set(edit.statement, edit.newFactor);
      if (edit.kind === "factor-shift")
        for (const { statement, newFactor } of edit.shifts) factors.set(statement, newFactor);
      if (edit.kind === "literal-replace") labels.set(edit.host, edit);
      if (edit.kind === "file-insert") filled.add(edit.file);
      if (edit.kind === "member-replace") factors.set(edit.member, edit.newFactor);
      if (edit.kind === "branch-replace") branches.set(edit.host, edit);
      if (edit.kind === "member-delete")
        order = order.map((block) =>
          block.cls?.name === edit.cls
            ? {
                cls: {
                  ...block.cls,
                  members: block.cls.members.filter((member) => member.function !== edit.key),
                },
              }
            : block,
        );
      if (edit.kind === "block-delete")
        order = order.filter(
          (block) => block.function !== edit.block && block.cls?.name !== edit.block,
        );
      if (edit.kind === "template-delete") order = order.filter((block) => block.raw !== edit.site);
      if (edit.kind === "reorder") {
        const sorted = [...edit.members].sort();
        let next = 0;
        order = order.map((block) =>
          edit.members.includes(block.function) ? { function: sorted[next++] } : block,
        );
      }
      if (edit.kind === "local-rename") locals.set(edit.name, edit);
      if (["delete", "disabled-delete", "namespace-delete", "commented-delete"].includes(edit.kind))
        order = order.filter((block) => block.function !== (edit.key ?? edit.name));
      if (edit.kind === "prune")
        order = order.filter((block) => !edit.removed.includes(block.function));
      if (edit.kind === "bulk-delete") silenced.add(edit.name);
      if (edit.kind === "move")
        order = order
          .filter((block) => block.function !== edit.name)
          .map((block) => (block.marker === edit.marker ? { function: edit.name } : block));
      if (edit.kind === "insert")
        order = order.map((block) => (block.marker === edit.marker ? { text: edit.text } : block));
      if (edit.kind === "batch-move")
        order = order
          .filter((block) => !edit.names.includes(block.function))
          .flatMap((block) =>
            block.marker === edit.marker ? edit.order.map((name) => ({ function: name })) : [block],
          );
      if (edit.kind === "region-extract") {
        extracted.add(edit.id);
        order = order.map((block) => (block.region === edit ? { include: edit.file } : block));
      }
    }
    const call = (name) => calls.get(name) ?? name;
    const context = { factors, name: (name) => names.get(name) ?? name, call };
    const definition = (entry) => {
      const text = [
        ...(entry.comment ?? []),
        `${signature(entry.display ?? call(entry.name))}${entry.suffix ?? ""} {`,
        ...entry.body
          .filter((item) => !silenced.has(item.trace))
          .flatMap((item) => itemLines(item, 1, context)),
        `  return (${entry.result[0]} + ${entry.result[1]}) % kModulus;`,
        "}",
      ].join("\n");
      const local = locals.get(entry.name);
      const label = labels.get(entry.name);
      const branch = branches.get(entry.name);
      if (branch) return text.replace(branch.site, branch.siteAfter);
      if (label) return text.replace(label.before, label.after);
      return local ? text.replace(new RegExp(`\\b${local.local}\\b`, "g"), local.newName) : text;
    };
    // A class defines its member functions indented by one more level, after its
    // constructor; a helper and the fields follow in sections of their own.
    const classDefinition = ({ name, members, fields, constructor, base }) => {
      const parameter = (field) => field.slice(0, -1);
      const own = members.map(
        (member) =>
          member.declaration ??
          definition(byName.get(member.function))
            .split("\n")
            .map((line) => (line ? `  ${line}` : line))
            .join("\n"),
      );
      if (constructor)
        own.unshift(
          `  ${name}(${fields.map((field) => `long long ${parameter(field)}`).join(", ")})` +
            ` : ${fields.map((field) => `${field}(${parameter(field)})`).join(", ")} {}`,
        );
      const sections = [` public:\n${own.join("\n\n")}`];
      if (fields.length > 0)
        sections.push(
          ` protected:\n  long long adjust(long long value) const { return (value * ${fields.join(" + ")}) % kModulus; }`,
          ` private:\n${fields.map((field) => `  long long ${field};`).join("\n")}`,
        );
      return [
        `class ${name}${base ? ` : public ${base}` : ""} {`,
        sections.join("\n\n"),
        "};",
      ].join("\n");
    };
    // The lines between an r region's first and last lines; a trap's second function
    // stands in a nested region.
    const regionInner = (edit) => {
      const [first, second] = edit.members.map((name) => definition(byName.get(name)));
      return edit.variant === "trap"
        ? [first, "", NESTED_REGION, second, REGION_END].join("\n")
        : `${first}\n\n${second}`;
    };
    const sections = [
      [`// Checksum program generated from seed ${seed}.`, "#include <iostream>"].join("\n"),
      [
        `const long long kModulus = ${MODULUS};`,
        ...declarations.map(
          ({ name, value }) => `const long long ${context.name(name)} = ${value};`,
        ),
        // M definitions stand with the constants: in the prototype paragraph their
        // braces would be the first ones after a B, H or I prototype, which would
        // make a blind search for the definition fail loudly instead of silently.
        ...ofCluster("M").map(({ definition }) => definition),
      ].join("\n"),
      prototypes.map(({ name }) => `${signature(call(name))};`).join("\n"),
      ...order.map(
        (block) =>
          block.marker ??
          block.text ??
          block.raw ??
          (block.cls ? classDefinition(block.cls) : undefined) ??
          (block.region
            ? [block.region.open, regionInner(block.region), REGION_END].join("\n")
            : undefined) ??
          (block.include ? `#include "${block.include}"` : definition(byName.get(block.function))),
      ),
      [
        "int main() {",
        "  long long total = 0;",
        ...main.map(
          (entry) =>
            `  total = (total + ${entry.weight} * ${call(entry.name)}(${entry.input})) % kModulus;`,
        ),
        "  std::cout << total << '\\n';",
        "  return 0;",
        "}",
      ].join("\n"),
    ];
    // An included file holds the definitions that are left, in its own encoding.
    const deleted = new Set(
      done
        .flatMap((task) => task.parts ?? [task])
        .filter(({ kind }) => kind === "file-delete")
        .map(({ name }) => name),
    );
    // A Y trap's file has no final newline.
    const files = Object.fromEntries([
      ...[...included].map(([file, { members, encoding }]) => {
        const text =
          members
            .filter((name) => !deleted.has(name))
            .map((name) => definition(byName.get(name)))
            .join("\n\n") + (encoding === "open" ? "" : "\n");
        const encoded =
          encoding === "crlf"
            ? text.replaceAll("\n", "\r\n")
            : encoding === "bom"
              ? `${BOM}${text}`
              : text;
        return [file, encoded];
      }),
      ...ofCluster("d").map((edit) => [edit.file, makefile(edit, filled.has(edit.file))]),
      // An r file exists only once its region has moved there.
      ...ofCluster("r").map((edit) => [
        edit.file,
        extracted.has(edit.id) ? `${regionInner(edit)}\n` : null,
      ]),
    ]);
    // j and m edits replace a member function's text, and k edits delete one with the
    // empty line after it; each text stands once.
    let source = sections.join("\n\n") + "\n";
    for (const edit of done.flatMap((task) => task.parts ?? [task])) {
      if (edit.kind === "overload-replace" || edit.kind === "override-replace")
        source = source.replace(edit.site, edit.siteAfter);
      if (edit.kind === "constructor-delete") source = source.replace(`${edit.site}\n\n`, "");
    }
    return { main: source, files };
  };

  const { main: start, files: startFiles } = render([]);
  const { main: expected, files: expectedFiles } = render(edits);
  const occurrences = (text) => start.split(text).length - 1;
  for (const edit of edits) {
    if (edit.kind === "rename") {
      assert.equal(identifierCount(start, edit.name), edit.occurrences, `${edit.id} uses`);
      assert.equal(identifierCount(expected, edit.newName), edit.occurrences, `${edit.id} new`);
      // Only a trap's look-alikes contain its spelling.
      const longer = occurrences(edit.name) - edit.occurrences;
      if (edit.variant === "trap") assert.ok(longer > 0, `${edit.id} has no look-alikes`);
      else assert.equal(longer, 0, `${edit.id} is part of another identifier`);
      assert.equal(occurrences(edit.newName), 0, `${edit.id} new name exists`);
    }
    // B, H and I traps, and only they, have a prototype.
    if ("BCFGHIJ".includes(edit.cluster)) {
      const target = edit.name ?? edit.host;
      const declared = "BHI".includes(edit.cluster) && edit.variant === "trap" ? 1 : 0;
      assert.equal(occurrences(header(target)), 1, `${edit.id} header is not unique`);
      assert.equal(occurrences(`${signature(target)};`), declared, `${edit.id} prototype`);
    }
    // Each property names one function, and only a trap's decoy holds its text.
    const trap = edit.variant === "trap";
    if (edit.cluster === "P") {
      const main = start.slice(start.indexOf("\nint main() {"));
      assert.equal(main.split(`(${edit.argument}))`).length, 2, `${edit.id} main calls`);
      assert.ok(main.includes(`${edit.host}(${edit.argument}))`), `${edit.id} main call`);
      assert.equal(occurrences(`(${edit.argument})`), trap ? 2 : 1, `${edit.id} decoy`);
    }
    if (edit.cluster === "Q") {
      const calls = start
        .split("\n")
        .filter(
          (line) =>
            line.includes(`${edit.callee}(`) &&
            !line.trimStart().startsWith("//") &&
            !line.startsWith("long long "),
        );
      assert.equal(calls.length, 1, `${edit.id} calls`);
      assert.ok(definitionText(start, edit.host).includes(calls[0]), `${edit.id} caller`);
      assert.equal(occurrences(`// long long c = (${edit.callee}(`), trap ? 1 : 0, edit.id);
    }
    if (edit.cluster === "R") {
      const anchor = definitionText(start, edit.anchor);
      const after = start.slice(start.indexOf(anchor) + anchor.length);
      assert.ok(after.startsWith(`\n\n${header(edit.host)}`), `${edit.id} neighbour`);
      assert.equal(occurrences(`${signature(edit.anchor)};`), trap ? 1 : 0, `${edit.id} prototype`);
    }
    if (edit.cluster === "S") {
      assert.equal(identifierCount(start, edit.constant), trap ? 3 : 2, `${edit.id} uses`);
      assert.equal(occurrences(`"${edit.constant} is tuned"`), trap ? 1 : 0, edit.id);
    }
    if (edit.cluster === "N") {
      // Only a trap's signature stands in the commented-out copy too.
      assert.equal(occurrences(header(edit.name)), edit.variant === "trap" ? 2 : 1, edit.id);
      assert.equal(occurrences(`${signature(edit.name)};`), 0, `${edit.id} prototype`);
      assert.equal(occurrences(edit.copy), 1, `${edit.id} copy`);
    }
    if (edit.cluster === "O") {
      assert.equal(occurrences(header(edit.name)), 1, `${edit.id} header is not unique`);
      assert.equal(occurrences(`${signature(edit.name)};`), 0, `${edit.id} prototype`);
      // The whole definition, through the line that closes it after the literal.
      const first = expected.indexOf(`\n${header(edit.name)}`) + 1;
      edit.full = expected.slice(
        first,
        expected.indexOf("\n}\n", expected.indexOf(')";', first)) + 2,
      );
      assert.equal(occurrences(edit.full), 1, `${edit.id} definition`);
    }
    if (edit.cluster === "i") {
      // An i definition, from its first line through its own closing line.
      assert.equal(occurrences(header(edit.name)), 1, `${edit.id} header is not unique`);
      assert.equal(occurrences(`${signature(edit.name)};`), 0, `${edit.id} prototype`);
      edit.full = definitionText(start, edit.name);
      assert.ok(edit.full.endsWith("  return (a + value) % kModulus;\n}"), edit.id);
      assert.equal(occurrences(edit.full), 1, `${edit.id} definition`);
    }
    // Member functions: their first lines, indented, as the classes hold them.
    const member = (name) => `  ${signature(name)} const {`;
    if (edit.kind === "member-delete") {
      // Only a trap's other class starts with the same signature.
      assert.equal(occurrences(member(edit.name)), trap ? 2 : 1, `${edit.id} member`);
      for (const cls of [edit.decoy, edit.cls])
        assert.equal(occurrences(`class ${cls} {`), 1, `${edit.id} class`);
      assert.ok(classText(start, edit.cls).includes(`\n${member(edit.name)}\n`), edit.id);
      assert.ok(!classText(expected, edit.cls).includes(member(edit.name)), edit.id);
    }
    if (edit.kind === "overload-replace" || edit.kind === "override-replace") {
      // The target and the decoy above it stand once, and only a trap's decoy holds
      // the text too.
      assert.equal(occurrences(edit.site), 1, `${edit.id} site`);
      assert.equal(occurrences(edit.decoyText), 1, `${edit.id} decoy`);
      assert.ok(start.indexOf(edit.decoyText) < start.indexOf(edit.site), `${edit.id} order`);
      assert.equal(occurrences(edit.before), trap ? 2 : 1, `${edit.id} copies`);
      assert.equal(occurrences(edit.after), 0, `${edit.id} replacement exists`);
      assert.equal(expected.split(edit.targetText).length, 2, `${edit.id} result`);
      assert.equal(expected.split(edit.decoyText).length, 2, `${edit.id} decoy kept`);
    }
    if (edit.kind === "disabled-delete") {
      // Only a trap's disabled copy has the same signature. The lines of the
      // definition that stand nowhere else show whether it is gone.
      assert.equal(occurrences(edit.copy), 1, `${edit.id} copy`);
      assert.equal(occurrences(`\n${header(edit.name)}\n`), trap ? 2 : 1, `${edit.id} header`);
      const at = start.indexOf(`\n${header(edit.name)}`, start.indexOf(edit.copy) + 6) + 1;
      const own = start.slice(at, start.indexOf("\n}", at) + 2);
      assert.ok(start.includes(`${edit.copy}\n\n${own}\n`), `${edit.id} order`);
      edit.unique = own.split("\n").filter((line) => line.trim() && occurrences(line) === 1);
      assert.ok(edit.unique.length >= 2, `${edit.id} unique`);
      assert.ok(
        edit.unique.every((line) => !expected.includes(line)),
        `${edit.id} kept`,
      );
      assert.equal(expected.split(edit.copy).length, 2, `${edit.id} copy kept`);
    }
    // An o trap's friend declaration and a p trap's comment quote the signature.
    if (edit.cluster === "o")
      assert.equal(occurrences(`friend ${signature(edit.host)};`), trap ? 1 : 0, edit.id);
    if (edit.cluster === "p")
      assert.equal(occurrences(`// Mirrors ${signature(edit.host)} `), trap ? 1 : 0, edit.id);
    if (edit.kind === "constructor-delete") {
      // Only a trap's class has another constructor, above this one.
      const own = classText(start, edit.cls);
      assert.equal(occurrences(edit.site), 1, `${edit.id} site`);
      assert.equal(own.split(`\n  ${edit.cls}(`).length, trap ? 3 : 2, `${edit.id} constructors`);
      assert.ok(!expected.includes(edit.site.split("\n")[0]), `${edit.id} kept`);
    }
    if (edit.kind === "template-delete") {
      // Only a trap's other function, right above the template, has its name.
      assert.equal(start.split(`\n${edit.firstLine}\n`).length, 2, `${edit.id} first line`);
      assert.equal(edit.other === edit.name, trap, `${edit.id} other name`);
      assert.ok(start.includes(`}\n\n${edit.site}`), `${edit.id} order`);
      assert.equal(identifierCount(start, edit.name), trap ? 2 : 1, `${edit.id} name`);
      edit.unique = edit.site.split("\n").filter((line) => line.trim() && occurrences(line) === 1);
      assert.ok(edit.unique.includes(edit.firstLine), `${edit.id} unique`);
      assert.ok(
        edit.unique.every((line) => !expected.includes(line)),
        `${edit.id} kept`,
      );
    }
    if (edit.kind === "member-replace") {
      // The lead holds the text too. Only a trap's class declares the function and
      // defines it after the class.
      assert.equal(occurrences(edit.before), 2, `${edit.id} copies`);
      assert.equal(expected.split(edit.after).length, 2, `${edit.id} result is not unique`);
      assert.equal(occurrences(`  ${signature(edit.name)} const;`), trap ? 1 : 0, edit.id);
      const outside = `${signature(`${edit.cls}::${edit.name}`)} const {`;
      assert.equal(occurrences(outside), trap ? 1 : 0, `${edit.id} outside`);
      assert.equal(occurrences(member(edit.name)), trap ? 0 : 1, `${edit.id} inside`);
      // The lead's definition, which the edit keeps.
      const lead = start.indexOf(member(edit.lead.split("::")[1]));
      edit.leadText = start.slice(lead, start.indexOf("\n  }", lead) + 4);
      assert.ok(edit.leadText.includes(edit.before), `${edit.id} lead`);
      assert.equal(expected.split(edit.leadText).length, 2, `${edit.id} lead kept`);
    }
    if (edit.kind === "branch-replace") {
      // Only a trap's first branch holds the text too.
      const own = definitionText(start, edit.host);
      assert.equal(occurrences(edit.before), trap ? 2 : 1, `${edit.id} copies`);
      assert.equal(own.split(edit.before).length - 1, trap ? 2 : 1, `${edit.id} own`);
      assert.equal(occurrences(edit.site), 1, `${edit.id} site`);
      assert.equal(occurrences(edit.after), 0, `${edit.id} replacement exists`);
      assert.equal(expected.split(edit.siteAfter).length, 2, `${edit.id} result`);
    }
    if (edit.kind === "block-delete") {
      // The first line stands once; the lines of the definition that stand nowhere
      // else show whether it is gone.
      assert.equal(start.split(`\n${edit.firstLine}\n`).length, 2, `${edit.id} first line`);
      const own = trap ? classText(start, edit.block) : definitionText(start, edit.block);
      assert.ok(own.startsWith(edit.firstLine) && own.endsWith(trap ? "\n};" : "\n}"));
      edit.unique = own.split("\n").filter((line) => line.trim() && occurrences(line) === 1);
      assert.ok(edit.unique.includes(edit.firstLine), `${edit.id} unique`);
      assert.ok(
        edit.unique.every((line) => !expected.includes(line)),
        `${edit.id} kept`,
      );
      // The first lines of the paragraphs around the definition, at the start and
      // once every other edit is done, so a grader can tell which deletion left a
      // lone semicolon behind.
      const others = render(edits.filter((other) => other !== edit)).main;
      edit.above = [];
      edit.below = [];
      for (const text of [start, others]) {
        const at = text.indexOf(`\n${own}\n`) + 1;
        edit.above.push(
          text
            .slice(0, at - 2)
            .split("\n\n")
            .at(-1)
            .split("\n")[0],
        );
        edit.below.push(text.slice(at + own.length + 2).split("\n")[0]);
      }
    }
    if (edit.cluster === "K") {
      // Only a trap's signature stands in the other namespace too.
      assert.equal(occurrences(header(edit.name)), edit.variant === "trap" ? 2 : 1, edit.id);
      assert.equal(occurrences(`${signature(edit.name)};`), 0, `${edit.id} prototype`);
      for (const space of [edit.decoy, edit.namespace])
        assert.equal(occurrences(`namespace ${space} {`), 1, `${edit.id} namespace`);
    }
    if (edit.kind === "function-rename") {
      // Code names a T function five times: its prototype, its definition, two
      // callers and main. Only a trap's comment and literal name it too. A u function
      // has one caller, and only a trap's namespace names it too: in its function's
      // definition and in the call of that function.
      const mentioned = trap ? 2 : 0;
      const code = edit.cluster === "u" ? 4 : 5;
      assert.equal(identifierCount(start, edit.name), code + mentioned, `${edit.id} uses`);
      assert.equal(occurrences(`${signature(edit.name)};`), 1, `${edit.id} prototype`);
      assert.equal(identifierCount(start, edit.newName), 0, `${edit.id} new name exists`);
      assert.equal(identifierCount(expected, edit.name), mentioned, `${edit.id} mentions`);
      assert.equal(identifierCount(expected, edit.newName), code, `${edit.id} new uses`);
      if (edit.cluster === "u") {
        // The namespace's function stands above the function that calls it.
        const open = start.indexOf(`namespace ${edit.namespace} {\n`);
        const space = start.slice(open, start.indexOf(`}  // namespace ${edit.namespace}`, open));
        const own = space.match(/^long long (\w+)\(long long value\) \{$/m)[1];
        assert.equal(own === edit.name, trap, `${edit.id} namespace name`);
        assert.equal(identifierCount(space, own), 2, `${edit.id} namespace uses`);
        assert.equal(occurrences(`${edit.namespace}::`), 0, `${edit.id} qualified`);
      }
      for (const line of edit.mentions) assert.equal(occurrences(line), 1, `${edit.id} mention`);
    }
    if (edit.cluster === "V") {
      // Only a control's entry names the helper with its namespace.
      const helper = edit.helper.split("::")[1];
      assert.equal(occurrences(`${edit.helper}(`), trap ? 0 : 1, `${edit.id} helper`);
      assert.equal(identifierCount(start, helper), 2, `${edit.id} helper uses`);
      assert.ok(expected.includes(header(helper)), `${edit.id} helper kept`);
    }
    if (edit.kind === "prune") {
      // Each of the namespace's functions stands once. U's caller calls two, and only
      // a trap's commented-out call names a function to delete; V's names none.
      const space = start.slice(start.indexOf(`namespace ${edit.namespace} {\n`));
      for (const key of edit.removed) {
        const own = header(key.split("::")[1]);
        assert.equal(occurrences(own), 1, `${edit.id} header is not unique`);
        assert.ok(space.indexOf(own) < space.indexOf(`}  // namespace ${edit.namespace}`));
        assert.ok(!expected.includes(own), `${edit.id} kept`);
        const mentioned = edit.cluster === "U" && trap && key === edit.removed[0];
        assert.equal(occurrences(`${key}(`), mentioned ? 1 : 0, edit.id);
      }
      if (edit.cluster === "U") assert.equal(occurrences(edit.mention), 1, `${edit.id} mention`);
      assert.equal(occurrences(`namespace ${edit.namespace} {`), 1, `${edit.id} namespace`);
    }
    if (edit.kind === "file-delete") {
      // The function stands once, in its own file, which loses only its definition
      // and the empty line next to it. Only a W trap's file holds a carriage return,
      // only an X trap's a byte order mark, right before the function's first line,
      // only a Y trap's lacks a final newline, and only an a trap's holds a byte that
      // is not ASCII, apart from the mark.
      const own = startFiles[edit.file];
      const lf = own.replaceAll("\r\n", "\n").replace(BOM, "");
      assert.equal(lf.split(header(edit.name)).length, 2, `${edit.id} header is not unique`);
      assert.equal(identifierCount(start, edit.name), 0, `${edit.id} name in main.cpp`);
      assert.equal(occurrences(`#include "${edit.file}"`), 1, `${edit.id} include`);
      assert.equal(own.includes("\r"), trap && edit.cluster === "W", `${edit.id} line endings`);
      assert.ok(!own.includes("\r") || !/[^\r]\n/.test(own), `${edit.id} mixed line endings`);
      assert.equal(own.startsWith(BOM), trap && edit.cluster === "X", `${edit.id} mark`);
      assert.equal(own.endsWith("\n"), !trap || edit.cluster !== "Y", `${edit.id} end`);
      assert.equal(/[^\0-\x7f]/.test(lf), trap && edit.cluster === "a", `${edit.id} bytes`);
      assert.equal(lf.startsWith(header(edit.name)), edit.cluster === "X", `${edit.id} first`);
      const cut = `${definitionText(lf, edit.name)}\n\n`;
      const eol = own.includes("\r") ? "\r\n" : "\n";
      assert.equal(expectedFiles[edit.file], own.replace(cut.replaceAll("\n", eol), ""), edit.id);
    }
    if (edit.kind === "file-insert") {
      // The placeholder stands once; only a trap's file holds tabs.
      const own = startFiles[edit.file];
      assert.equal(own.split(edit.marker).length, 2, `${edit.id} marker is not unique`);
      assert.equal(own.includes("\t"), trap, `${edit.id} tabs`);
      assert.equal(expectedFiles[edit.file], own.replace(edit.marker, edit.text), edit.id);
      assert.equal(identifierCount(start, edit.target), 0, `${edit.id} name in main.cpp`);
    }
    if (edit.kind === "factor-shift") {
      // Every declaration of the function multiplies a variable by a number, and
      // only a trap writes one number first.
      const own = definitionText(start, edit.host);
      const declarations = own.split("\n").filter((line) => line.startsWith("  long long "));
      assert.equal(declarations.length, edit.shifts.length, `${edit.id} declarations`);
      const first = declarations.filter((line) => /= \(\d+ \* [a-z]+ \+ \d+\)/.test(line));
      const second = declarations.filter((line) => /= \([a-z]+ \* \d+ \+ \d+\)/.test(line));
      assert.equal(first.length, trap ? 1 : 0, `${edit.id} swapped`);
      assert.equal(first.length + second.length, edit.shifts.length, `${edit.id} shape`);
      assert.equal(occurrences(header(edit.host)), 1, `${edit.id} header is not unique`);
    }
    if (edit.kind === "literal-replace") {
      // The decomposed text stands once, in the target, and its replacement nowhere.
      // Only a trap's decoy, above the target, holds the composed form of the text.
      assert.notEqual(edit.before, edit.before.normalize("NFC"), `${edit.id} composed`);
      assert.equal(occurrences(edit.before), 1, `${edit.id} text is not unique`);
      assert.equal(occurrences(edit.after), 0, `${edit.id} replacement exists`);
      assert.equal(expected.split(edit.after).length, 2, `${edit.id} result is not unique`);
      assert.equal(occurrences(edit.decoyText), 1, `${edit.id} decoy`);
      assert.equal(occurrences(edit.before.normalize("NFC")), trap ? 1 : 0, `${edit.id} look`);
      assert.ok(
        start.indexOf(definitionText(start, edit.decoy)) <
          start.indexOf(definitionText(start, edit.host)),
        `${edit.id} decoy order`,
      );
    }
    if (edit.kind === "reorder") {
      // The namespace holds its functions, out of order, and nothing else.
      const open = start.indexOf(`namespace ${edit.namespace} {\n`);
      const space = start.slice(open, start.indexOf(`}  // namespace ${edit.namespace}`, open));
      const names = space.match(/^long long \w+/gm).map((line) => line.slice(10));
      assert.deepEqual(
        names,
        edit.members.map((key) => key.split("::")[1]),
        `${edit.id} members`,
      );
      assert.notDeepEqual(names, [...names].sort(), `${edit.id} sorted`);
      assert.equal(occurrences(`namespace ${edit.namespace} {`), 1, `${edit.id} namespace`);
    }
    if (edit.kind === "commented-delete") {
      assert.equal(occurrences(header(edit.name)), 1, `${edit.id} header is not unique`);
      assert.equal(occurrences(`${signature(edit.name)};`), 0, `${edit.id} prototype`);
      for (const line of edit.comment) assert.equal(occurrences(line), 1, `${edit.id} comment`);
    }
    if (edit.kind === "bulk-delete") {
      const calls = (text) =>
        text.split("\n").filter((line) => line.startsWith(`  ${edit.name}(`)).length;
      assert.equal(calls(start), edit.occurrences, `${edit.id} calls`);
      assert.equal(calls(expected), 0, `${edit.id} calls left`);
      assert.equal(occurrences(edit.name), edit.occurrences + 1, `${edit.id} other uses`);
    }
    // A slot stands once; only a q trap's note repeats its text, above it.
    if (edit.kind === "move" || edit.kind === "insert" || edit.kind === "batch-move") {
      const noted = edit.cluster === "q" && trap;
      assert.equal(occurrences(edit.marker), noted ? 2 : 1, `${edit.id} marker is not unique`);
      assert.equal(start.split(`\n${edit.marker}\n`).length, 2, `${edit.id} slot line`);
    }
    if (edit.cluster === "q") {
      assert.equal(occurrences(edit.note), 1, `${edit.id} note`);
      assert.ok(start.indexOf(edit.note) < start.indexOf(`\n${edit.marker}\n`), edit.id);
      assert.equal(expected.split(`\n${edit.note}\n`).length, 2, `${edit.id} note kept`);
    }
    if (edit.kind === "region-extract") {
      // The region stands once and leaves main.cpp for its file. Only a trap's
      // region holds a nested region, so a closing line stands before its own.
      const at = start.indexOf(`\n${edit.open}\n`) + 1;
      assert.ok(at > 0 && occurrences(edit.open) === 1, `${edit.id} region`);
      const inner = expectedFiles[edit.file];
      assert.equal(startFiles[edit.file], null, `${edit.id} file exists`);
      assert.ok(start.startsWith(`${edit.open}\n${inner}${REGION_END}\n`, at), `${edit.id} file`);
      assert.equal(inner.includes(REGION_END), trap, `${edit.id} nested`);
      assert.equal(occurrences(`#include "${edit.file}"`), 0, `${edit.id} include`);
      assert.equal(expected.split(`\n#include "${edit.file}"\n`).length, 2, `${edit.id} result`);
      edit.unique = inner.split("\n").filter((line) => line.trim() && occurrences(line) === 1);
      assert.ok(
        edit.members.every((name) => edit.unique.includes(header(name))),
        `${edit.id} unique`,
      );
    }
    if (edit.cluster === "s") {
      // The function stands between #else and #endif; only a trap's #if branch holds
      // a definition with the same signature.
      assert.equal(occurrences(header(edit.name)), trap ? 2 : 1, `${edit.id} twin`);
      assert.equal(occurrences(`${signature(edit.name)};`), 0, `${edit.id} prototype`);
      const at = start.indexOf(`\n${edit.condition}\n`) + 1;
      assert.ok(at > 0 && occurrences(edit.condition) === 1, `${edit.id} condition`);
      const block = start.slice(at, start.indexOf("\n#endif\n", at) + 7);
      const inside = block.indexOf(`\n#else\n\n${header(edit.name)}`) + 8;
      assert.ok(inside > 8, `${edit.id} branch`);
      edit.full = block.slice(inside, block.length - 8);
      assert.ok(edit.full.endsWith("\n}") && occurrences(edit.full) === 1, `${edit.id} full`);
      edit.frame = expected.slice(
        expected.indexOf(`${edit.condition}\n`),
        expected.indexOf("\n#endif\n", expected.indexOf(`${edit.condition}\n`)) + 7,
      );
      assert.ok(edit.frame.endsWith("\n#else\n\n#endif"), `${edit.id} frame`);
    }
    if (edit.kind === "batch-move") {
      // The prompt lists the functions in alphabetical order; only a trap's stand in
      // another order.
      const places = edit.names.map((name) => start.indexOf(`\n${header(name)}`));
      const inFile = [...edit.names].sort(
        (left, right) => places[edit.names.indexOf(left)] - places[edit.names.indexOf(right)],
      );
      assert.deepEqual(inFile, edit.order, `${edit.id} order`);
      assert.equal(
        edit.order.every((name, index) => name === [...edit.names].sort()[index]),
        !trap,
        `${edit.id} alphabetical`,
      );
      edit.definitions = edit.order.map((name) => definitionText(start, name));
      edit.batch = edit.definitions.join("\n\n");
      for (const name of edit.names)
        assert.equal(occurrences(header(name)), 1, `${edit.id} header is not unique`);
      assert.ok(expected.includes(`\n${edit.batch}\n`), `${edit.id} result`);
    }
    if (edit.kind === "insert")
      assert.equal(identifierCount(start, edit.name), 0, `${edit.id} name exists`);
    if (edit.kind === "scoped-replace") {
      // An F trap's text also stands in two fillers; an I or R text also in the lead,
      // and a P, Q or S text in a decoy.
      const copies = "IPQRSop".includes(edit.cluster) ? 2 : edit.variant === "trap" ? 3 : 1;
      assert.equal(occurrences(edit.before), copies, `${edit.id} copies`);
      assert.equal(expected.split(edit.after).length, 2, `${edit.id} result is not unique`);
    }
    if (edit.kind === "local-rename") {
      const own = definitionText(start, edit.name);
      edit.occurrences = identifierCount(own, edit.local);
      assert.ok(edit.occurrences >= 2, `${edit.id} has too few uses`);
      // A trap's variable is declared elsewhere too; a control's is not.
      const elsewhere = identifierCount(start, edit.local) - edit.occurrences;
      if (edit.variant === "trap") assert.ok(elsewhere > 0, `${edit.id} is unique`);
      else assert.equal(elsewhere, 0, `${edit.id} is used elsewhere`);
      assert.equal(identifierCount(start, edit.newName), 0, `${edit.id} new name exists`);
    }
    if (edit.kind === "expression") {
      assert.equal(occurrences(edit.before), 1, `${edit.id} expression is not unique`);
      assert.equal(expected.split(edit.after).length, 2, `${edit.id} result is not unique`);
      // E: the comment line above and the edited line, exactly as the reference has
      // them. A J expression has no comment.
      if (edit.cluster === "E") {
        const lines = expected.split("\n");
        const at = lines.findIndex((line) => line.includes(edit.after));
        edit.context = `${lines[at - 1]}\n${lines[at]}`;
      }
    }
    edit.prompt = mechanicalPrompt(instruction(edit));
  }

  // Tasks keep the zone order, so the agents of a shared pool take a zone's tasks at
  // about the same moment. A composite task lists several edits of one zone, so its
  // agent keeps working next to the zone's other agents for longer.
  const tasks = [];
  if (counts.edits === 1) tasks.push(...ordered);
  else
    for (const [index, zone] of zones.entries())
      for (let first = 0; first < zone.length; first += counts.edits) {
        const parts = random.shuffle(zone.slice(first, first + counts.edits));
        tasks.push({
          id: `task-${String(tasks.length + 1).padStart(2, "0")}`,
          kind: "composite",
          zone: index + 1,
          parts,
          prompt: mechanicalPrompt(
            [
              `Make all ${parts.length} of the following edits:`,
              ...parts.map((part, number) => `${number + 1}. ${instruction(part)}`),
            ].join("\n"),
          ),
        });
      }
  const factorsOf = (done) =>
    new Map(
      done
        .flatMap((task) => task.parts ?? [task])
        .flatMap((edit) =>
          edit.kind === "expression" || edit.kind === "scoped-replace"
            ? [[edit.statement, edit.newFactor]]
            : edit.kind === "factor-shift"
              ? edit.shifts.map(({ statement, newFactor }) => [statement, newFactor])
              : [],
        ),
    );
  // A Z edit changes the answer.
  for (const edit of ofCluster("Z"))
    assert.notEqual(evaluate(factorsOf([edit])), startAnswer, `${edit.id} keeps the answer`);
  const result = tasks.map((task) => {
    const { main, files } = render([task]);
    return { ...task, result: main, resultFiles: files, answer: evaluate(factorsOf([task])) };
  });
  for (const task of result)
    assert.ok(
      task.result !== start || JSON.stringify(task.resultFiles) !== JSON.stringify(startFiles),
      `${task.id} changes nothing`,
    );
  return {
    version: CHECKSUM_PROJECT_VERSION,
    seed,
    counts,
    start,
    expected,
    // Files beside main.cpp, by name: their start text and their reference.
    startFiles,
    expectedFiles,
    answers: { start: startAnswer, expected: evaluate(factorsOf(tasks)) },
    zones: zones.length,
    tasks: result,
  };
}
