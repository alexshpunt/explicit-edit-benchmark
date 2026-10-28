import assert from "node:assert/strict";
import { test } from "node:test";
import { atomicOwnerFrames } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-naming-replay.mjs";
import {
  standardUsingContext,
  createStandardUsingContext,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

const record = {
  file: "main.cpp",
  kind: "using",
  scope: "frond",
  conditions: [],
  tokens: ["using", "std", "::", "atomic", ";"],
};
const body = (name) => `int ${name}() {\n#if 0\natomic<int> value;\n#endif\nreturn 1;\n}\n`;

test("import availability is evaluated per actual consumer, including inactive bodies", () => {
  const tree = {
    "main.cpp":
      "#include <atomic>\nnamespace frond {\n" +
      body("early") +
      "using std::atomic;\n" +
      body("later") +
      "}\n",
  };
  const frames = atomicOwnerFrames(tree);
  const early = frames.find((frame) => frame.tokens.includes("early"));
  const later = frames.find((frame) => frame.tokens.includes("later"));
  assert.equal(standardUsingContext(tree, record), false);
  assert.equal(standardUsingContext(tree, record, false, { consumer: early }), false);
  assert.equal(standardUsingContext(tree, record, false, { consumer: later }), true);
});

test("per-consumer checks reuse imports available through preceding project headers", () => {
  const tree = {
    "common.h": "#pragma once\n#include <atomic>\nnamespace frond { using std::atomic; }\n",
    "main.cpp": '#include "common.h"\nnamespace frond {\n' + body("later") + "}\n",
  };
  const consumer = atomicOwnerFrames(tree).find((frame) => frame.tokens.includes("later"));
  assert.equal(standardUsingContext(tree, record, false, { consumer }), true);
});

test("one candidate import checker reads shared source once across consumer and omit-own queries", () => {
  const source =
    "#include <atomic>\nnamespace frond { using std::atomic;\n" + body("later") + "}\n";
  const consumer = atomicOwnerFrames({ "main.cpp": source }).find((frame) =>
    frame.tokens.includes("later"),
  );
  let reads = 0;
  const tree = {
    get "main.cpp"() {
      reads++;
      return source;
    },
  };
  const check = createStandardUsingContext(tree);
  for (let index = 0; index < 3; index++) {
    assert.equal(check(record, false, { consumer }), true);
    assert.equal(check(record, true, { consumer }), false);
  }
  assert.equal(reads, 1);
});

test("shared import parsing keeps import spelling, position and consumer obligations separate", () => {
  const tree = {
    "main.cpp":
      "#include <atomic>\nnamespace frond {\n" +
      body("early") +
      "using std::atomic;\n" +
      body("later") +
      "}\n",
  };
  const frames = atomicOwnerFrames(tree);
  const early = frames.find((frame) => frame.tokens.includes("early"));
  const later = frames.find((frame) => frame.tokens.includes("later"));
  const check = createStandardUsingContext(tree);
  assert.equal(check(record, false, { consumer: later }), true);
  assert.equal(check(record, false, { consumer: early }), false);
  assert.equal(check({ ...record, tokens: ["using", "std", "::", "vector", ";"] }), true);
  assert.equal(check(record, true, { consumer: later }), false);
  assert.equal(check(record, false, { consumer: { ...later, tokens: ["absent"] } }), false);
  assert.equal(check(record, false, { consumer: later }), true);
});

test("a new candidate cannot inherit the previous candidate import cache", () => {
  const original = {
    "main.cpp": "#include <atomic>\nnamespace frond { using std::atomic;\n" + body("later") + "}\n",
  };
  const damaged = { "main.cpp": original["main.cpp"].replace("using std::atomic;", "") };
  const consumer = atomicOwnerFrames(original).find((frame) => frame.tokens.includes("later"));
  assert.equal(createStandardUsingContext(original)(record, false, { consumer }), true);
  assert.equal(createStandardUsingContext(damaged)(record, false, { consumer }), false);
});
test("an unmatched consumer selector cannot grant vacuous import credit", () => {
  const tree = {
    "main.cpp": "#include <atomic>\nnamespace frond { using std::atomic;\n" + body("later") + "}\n",
  };
  assert.equal(standardUsingContext(tree, record), true);
  assert.equal(
    standardUsingContext(tree, record, false, {
      consumer: { scope: "frond", conditions: [], tokens: ["absent"] },
    }),
    false,
  );
});
