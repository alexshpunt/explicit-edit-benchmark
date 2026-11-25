import assert from "node:assert/strict";
import { renameProse } from "../extraction/mixed-probe.mjs";

/** A small generated C++ project for Multi-Agent: one main.cpp whose functions each
 * add a weighted contribution to a checksum that main prints. A seed fixes the
 * program, its tasks and the reference. Every task has exactly one correct result,
 * and no two tasks edit the same text: a moved function holds no renamed name and no
 * changed expression, so the reference does not depend on the order of the tasks.
 */
export const CHECKSUM_PROJECT_VERSION = "multi-agent-checksum-project-v1";
export const CHECKSUM_PROJECT_DEFAULTS = Object.freeze({
  functions: 18,
  moves: 4,
  renames: 3,
  expressions: 3,
});
const MODULUS = 1000003;
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

/** The source text of one statement's expression; `names` maps original function
 * names to current ones and `constants` overrides changed multipliers.
 */
function expressionText(statement, names, constants) {
  const factor = constants.get(statement.id) ?? statement.factor;
  const { left, right, offset, callee } = statement;
  if (statement.kind === "linear") return `${left} * ${factor} + ${offset}`;
  if (statement.kind === "product") return `${left} * ${right} + ${offset}`;
  if (statement.kind === "mix") return `(${left} ^ ${factor}) + ${right}`;
  if (statement.kind === "call") return `${names.get(callee) ?? callee}(${left}) + ${offset}`;
  throw new Error(`Unknown statement kind ${statement.kind}`);
}

