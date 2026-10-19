import assert from "node:assert/strict";
import test from "node:test";
import { replayStructuralNodes } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-structural-replay.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";

const remove = (name, file = "main.cpp", extra = {}) => ({
  operations: [
    {
      phase: "structure",
      action: "remove-generated-declaration",
      file,
      selector: { scope: "sample", declarator: `void${name}()`, definition: false, ...extra },
    },
  ],
});
const sequential = (tree, nodes) =>
  nodes.reduce((current, node) => node.operations.reduce(applyCoherentStructure, current), tree);

// This is byte-equivalence coverage; the performance RED is the bounded live
// canonical window, not a fabricated parser-call or elapsed-time unit assertion.
test("plain prototype replay matches sequential edits through subsets, reordering and CRLF", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "namespace sample {",
      "void first();",
      "void second();",
      "void third();",
      "int keep() { return 7; }",
      "}",
      "",
    ].join(newline);
    const tree = Object.freeze({ "main.cpp": source, "untouched.h": "// λ stays untouched\n" });
    const nodes = [remove("first"), remove("second"), remove("third")];
    for (const indices of [[], [0], [0, 1], [2, 0], [1, 2, 0]]) {
      const selected = indices.map((index) => nodes[index]);
      assert.deepEqual(replayStructuralNodes(tree, selected), sequential(tree, selected));
      assert.equal(tree["main.cpp"], source);
    }
  }
});

test("replay preserves separate files, conditional branches and intervening structural edits", () => {
  const tree = {
    "main.cpp":
      "namespace sample {\n#if FIRST\nvoid first();\n#endif\nvoid second();\nvoid third();\n}\n",
    "other.cpp": "namespace sample { void fourth(); }\n",
  };
  const nodes = [remove("first"), remove("second"), remove("fourth", "other.cpp"), remove("third")];
  assert.deepEqual(replayStructuralNodes(tree, nodes), sequential(tree, nodes));
  const intervening = { operations: [nodes[0].operations[0], nodes[1].operations[0]] };
  const mixed = [intervening, ...nodes.slice(2)];
  assert.deepEqual(replayStructuralNodes(tree, mixed), sequential(tree, mixed));
});

test("occurrence-sensitive and brace-containing declarations retain sequential selection", () => {
  const tree = {
    "main.cpp":
      "namespace sample { void first(); void first(); void second(); struct Box { int value; }; }\n",
  };
  const record = {
    operations: [
      {
        phase: "structure",
        action: "remove-generated-declaration",
        file: "main.cpp",
        selector: { scope: "sample", declarator: "structBox", definition: false },
      },
    ],
  };
  const nodes = [
    remove("first", "main.cpp", { occurrence: 0 }),
    remove("first", "main.cpp", { occurrence: 0 }),
    remove("second"),
    record,
  ];
  assert.deepEqual(replayStructuralNodes(tree, nodes), sequential(tree, nodes));
});

test("ambiguous, missing and repeated prototypes keep the original sequential rejection", () => {
  const cases = [
    [
      { "main.cpp": "namespace sample { void first(); void first(); void second(); }" },
      [remove("first"), remove("second")],
    ],
    [
      { "main.cpp": "namespace sample { void first(); void second(); }" },
      [remove("first"), remove("missing")],
    ],
    [
      { "main.cpp": "namespace sample { void first(); void second(); }" },
      [remove("first"), remove("first")],
    ],
  ];
  for (const [tree, nodes] of cases) {
    assert.throws(() => sequential(tree, nodes), /Missing or ambiguous/);
    assert.throws(() => replayStructuralNodes(tree, nodes), /Missing or ambiguous/);
  }
});
