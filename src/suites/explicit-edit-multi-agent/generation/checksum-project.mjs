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
 * agents of a wave edit neighbouring lines of one function at the same moment.
 */
export const CHECKSUM_PROJECT_VERSION = "multi-agent-checksum-project-v8";
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

/** Whole-identifier occurrences of a name: a longer identifier is another name. */
export const identifierCount = (text, name) =>
  text.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;

/** The expression of one declaration; `context` holds renamed constants and
 * changed factors.
 */
function expressionText(statement, context) {
  const factor = context.factors.get(statement.id) ?? statement.factor;
  const { left, right, offset } = statement;
  if (statement.kind === "linear") return `${left} * ${factor} + ${offset}`;
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
  if (edit.kind === "function-rename")
    return `In main.cpp, rename the function ${q(edit.name)} to ${q(edit.newName)}: change its prototype, its definition and every call of it. Comments and string literals that mention the function stay unchanged.`;
  if (edit.kind === "prune")
    return `In main.cpp, delete the complete definition of every function in the namespace ${q(edit.namespace)} that no code calls, and the empty line that directly followed each deleted definition. Keep the namespace and the functions that are called.`;
  if (edit.kind === "file-expression")
    return `In ${edit.file}, replace its one occurrence of ${q(edit.before)} with ${q(edit.after)}.`;
  if (edit.kind === "move")
    return `In main.cpp, move the complete definition of the function ${q(signature(edit.name))} to the placeholder line ${q(edit.marker)}: the definition replaces that placeholder line. Also delete the empty line that directly followed the definition in its old place. Keep the text of the definition unchanged.`;
  if (edit.kind === "insert")
    return `In main.cpp, replace the placeholder line ${q(edit.marker)} with the following ${edit.lines} lines: ${q(edit.text)}.`;
  const replacement = `replace ${q(edit.before)} with ${q(edit.after)}. The definition holds it once.`;
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
  if (edit.kind === "delete")
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
  // W and X replace an expression in a file of its own that main.cpp includes.
  W: "file-expression",
  X: "file-expression",
};
// Namespace names of U and V edits.
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
    // A W or X file's include line stands in a gap of its own.
    ofCluster("W").length +
    ofCluster("X").length;
  const lengths = [];
  while (
    lengths.length <
      Math.max(LIBRARY_SIZE, 2 * edits.length - zones.length + moves.length + ownGaps - 1) ||
    lengths.reduce((sum, length) => sum + length, 0) < fillerUses.length * 1.4
  )
    lengths.push(random.integer(3, 5));
  // The size option adds longer fillers until they alone reach the line count; a
  // filler takes its declarations, three more lines and an empty line.
  while (lengths.reduce((sum, length) => sum + length + 4, 0) < counts.lines)
    lengths.push(random.integer(8, 16));
  const plans = lengths.map(plain);
  const places = random.shuffle(
    plans.flatMap((plan, filler) => plan.map((_, index) => [filler, index])),
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

  // W and X: an expression to replace in a function that stands in a file of its
  // own, which main.cpp includes in the function's place. A W trap's file ends its
  // lines with CRLF and an X trap's file starts with a byte order mark; a control's
  // file has neither. A script that reads and writes the file in text mode turns
  // CRLF into LF without a word.
  for (const edit of [...ofCluster("W"), ...ofCluster("X")]) {
    const entry = build(take(functionNames), ["plain", { scoped: edit }, "plain"], {
      prototyped: false,
    });
    entry.file = `${entry.name}.inc`;
    entry.encoding = edit.variant === "control" ? "plain" : edit.cluster === "W" ? "crlf" : "bom";
    edit.file = entry.file;
    pairs.push([{ include: entry.name }]);
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
    if (edit.kind === "move" || edit.kind === "insert")
      edit.marker = `// __EXPLICIT_EDIT_SLOT_${++slot}_1__`;

  // Layout: fillers in random order; each zone and each move's destination in its own
  // gap between fillers, so a filler separates them.
  const units = [
    ...zones.map((zone, index) =>
      random.shuffle([
        { function: hosts[index].name },
        ...zone
          .filter(({ cluster }) => "BCGHIO".includes(cluster))
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
  ];
  const fillerOrder = random.shuffle(fillers);
  assert.ok(units.length <= fillerOrder.length + 1, "Too few fillers to separate the zones");
  const gaps = random.shuffle(Array.from({ length: fillerOrder.length + 1 }, (_, gap) => gap));
  const unitAt = new Map(units.map((unit, index) => [gaps[index], unit]));
  // The lead function is the first definition after the prototypes.
  const layout = [{ function: lead.name }];
  for (let gap = 0; gap <= fillerOrder.length; gap++) {
    layout.push(...(unitAt.get(gap) ?? []));
    if (gap < fillerOrder.length) layout.push({ function: fillerOrder[gap].name });
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
      calls = new Map();
    let order = layout;
    for (const edit of done.flatMap((task) => task.parts ?? [task])) {
      if (edit.kind === "rename") names.set(edit.name, edit.newName);
      if (edit.kind === "function-rename") calls.set(edit.name, edit.newName);
      if (["expression", "scoped-replace", "file-expression"].includes(edit.kind))
        factors.set(edit.statement, edit.newFactor);
      if (edit.kind === "local-rename") locals.set(edit.name, edit);
      if (["delete", "namespace-delete", "commented-delete"].includes(edit.kind))
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
    }
    const call = (name) => calls.get(name) ?? name;
    const context = { factors, name: (name) => names.get(name) ?? name, call };
    const definition = (entry) => {
      const text = [
        ...(entry.comment ?? []),
        header(entry.display ?? call(entry.name)),
        ...entry.body
          .filter((item) => !silenced.has(item.trace))
          .flatMap((item) => itemLines(item, 1, context)),
        `  return (${entry.result[0]} + ${entry.result[1]}) % kModulus;`,
        "}",
      ].join("\n");
      const local = locals.get(entry.name);
      return local ? text.replace(new RegExp(`\\b${local.local}\\b`, "g"), local.newName) : text;
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
          (block.include
            ? `#include "${byName.get(block.include).file}"`
            : definition(byName.get(block.function))),
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
    // Each included file holds one definition, in the file's own encoding.
    const files = Object.fromEntries(
      layout
        .filter((block) => block.include)
        .map((block) => {
          const entry = byName.get(block.include);
          const text = definition(entry) + "\n";
          const encoded =
            entry.encoding === "crlf"
              ? text.replaceAll("\n", "\r\n")
              : entry.encoding === "bom"
                ? `\ufeff${text}`
                : text;
          return [entry.file, encoded];
        }),
    );
    return { main: sections.join("\n\n") + "\n", files };
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
    if (edit.cluster === "K") {
      // Only a trap's signature stands in the other namespace too.
      assert.equal(occurrences(header(edit.name)), edit.variant === "trap" ? 2 : 1, edit.id);
      assert.equal(occurrences(`${signature(edit.name)};`), 0, `${edit.id} prototype`);
      for (const space of [edit.decoy, edit.namespace])
        assert.equal(occurrences(`namespace ${space} {`), 1, `${edit.id} namespace`);
    }
    if (edit.kind === "function-rename") {
      // Code names the function five times: its prototype, its definition, two
      // callers and main. Only a trap's comment and literal name it too.
      const mentioned = trap ? 2 : 0;
      assert.equal(identifierCount(start, edit.name), 5 + mentioned, `${edit.id} uses`);
      assert.equal(occurrences(`${signature(edit.name)};`), 1, `${edit.id} prototype`);
      assert.equal(identifierCount(start, edit.newName), 0, `${edit.id} new name exists`);
      assert.equal(identifierCount(expected, edit.name), mentioned, `${edit.id} mentions`);
      assert.equal(identifierCount(expected, edit.newName), 5, `${edit.id} new uses`);
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
    if (edit.kind === "file-expression") {
      // The expression stands once in its own file and nowhere else; only a W trap's
      // file holds a carriage return, and only an X trap's a byte order mark.
      const own = startFiles[edit.file];
      assert.equal(own.split(edit.before).length, 2, `${edit.id} expression is not unique`);
      assert.equal(occurrences(edit.before), 0, `${edit.id} expression in main.cpp`);
      assert.equal(occurrences(`#include "${edit.file}"`), 1, `${edit.id} include`);
      assert.equal(own.includes("\r"), trap && edit.cluster === "W", `${edit.id} line endings`);
      assert.ok(!own.includes("\r") || !/[^\r]\n/.test(own), `${edit.id} mixed line endings`);
      assert.equal(own.startsWith("\ufeff"), trap && edit.cluster === "X", `${edit.id} mark`);
      assert.equal(expectedFiles[edit.file], own.replace(edit.before, edit.after), edit.id);
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
    if (edit.kind === "move" || edit.kind === "insert")
      assert.equal(occurrences(edit.marker), 1, `${edit.id} marker is not unique`);
    if (edit.kind === "insert")
      assert.equal(identifierCount(start, edit.name), 0, `${edit.id} name exists`);
    if (edit.kind === "scoped-replace") {
      // An F trap's text also stands in two fillers; an I or R text also in the lead,
      // and a P, Q or S text in a decoy.
      const copies = "IPQRS".includes(edit.cluster) ? 2 : edit.variant === "trap" ? 3 : 1;
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

  // Tasks keep the zone order, so a wave whose size is a multiple of the density
  // holds whole zones. A composite task lists several edits of one zone, so its
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
        .filter(({ kind }) => ["expression", "scoped-replace", "file-expression"].includes(kind))
        .map((edit) => [edit.statement, edit.newFactor]),
    );
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
