import assert from "node:assert/strict";
import test from "node:test";
import { applyCodeTraps } from "../../src/suites/explicit-edit-multi-agent/extraction/code-traps.mjs";

const units = [
  "inline float twice(float x) {\n  return x * 2.0f;\n}",
  "struct Pair {\n  int left;\n  int right;\n};",
  "using Real = float;",
  "int answer() {\n  return 42;\n}",
];
const source = `#include <cmath>\n\n${units.join("\n\n")}\n\nint main() { return answer(); }\n`;
const fragment = (id, text) => {
  const start = source.indexOf(text);
  return { id, start, end: start + text.length, text };
};
const plan = {
  initial: { "main.cpp": source },
  expected: { "a.h": "stale" },
  tasks: [
    {
      id: "a",
      file: "a.h",
      preamble: "#pragma once\n",
      destination: `#pragma once\n${units[0]}\n\n${units[1]}\n\n${units[2]}\n`,
      replacement: '#include "a.h"\n',
      fragments: units.slice(0, 3).map((text, index) => fragment(`a-${index}`, text)),
    },
    {
      id: "b",
      file: "b.cpp",
      preamble: '#include "a.h"\n',
      destination: `#include "a.h"\n${units[3]}\n`,
      replacement: "",
      fragments: [fragment("b-0", units[3])],
    },
  ],
};
const all = Object.fromEntries(
  [
    "insideComment",
    "insideLiteral",
    "insideRawString",
    "insideInitializer",
    "memberComment",
    "betweenComment",
    "commentedCopy",
    "betweenInitializer",
    "betweenRawString",
    "macro",
    "overload",
  ].map((kind) => [kind, 100]),
);

test("level 0 leaves the plan unchanged", () => {
  assert.equal(applyCodeTraps(plan, 0), plan);
  assert.throws(() => applyCodeTraps(plan, 4), /Unsupported code trap level/);
});

test("traps inside units move with them; traps between units stay in the source", () => {
  const trapped = applyCodeTraps(plan, 1, { rates: all });
  const main = trapped.initial["main.cpp"];
  assert.equal(trapped.expected, undefined, "The stale extraction expectation is dropped");
  for (const task of trapped.tasks) {
    let cursor = 0;
    for (const item of task.fragments) {
      assert.equal(main.slice(item.start, item.end), item.text);
      const at = task.destination.indexOf(item.text, cursor);
      assert.ok(at >= cursor, "Destinations carry the trapped unit text in order");
      cursor = at + item.text.length;
    }
  }
  const [twice, pair, real] = trapped.tasks[0].fragments;
  assert.match(twice.text, /\n {2}\/\/ \}; the unit does not end here \{\n/);
  assert.match(twice.text, /\n {2}\(void\)"\}; \{";\n/);
  assert.match(twice.text, /\n {2}\(void\)R"trap\(\};\n\{\)trap";\n/);
  assert.match(
    twice.text,
    /\[\[maybe_unused\]\] const int explicit_edit_trap_\d+\[\] = \{0, 1\};\n\}$/,
  );
  assert.match(pair.text, /\n {2}\/\/ \};\n\};$/);
  assert.equal(real.text, "using Real = float;", "Unnamed blocks keep their text");
  // Between units: a comment, a commented copy, an initializer, a raw string and a macro.
  const before = main.slice(0, twice.start);
  assert.match(before, /\/\/ \}; \{\n/);
  assert.match(
    before,
    /\/\*\ninline float twice\(float x\) \{\n {2}return x \* 2\.0f;\n\}\n\*\/\n/,
  );
  assert.match(before, /static const int explicit_edit_trap_\d+\[\] = \{1, 2\};\n/);
  assert.match(before, /R"trap\(\n\};\n\)trap";\n/);
  assert.match(before, /#define EXPLICIT_EDIT_TRAP_\d+\(x\) \{ x; \}\n/);
  assert.ok(!main.slice(0, real.start).includes("/*\nusing Real"), "No commented copy of a block");
  // A tag-typed overload follows the original and is no fragment.
  const after = main.slice(twice.end, pair.start);
  assert.match(
    after,
    /struct ExplicitEditTrapTag\d+ \{\};\ninline float twice\(float x, ExplicitEditTrapTag\d+\) \{/,
  );
  assert.match(
    main.slice(trapped.tasks[1].fragments[0].end),
    /int answer\(ExplicitEditTrapTag\d+\)/,
  );
  assert.deepEqual(trapped.traps.level, 1);
});

test("trap placement is deterministic and grows with the level", () => {
  const counts = [1, 2, 3].map((level) => applyCodeTraps(plan, level).traps.insertions);
  assert.deepEqual(
    [1, 2, 3].map((level) => applyCodeTraps(plan, level).traps.insertions),
    counts,
  );
  assert.ok(counts[0] <= counts[1] && counts[1] <= counts[2]);
});