/** Generate one project with its tasks and references. */
export function generateChecksumProject(seed, options = {}) {
  assert.ok(Number.isSafeInteger(seed) && seed >= 0, "Seed must be a non-negative integer");
  const counts = { ...CHECKSUM_PROJECT_DEFAULTS, ...options };
  assert.ok(counts.functions >= counts.moves + counts.renames + 4, "Too few functions");
  const random = generator(seed);

  // Distinct numbers keep every changed expression unique in the file.
  const taken = new Set();
  const number = () => {
    for (;;) {
      const value = random.integer(11, 997);
      if (!taken.has(value)) {
        taken.add(value);
        return value;
      }
    }
  };
  const allNames = random.shuffle(
    ADJECTIVES.flatMap((adjective) => NOUNS.map((noun) => `${adjective}_${noun}`)),
  );
  const fresh = () => {
    const name = allNames.pop();
    assert.ok(name, "Name vocabulary exhausted");
    return name;
  };

  const functions = [];
  for (let index = 0; index < counts.functions; index++) {
    const name = fresh();
    const statements = [];
    const length = random.integer(2, 4);
    const available = ["value"];
    for (let position = 0; position < length; position++) {
      const variable = "abcd"[position];
      const left = available[available.length - 1];
      const right = random.pick(available);
      const kinds = ["linear", "linear", "product", "mix"];
      if (index > 0) kinds.push("call", "call");
      const kind = random.pick(kinds);
      const statement = { id: `${name}:${variable}`, variable, kind, left, right };
      if (kind === "linear" || kind === "mix") statement.factor = number();
      if (kind !== "mix") statement.offset = number();
      if (kind === "call") statement.callee = functions[random.integer(0, index - 1)].name;
      statements.push(statement);
      available.push(variable);
    }
    const last = available[available.length - 1];
    functions.push({ name, statements, result: [last, random.pick(available.slice(0, -1))] });
  }
  const byName = new Map(functions.map((entry) => [entry.name, entry]));
  const calls = (entry) =>
    entry.statements.filter(({ kind }) => kind === "call").map(({ callee }) => callee);
  const callers = (name) => functions.filter((entry) => calls(entry).includes(name));
  const main = random
    .shuffle(functions)
    .map(({ name }) => ({ name, weight: random.integer(2, 9), input: number() }));

  const evaluate = (constants) => {
    const memo = new Map();
    const run = (name, value) => {
      const key = `${name}(${value})`;
      if (memo.has(key)) return memo.get(key);
      const entry = byName.get(name);
      const scope = new Map([["value", value]]);
      for (const statement of entry.statements) {
        const left = scope.get(statement.left),
          right = scope.get(statement.right);
        const factor = constants.get(statement.id) ?? statement.factor;
        const raw =
          statement.kind === "linear"
            ? left * factor + statement.offset
            : statement.kind === "product"
              ? left * right + statement.offset
              : statement.kind === "mix"
                ? (left ^ factor) + right
                : run(statement.callee, left) + statement.offset;
        assert.ok(Number.isSafeInteger(raw) && raw >= 0, "Checksum arithmetic left the safe range");
        scope.set(statement.variable, raw % MODULUS);
      }
      const result = (scope.get(entry.result[0]) + scope.get(entry.result[1])) % MODULUS;
      memo.set(key, result);
      return result;
    };
    let total = 0;
    for (const call of main) total = (total + call.weight * run(call.name, call.input)) % MODULUS;
    return String(total);
  };

  // Renames: functions that other functions call, so the rename edits bodies too.
  const renamed = random
    .shuffle(functions.filter(({ name }) => callers(name).length > 0))
    .slice(0, counts.renames);
  assert.equal(renamed.length, counts.renames, "Too few called functions to rename");
  const renamedNames = new Set(renamed.map(({ name }) => name));
  // Moves: functions whose text no other task edits.
  const moved = random
    .shuffle(
      functions.filter(
        (entry) =>
          !renamedNames.has(entry.name) && !calls(entry).some((name) => renamedNames.has(name)),
      ),
    )
    .slice(0, counts.moves);
  assert.equal(moved.length, counts.moves, "Too few independent functions to move");
  const movedNames = new Set(moved.map(({ name }) => name));
  // Expressions: one multiplier in each of a few functions that are neither moved
  // nor renamed, so every prompt names a function that keeps its name.
  const startAnswer = evaluate(new Map());
  const changeable = random.shuffle(
    functions
      .filter(({ name }) => !movedNames.has(name) && !renamedNames.has(name))
      .map((entry) => entry.statements.find(({ kind }) => kind === "linear" || kind === "mix"))
      .filter(Boolean),
  );
  const changes = [];
  for (const statement of changeable) {
    if (changes.length === counts.expressions) break;
    const factor = number();
    if (evaluate(new Map([[statement.id, factor]])) === startAnswer) continue;
    changes.push({ statement, factor });
  }
  assert.equal(changes.length, counts.expressions, "Too few expressions to change");

  // Layout: definitions in random order; each move's slot at least two blocks away
  // from its function, so the move changes the order of the definitions.
  let blocks = random.shuffle(functions.map(({ name }) => ({ function: name })));
  const slots = moved.map((entry, index) => ({
    name: entry.name,
    marker: `// __EXPLICIT_EDIT_SLOT_${index + 1}_1__`,
  }));
  for (const slot of slots) {
    const home = () => blocks.findIndex((block) => block.function === slot.name);
    const places = [];
    for (let at = 0; at <= blocks.length; at++)
      if (at < home() - 1 || at > home() + 2) places.push(at);
    blocks.splice(random.pick(places), 0, { marker: slot.marker });
  }
  const prototypes = random.shuffle(functions.map(({ name }) => name));

  const render = (done) => {
    const names = new Map(),
      constants = new Map();
    let order = blocks;
    for (const task of done) {
      if (task.kind === "rename") names.set(task.name, task.newName);
      if (task.kind === "expression") constants.set(task.statement, task.newFactor);
      if (task.kind === "move")
        order = order
          .filter((block) => block.function !== task.name)
          .map((block) => (block.marker === task.marker ? { function: task.name } : block));
    }
    const current = (name) => names.get(name) ?? name;
    const definition = (entry) =>
      [
        `long long ${current(entry.name)}(long long value) {`,
        ...entry.statements.map(
          (statement) =>
            `  long long ${statement.variable} = (${expressionText(statement, names, constants)}) % kModulus;`,
        ),
        `  return (${entry.result[0]} + ${entry.result[1]}) % kModulus;`,
        "}",
      ].join("\n");
    const sections = [
      [`// Checksum program generated from seed ${seed}.`, "#include <iostream>"].join("\n"),
      `const long long kModulus = ${MODULUS};`,
      prototypes.map((name) => `long long ${current(name)}(long long value);`).join("\n"),
      ...order.map((block) => block.marker ?? definition(byName.get(block.function))),
      [
        "int main() {",
        "  long long total = 0;",
        ...main.map(
          (call) =>
            `  total = (total + ${call.weight} * ${current(call.name)}(${call.input})) % kModulus;`,
        ),
        "  std::cout << total << '\\n';",
        "  return 0;",
        "}",
      ].join("\n"),
    ];
    return sections.join("\n\n") + "\n";
  };

  const KEEP = "Leave all other code unchanged.";
  const tasks = [
    ...slots.map((slot) => ({
      id: `move-${slot.name}`,
      kind: "move",
      name: slot.name,
      marker: slot.marker,
      prompt: [
        `In main.cpp, move the definition of the function \`${slot.name}\` to the placeholder line \`${slot.marker}\`, replacing that line with the complete definition. Keep the definition's code exactly as it is. Remove it from its old place together with the empty line that follows it.`,
        KEEP,
      ].join("\n\n"),
    })),
    ...renamed.map(({ name }) => {
      const newName = fresh();
      return {
        id: `rename-${name}`,
        kind: "rename",
        name,
        newName,
        prompt: renameProse(
          { kind: "unique", role: "function", name, newName },
          { isolated: true },
        ),
      };
    }),
    ...changes.map(({ statement, factor }) => {
      const name = statement.id.split(":")[0];
      const before = expressionText(statement, new Map(), new Map());
      const after = expressionText(statement, new Map(), new Map([[statement.id, factor]]));
      return {
        id: `expression-${name}`,
        kind: "expression",
        name,
        statement: statement.id,
        before,
        after,
        newFactor: factor,
        prompt: [
          `In main.cpp, in the function \`${name}\`, replace the expression \`${before}\` with \`${after}\`.`,
          KEEP,
        ].join("\n\n"),
      };
    }),
  ];

  const start = render([]);
  const expected = render(tasks);
  for (const task of tasks.filter(({ kind }) => kind === "expression"))
    assert.equal(start.split(task.before).length - 1, 1, `Expression ${task.before} is not unique`);
  const constantsOf = (done) =>
    new Map(
      done
        .filter(({ kind }) => kind === "expression")
        .map((task) => [task.statement, task.newFactor]),
    );
  const result = tasks.map((task) => ({
    ...task,
    result: render([task]),
    answer: evaluate(constantsOf([task])),
  }));
  for (const task of result) assert.notEqual(task.result, start, `${task.id} changes nothing`);
  return {
    version: CHECKSUM_PROJECT_VERSION,
    seed,
    counts,
    start,
    expected,
    answers: { start: startAnswer, expected: evaluate(constantsOf(tasks)) },
    tasks: random.shuffle(result),
  };
}
