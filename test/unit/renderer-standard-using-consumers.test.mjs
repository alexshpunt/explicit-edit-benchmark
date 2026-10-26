import assert from "node:assert/strict";
import { test } from "node:test";
import { atomicOwnerFrames } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-naming-replay.mjs";
import { standardUsingContext } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

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
