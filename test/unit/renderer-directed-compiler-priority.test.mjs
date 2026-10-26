import assert from "node:assert/strict";
import test from "node:test";
import { barrierRepairNodes } from "../../src/suites/explicit-edit-multi-agent/grading/repair-diagnostics.mjs";

function fixture() {
  const tree = {
    "api.h": "namespace api {\nfloat Slow(float);\nfloat Wanted(float);\n}\n",
    "main.cpp":
      '#include "api.h"\nusing namespace api; float result[] = { /* 😀 */ wanted(1.0f) };\n',
  };
  const nodes = ["Slow", "Wanted"].map((name) => ({
    id: `published-${name}`,
    taskId: "public-functions",
    operations: [
      {
        phase: "names",
        category: "functions-types",
        mapping: [{ from: name, to: name.toLowerCase() }],
        selectors: [
          {
            kind: "function",
            scope: `api::${name}`,
            signature: "float (float)",
            definition: false,
          },
        ],
      },
    ],
  }));
  const bindings = ["Slow", "Wanted"].map((name, index) => ({
    id: `PRIVATE_FUNCTION_${name}`,
    file: "api.h",
    translationUnit: "main.cpp",
    offset: tree["api.h"].indexOf(name),
    name,
    role: "function",
    scope: `api::${name}`,
    declaringScope: "api",
    definition: false,
    internal: false,
    line: index + 2,
    column: 7,
    owner: { scope: `api::${name}`, signature: "float (float)", definition: false },
    files: ["api.h", "main.cpp"],
  }));
  const line = tree["main.cpp"].split("\n")[1];
  return {
    tree,
    nodes,
    bindings,
    column: Buffer.byteLength(line.slice(0, line.indexOf("wanted"))) + 1,
  };
}

for (const [label, message, severity, located, promoted] of [
  ["unavailable overload", "no matching function for call to 'wanted'", "error", false, true],
  ["unresolved final name", "use of undeclared identifier 'wanted'", "error", false, true],
  [
    "narrowing at an existing wrong call",
    "non-constant-expression cannot be narrowed from type 'double' to 'float' in initializer list [-Wc++11-narrowing]",
    "error",
    true,
    true,
  ],
  ["warning", "no matching function for call to 'wanted'", "warning", true, false],
  [
    "invalid UTF-8 boundary",
    "non-constant-expression cannot be narrowed from type 'double' to 'float' in initializer list",
    "error",
    "invalid",
    false,
  ],
]) {
  test(`current compiler naming priority: ${label}`, () => {
    const { tree, nodes, bindings, column } = fixture();
    const invalid = Buffer.byteLength(tree["main.cpp"].split("\n")[1].split("😀")[0]) + 2;
    const error = {
      file: "main.cpp",
      line: 2,
      column: located === "invalid" ? invalid : located ? column : 1,
      severity,
      message,
    };
    const repairs = barrierRepairNodes({
      category: "structure",
      tree,
      nodes,
      bindings,
      compiler: [error],
    });
    const renames = repairs.filter((node) => node.operations[0].action === "rename-binding");
    assert.equal(renames.length, 2, "Priority must not drop other current requirements");
    assert.equal(renames[0].operations[0].target.name, promoted ? "Wanted" : "Slow");
    assert.equal(
      repairs.some((node) => node.operations[0].action === "inspect"),
      severity === "error",
      "Ranking must preserve error feedback without inventing work from warnings",
    );
    assert.ok(
      repairs.every(
        (node) =>
          !Object.hasOwn(node, "taskId") && node.operations.every((op) => op.phase === "repair"),
      ),
    );
    assert.equal(JSON.stringify(repairs).includes("PRIVATE_FUNCTION_"), false);
    assert.equal(JSON.stringify(repairs).includes("published-"), false);
  });
}
