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
export const CHECKSUM_PROJECT_VERSION = "multi-agent-checksum-project-v5";
export const CHECKSUM_CLUSTERS = Object.freeze({
  A: "completeness",
  B: "target selection",
  C: "structure",
  D: "large supplied text",
  E: "byte exactness",
});
export const CHECKSUM_PROJECT_DEFAULTS = Object.freeze({
  // Trap edits and control edits per cluster.
  perVariant: 2,
  // Edits per zone.
  density: 1,
  // Edits per task; more than one makes composite tasks.
  edits: 1,
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
  if (statement.kind === "call") return `${statement.callee}(${left}) + ${offset}`;
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
  if (item.type === "update")
    return [
      `${pad}${item.variable} = (${item.variable} * ${item.factor} + ${item.offset}) % kModulus;`,
    ];
  if (item.type === "if")
    return [
      `${pad}if (${item.variable} % ${item.mod} == ${item.rem}) {`,
      ...itemLines(item.action, depth + 1, context),
      `${pad}}`,
    ];
  if (item.type === "for")
    return [
      `${pad}for (int i = 0; i < ${item.times}; ++i) {`,
      ...item.body.flatMap((inner) => itemLines(inner, depth + 1, context)),
      `${pad}}`,
    ];
  throw new Error(`Unknown body item ${item.type}`);
}

/** One edit as a mechanical instruction of exact text. */
function instruction(edit) {
  if (edit.kind === "rename")
    return `In main.cpp, replace every occurrence of the identifier ${q(edit.name)} with ${q(edit.newName)}; there are ${edit.occurrences} occurrences. Longer identifiers that contain this spelling stay unchanged.`;
  if (edit.kind === "move")
    return `In main.cpp, move the complete definition of the function ${q(signature(edit.name))} to the placeholder line ${q(edit.marker)}: the definition replaces that placeholder line. Also delete the empty line that directly followed the definition in its old place. Keep the text of the definition unchanged.`;
  if (edit.kind === "insert")
    return `In main.cpp, replace the placeholder line ${q(edit.marker)} with the following ${edit.lines} lines: ${q(edit.text)}.`;
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

const KIND = { A: "rename", B: "move", C: "move", D: "insert", E: "expression" };

/** Generate one project with its tasks and references. */
export function generateChecksumProject(seed, options = {}) {
  assert.ok(Number.isSafeInteger(seed) && seed >= 0, "Seed must be a non-negative integer");
  /** @type {{ perVariant: number, density: number, edits: number }} */
  const counts = { ...CHECKSUM_PROJECT_DEFAULTS, ...options };
  for (const key of ["perVariant", "density", "edits"])
    assert.ok(Number.isSafeInteger(counts[key]) && counts[key] >= 1, `${key} must be positive`);
  const random = generator(seed);

  // Distinct numbers keep every changed expression unique in the file.
  const taken = new Set();
  const number = () => {
    for (;;) {
      const value = random.integer(11, 1999);
      if (!taken.has(value)) {
        taken.add(value);
        return value;
      }
    }
  };
  const vocabulary = (first, second) =>
    random.shuffle(first.flatMap((word) => second.map((other) => `${word}_${other}`)));
  const functionNames = vocabulary(ADJECTIVES, NOUNS);
  const constantNames = vocabulary(CONSTANT_WORDS, CONSTANT_SUFFIXES);
  const take = (names) => {
    const name = names.pop();
    assert.ok(name, "Name vocabulary exhausted");
    return name;
  };

  // Edits, then zones in a random order. A zone holds the edits of `density` tasks,
  // so that many agents work in it at the same moment.
  const edits = [];
  for (const cluster of Object.keys(CHECKSUM_CLUSTERS))
    for (const variant of ["trap", "control"])
      for (let index = 1; index <= counts.perVariant; index++)
        edits.push({ cluster, variant, kind: KIND[cluster] });
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
  const build = (name, plan, { callees = library.map((entry) => entry.name), prototyped }) => {
    const body = [];
    const available = ["value"];
    for (const [index, entry] of plan.entries()) {
      const variable = VARIABLES[index];
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
      else {
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

  // Fillers hold the constant uses that are not in a host; the first few are the
  // library. There are enough fillers to keep zones and slots apart at density 1,
  // and one more for each host that a higher density saves, so the file keeps its
  // size across densities.
  const moves = [...ofCluster("B"), ...ofCluster("C")];
  const lengths = [];
  while (
    lengths.length < Math.max(LIBRARY_SIZE, 2 * edits.length - zones.length + moves.length - 1) ||
    lengths.reduce((sum, length) => sum + length, 0) < fillerUses.length * 1.4
  )
    lengths.push(random.integer(3, 5));
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

  // Hosts: one per zone, with the zone's A uses and E sites on neighbouring lines.
  const hosts = zones.map((zone) => {
    const sites = zone
      .filter(({ cluster }) => cluster === "A" || cluster === "E")
      .map((edit) => (edit.cluster === "A" ? { constant: edit.name } : { site: edit }));
    return build(take(functionNames), ["plain", ...random.shuffle(sites), "plain"], {
      prototyped: false,
    });
  });

  // B and C: moved functions. A B trap has a prototype; a C trap has nested blocks.
  for (const edit of moves) {
    const entry = build(
      take(functionNames),
      plain(edit.cluster === "C" ? 3 : random.integer(2, 4)),
      {
        prototyped: edit.cluster === "B" && edit.variant === "trap",
      },
    );
    if (edit.cluster === "C" && edit.variant === "trap") {
      const variable = entry.body[1].variable;
      const update = () => ({
        type: "update",
        variable,
        factor: random.integer(2, 9),
        offset: number(),
      });
      const condition = () => {
        const mod = random.integer(2, 5);
        return { type: "if", variable, mod, rem: random.integer(0, mod - 1), action: update() };
      };
      entry.body.splice(
        2,
        0,
        { type: "for", variable, times: random.integer(2, 4), body: [condition(), update()] },
        condition(),
      );
    }
    edit.name = entry.name;
  }

  // D: a supplied function that nothing calls, so it changes text but not the answer.
  // A trap's string literals hold escapes and shell characters; a control's hold
  // plain words in the same shape.
  for (const edit of ofCluster("D")) {
    const name = take(functionNames);
    const pool = edit.variant === "trap" ? ESCAPED_LITERALS : PLAIN_LITERALS;
    const lines = [
      header(name),
      "  const char* labels[] = {",
      ...random
        .shuffle(pool)
        .slice(0, SUPPLIED_LITERALS)
        .map((literal) => `    "${literal}",`),
      "  };",
      `  long long total = (value * ${random.integer(3, 997)} + ${random.integer(3, 997)}) % kModulus;`,
      "  for (const char* label : labels)",
      "    for (const char* p = label; *p != 0; ++p) total = (total * 31 + *p) % kModulus;",
      "  return total;",
      "}",
    ];
    edit.name = name;
    edit.text = lines.join("\n");
    edit.lines = lines.length;
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
        ...zone.filter(({ kind }) => kind === "move").map(({ name }) => ({ function: name })),
        ...zone.filter(({ kind }) => kind === "insert").map(({ marker }) => ({ marker })),
      ]),
    ),
    ...moves.map(({ marker }) => [{ marker }]),
  ];
  const fillerOrder = random.shuffle(fillers);
  assert.ok(units.length <= fillerOrder.length + 1, "Too few fillers to separate the zones");
  const gaps = random.shuffle(Array.from({ length: fillerOrder.length + 1 }, (_, gap) => gap));
  const unitAt = new Map(units.map((unit, index) => [gaps[index], unit]));
  const layout = [];
  for (let gap = 0; gap <= fillerOrder.length; gap++) {
    layout.push(...(unitAt.get(gap) ?? []));
    if (gap < fillerOrder.length) layout.push({ function: fillerOrder[gap].name });
  }
  const prototypes = random.shuffle(functions.filter(({ prototyped }) => prototyped));
  const declarations = random.shuffle(constants);
  const main = random
    .shuffle(functions)
    .map(({ name }) => ({ name, weight: random.integer(2, 9), input: number() }));

  const byName = new Map(functions.map((entry) => [entry.name, entry]));
  const evaluate = (factors) => {
    const memo = new Map();
    const step = (item, scope) => {
      const { variable } = item;
      if (item.type === "update")
        scope.set(variable, (scope.get(variable) * item.factor + item.offset) % MODULUS);
      else if (item.type === "if") {
        if (scope.get(variable) % item.mod === item.rem) step(item.action, scope);
      } else if (item.type === "for") {
        for (let round = 0; round < item.times; round++)
          for (const inner of item.body) step(inner, scope);
      } else {
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
                  : run(item.callee, left) + item.offset;
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

  // E: a new factor that changes the answer.
  const startAnswer = evaluate(new Map());
  for (const edit of ofCluster("E")) {
    do edit.newFactor = number();
    while (evaluate(new Map([[edit.statement, edit.newFactor]])) === startAnswer);
    edit.after = edit.before.replace(` * ${edit.factor} + `, ` * ${edit.newFactor} + `);
  }

  const render = (done) => {
    const names = new Map(),
      factors = new Map();
    let order = layout;
    for (const edit of done.flatMap((task) => task.parts ?? [task])) {
      if (edit.kind === "rename") names.set(edit.name, edit.newName);
      if (edit.kind === "expression") factors.set(edit.statement, edit.newFactor);
      if (edit.kind === "move")
        order = order
          .filter((block) => block.function !== edit.name)
          .map((block) => (block.marker === edit.marker ? { function: edit.name } : block));
      if (edit.kind === "insert")
        order = order.map((block) => (block.marker === edit.marker ? { text: edit.text } : block));
    }
    const context = { factors, name: (name) => names.get(name) ?? name };
    const definition = (entry) =>
      [
        header(entry.name),
        ...entry.body.flatMap((item) => itemLines(item, 1, context)),
        `  return (${entry.result[0]} + ${entry.result[1]}) % kModulus;`,
        "}",
      ].join("\n");
    const sections = [
      [`// Checksum program generated from seed ${seed}.`, "#include <iostream>"].join("\n"),
      [
        `const long long kModulus = ${MODULUS};`,
        ...declarations.map(
          ({ name, value }) => `const long long ${context.name(name)} = ${value};`,
        ),
      ].join("\n"),
      prototypes.map(({ name }) => `${signature(name)};`).join("\n"),
      ...order.map((block) => block.marker ?? block.text ?? definition(byName.get(block.function))),
      [
        "int main() {",
        "  long long total = 0;",
        ...main.map(
          (call) => `  total = (total + ${call.weight} * ${call.name}(${call.input})) % kModulus;`,
        ),
        "  std::cout << total << '\\n';",
        "  return 0;",
        "}",
      ].join("\n"),
    ];
    return sections.join("\n\n") + "\n";
  };

  const start = render([]);
  const expected = render(edits);
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
    if (edit.kind === "move") {
      assert.equal(occurrences(header(edit.name)), 1, `${edit.id} header is not unique`);
      const declared = edit.cluster === "B" && edit.variant === "trap" ? 1 : 0;
      assert.equal(occurrences(`${signature(edit.name)};`), declared, `${edit.id} prototype`);
    }
    if (edit.kind === "move" || edit.kind === "insert")
      assert.equal(occurrences(edit.marker), 1, `${edit.id} marker is not unique`);
    if (edit.kind === "insert") assert.equal(occurrences(edit.name), 0, `${edit.id} name exists`);
    if (edit.kind === "expression") {
      assert.equal(occurrences(edit.before), 1, `${edit.id} expression is not unique`);
      assert.equal(expected.split(edit.after).length, 2, `${edit.id} result is not unique`);
      // The comment line above and the edited line, exactly as the reference has them.
      const lines = expected.split("\n");
      const at = lines.findIndex((line) => line.includes(edit.after));
      edit.context = `${lines[at - 1]}\n${lines[at]}`;
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
        .filter(({ kind }) => kind === "expression")
        .map((edit) => [edit.statement, edit.newFactor]),
    );
  const result = tasks.map((task) => ({
    ...task,
    result: render([task]),
    answer: evaluate(factorsOf([task])),
  }));
  for (const task of result) assert.notEqual(task.result, start, `${task.id} changes nothing`);
  return {
    version: CHECKSUM_PROJECT_VERSION,
    seed,
    counts,
    start,
    expected,
    answers: { start: startAnswer, expected: evaluate(factorsOf(tasks)) },
    zones: zones.length,
    tasks: result,
  };
}
