import assert from "node:assert/strict";
import test from "node:test";
import { barrierRepairNodes } from "../../src/suites/explicit-edit-multi-agent/grading/repair-diagnostics.mjs";
import { partitionAtomicQueues } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

function fixture(wrongOwner = false) {
  const array = "int new_array = 4;\n";
  const body = "int foo(int bad_arg) { return bad_arg + new_array; }\n";
  const tree = {
    "api.h": "#pragma once\nextern int new_array;\n",
    "main.cpp": '#include "api.h"\n' + (wrongOwner ? array : ""),
    "part.cpp": '#include "api.h"\n' + (wrongOwner ? "" : array) + body,
  };
  const nodes = [
    {
      id: "historical-move",
      taskId: "task-old",
      dependencies: [],
      prompt: "PUBLIC_OLD_MOVE",
      operations: [
        {
          phase: "structure",
          action: "implementation",
          file: "part.cpp",
          includes: [{ file: "api.h", quoted: true }],
          targets: [
            {
              selector: {
                kind: "variable",
                scope: "::",
                name: "old_array",
                declarator: "intold_array=4",
              },
              context: [],
            },
          ],
        },
      ],
    },
    {
      id: "array-name",
      taskId: "task-new",
      dependencies: [],
      prompt: "PUBLIC_OLD_ARRAY_RENAME",
      operations: [
        {
          phase: "names",
          category: "locals-parameters",
          mapping: [{ from: "old_array", to: "new_array" }],
          selectors: [{ kind: "variable", scope: "old_array" }],
        },
      ],
    },
    {
      id: "parameter-name",
      taskId: "task-new",
      dependencies: [],
      prompt: "PUBLIC_OLD_PARAMETER_RENAME",
      operations: [
        {
          phase: "names",
          category: "locals-parameters",
          mapping: [{ from: "bad_arg", to: "good_arg" }],
          selectors: [
            {
              kind: "variable",
              scope: "foo::bad_arg",
              owner: { scope: "foo", signature: "int (int)", definition: true },
            },
          ],
        },
      ],
    },
  ];
  const arrayFile = wrongOwner ? "main.cpp" : "part.cpp";
  const bindings = [
    {
      file: arrayFile,
      offset: tree[arrayFile].indexOf("new_array"),
      line: 2,
      column: 5,
      translationUnit: arrayFile,
      role: "variable",
      name: "new_array",
      scope: "new_array",
      declaringScope: "",
      definition: true,
      internal: false,
      id: "PRIVATE_ARRAY_USR",
      files: [arrayFile, "part.cpp"],
    },
    {
      file: "part.cpp",
      offset: tree["part.cpp"].indexOf("foo"),
      line: 3,
      column: 5,
      translationUnit: "part.cpp",
      role: "function",
      name: "foo",
      scope: "foo",
      declaringScope: "",
      owner: { scope: "foo", signature: "int (int)", definition: true },
      definition: true,
      internal: false,
      id: "PRIVATE_FUNCTION_USR",
      files: ["part.cpp"],
    },
    {
      file: "part.cpp",
      offset: tree["part.cpp"].indexOf("bad_arg"),
      line: 3,
      column: 13,
      translationUnit: "part.cpp",
      role: "variable",
      name: "bad_arg",
      scope: "foo::bad_arg",
      declaringScope: "foo",
      owner: { scope: "foo", signature: "int (int)", definition: true },
      definition: true,
      internal: false,
      id: "PRIVATE_PARAMETER_USR",
      files: ["part.cpp"],
    },
  ];
  for (const binding of bindings) {
    const prefix = tree[binding.file].slice(0, binding.offset);
    binding.line = prefix.split("\n").length;
    binding.column = binding.offset - prefix.lastIndexOf("\n");
  }
  return { tree, nodes, bindings };
}
const operations = (repairs) => repairs.flatMap((node) => node.operations ?? []);

test("a current parameter mismatch produces a fresh repair without replaying a satisfied historical move", () => {
  const input = fixture();
  const repairs = barrierRepairNodes({
    ...input,
    category: "structure",
    diagnostics: [
      {
        file: "part.cpp",
        kind: "owner",
        selector: "PRIVATE_EXPECTED_DECLARATION",
        tokensSha256: "PRIVATE_HASH",
      },
    ],
  });
  const work = operations(repairs);
  assert.equal(work.length, 1);
  assert.equal(work[0].phase, "repair");
  assert.equal(work[0].action, "rename-binding");
  assert.equal(work[0].target.file, "part.cpp");
  assert.equal(work[0].target.name, "bad_arg");
  assert.equal(work[0].required.name, "good_arg");
  assert.ok(
    repairs.every(
      (node) => !Object.hasOwn(node, "original") && !input.nodes.some((old) => old.id === node.id),
    ),
  );
  assert.equal(JSON.stringify(repairs).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(repairs).includes("PUBLIC_OLD_"), false);
  assert.ok(repairs[0].prompt.includes("bad_arg") && repairs[0].prompt.includes("good_arg"));
});

test("a wrong physical owner produces a current move using the public final name", () => {
  const input = fixture(true);
  const repairs = barrierRepairNodes({
    ...input,
    category: "structure",
    diagnostics: [{ file: "main.cpp" }, { file: "part.cpp" }],
  });
  const move = operations(repairs).find((operation) => operation.action === "move-declaration");
  assert.ok(move);
  assert.equal(move.target.file, "main.cpp");
  assert.equal(move.target.name, "new_array");
  assert.equal(move.required.file, "part.cpp");
  assert.equal(move.required.name, "new_array");
  assert.ok(!operations(repairs).some((operation) => operation.target?.name === "old_array"));
  assert.equal(partitionAtomicQueues(repairs, 15).filter((queue) => queue.length).length, 1);
});

test("independent current problems stay on balanced file queues", () => {
  const input = fixture();
  input.tree["other.cpp"] = "int bar(int Before) { return Before; }\n";
  input.nodes.push({
    id: "other-name",
    taskId: "task-new",
    dependencies: [],
    prompt: "PUBLIC_OLD_OTHER",
    operations: [
      {
        phase: "names",
        category: "locals-parameters",
        mapping: [{ from: "Before", to: "after" }],
        selectors: [
          {
            kind: "variable",
            scope: "bar::Before",
            owner: { scope: "bar", signature: "int (int)", definition: true },
          },
        ],
      },
    ],
  });
  input.bindings.push({
    file: "other.cpp",
    offset: input.tree["other.cpp"].indexOf("Before"),
    line: 1,
    column: 13,
    translationUnit: "other.cpp",
    role: "variable",
    name: "Before",
    scope: "bar::Before",
    declaringScope: "bar",
    owner: { scope: "bar", signature: "int (int)", definition: true },
    definition: true,
    internal: false,
    id: "PRIVATE_OTHER_USR",
    files: ["other.cpp"],
  });
  const repairs = barrierRepairNodes({
    ...input,
    category: "structure",
    diagnostics: [{ file: "part.cpp" }, { file: "other.cpp" }],
  });
  assert.equal(
    operations(repairs).filter((operation) => operation.action === "rename-binding").length,
    2,
  );
  assert.equal(partitionAtomicQueues(repairs, 15).filter((queue) => queue.length).length, 2);
});

test("an unresolved candidate use receives its unique public spelling without exposing private diagnostics", () => {
  const input = fixture();
  input.tree["part.cpp"] = '#include "api.h"\nint foo(int value) { return ObfValue; }\n';
  input.bindings = [];
  input.nodes.push({
    id: "resolved-name",
    taskId: "task-new",
    dependencies: [],
    prompt: "PUBLIC_OLD_UNRESOLVED",
    operations: [
      {
        phase: "names",
        category: "locals-parameters",
        mapping: [{ from: "ObfValue", to: "value" }],
        selectors: [
          {
            kind: "variable",
            scope: "foo::ObfValue",
            owner: { scope: "foo", signature: "int (int)", definition: true },
          },
        ],
      },
    ],
  });
  const start = input.tree["part.cpp"].indexOf("ObfValue");
  const compiler = [
    {
      file: "part.cpp",
      line: 2,
      column: start - input.tree["part.cpp"].lastIndexOf("\n", start - 1),
      severity: "error",
      message: "use of undeclared identifier 'ObfValue'",
      usr: "PRIVATE_USR",
    },
  ];
  const repairs = barrierRepairNodes({
    ...input,
    category: "structure",
    diagnostics: [{ file: "part.cpp", selector: "PRIVATE_EXPECTED" }],
    compiler,
  });
  const work = operations(repairs);
  assert.equal(work.length, 1);
  assert.equal(work[0].action, "replace-identifier");
  assert.equal(work[0].target.name, "ObfValue");
  assert.equal(work[0].required.name, "value");
  assert.equal(JSON.stringify(repairs).includes("PRIVATE_"), false);
});

test("a remaining vendor activation is diagnosed even when its destination already exists", () => {
  const tree = {
    "main.cpp": '#define IMPLEMENTATION\n#include "support/api.h"\nint main() { return 0; }\n',
    "support/api.h": "#pragma once\n",
    "support/stb.cpp": '#define IMPLEMENTATION\n#include "api.h"\n',
  };
  const nodes = [
    {
      id: "old-activation",
      taskId: "task-old",
      prompt: "PUBLIC_OLD_ACTIVATION",
      operations: [
        {
          phase: "structure",
          action: "vendor-implementation",
          file: "support/stb.cpp",
          macro: "IMPLEMENTATION",
        },
      ],
    },
  ];
  const repairs = barrierRepairNodes({
    tree,
    nodes,
    category: "structure",
    diagnostics: [{ file: "main.cpp" }],
  });
  const work = operations(repairs);
  assert.equal(work.length, 1);
  assert.equal(work[0].action, "remove-source-module");
  assert.equal(work[0].required.file, "support/stb.cpp");
  assert.equal(work[0].required.macro, "IMPLEMENTATION");
  assert.equal(JSON.stringify(repairs).includes("PUBLIC_OLD_"), false);
});

test("malformed current source remains repair work instead of a planner infrastructure failure", () => {
  const tree = {
    "main.cpp": "int broken() {\n",
    "api.h": "#ifndef API_H\n#define API_H\n#endif\n",
  };
  const nodes = [
    {
      id: "old-header",
      taskId: "task-old",
      prompt: "PUBLIC_OLD_HEADER",
      operations: [
        { phase: "structure", action: "header", file: "api.h", guard: "API_H", includes: [] },
      ],
    },
  ];
  const repairs = barrierRepairNodes({
    tree,
    nodes,
    category: "structure",
    diagnostics: [{ file: "main.cpp" }],
  });
  assert.ok(
    operations(repairs).some(
      (operation) => operation.action === "inspect" && operation.target.file === "main.cpp",
    ),
  );
  assert.ok(repairs.every((node) => !Object.hasOwn(node, "original")));
});

test("compiler feedback is attached once to each located problem rather than copied across its file", () => {
  const input = fixture();
  const file = "part.cpp";
  input.tree[file] = '#include "api.h"\nint foo(int value) { return Unknown + Unknown; }\n';
  input.bindings = [];
  input.nodes.push({
    id: "unknown-name",
    operations: [
      {
        phase: "names",
        category: "locals-parameters",
        mapping: [{ from: "Unknown", to: "value" }],
        selectors: [
          {
            kind: "variable",
            scope: "foo::Unknown",
            owner: { scope: "foo", signature: "int (int)", definition: true },
          },
        ],
      },
    ],
  });
  const positions = [...input.tree[file].matchAll(/Unknown/g)].map((match) => match.index);
  const compiler = positions.map((start) => ({
    file,
    line: 2,
    column: start - input.tree[file].lastIndexOf("\n", start - 1),
    severity: "error",
    message: "use of undeclared identifier 'Unknown'",
  }));
  const repairs = barrierRepairNodes({
    ...input,
    category: "structure",
    diagnostics: [{ file }],
    compiler: [...compiler, compiler[0]],
  });
  assert.equal(repairs.length, 2);
  assert.deepEqual(
    repairs.map((node) => node.diagnostics.length),
    [1, 1],
  );
  assert.equal(
    new Set(repairs.flatMap((node) => node.diagnostics.map((item) => JSON.stringify(item)))).size,
    2,
  );
});

test("an unrelated current compiler error stays explicit beside a same-file name correction", () => {
  const input = fixture();
  const file = "part.cpp";
  input.tree[file] = input.tree[file].replace("new_array; }", "new_array }");
  const start = input.tree[file].indexOf("}");
  const compiler = [
    {
      file,
      line: 3,
      column: start - input.tree[file].lastIndexOf("\n", start - 1),
      severity: "error",
      message: "expected ';' after return statement",
    },
  ];
  const repairs = barrierRepairNodes({
    ...input,
    category: "structure",
    diagnostics: [{ file }],
    compiler,
  });
  assert.ok(operations(repairs).some((operation) => operation.action === "rename-binding"));
  const inspect = repairs.find((node) => node.operations[0].action === "inspect");
  assert.ok(inspect);
  assert.equal(inspect.operations[0].target.line, 3);
  assert.deepEqual(inspect.diagnostics, compiler);
});

test("an unresolved desired member use keeps the current declaration goal, never a temporary rollback spelling", () => {
  const tree = {
    "api.h": "namespace api { struct Vec { int Old; }; }\n",
    "main.cpp": '#include "api.h"\nint read(api::Vec v) { return v.w; }\n',
  };
  const nodes = [
    {
      id: "old-field-task",
      taskId: "original-parent",
      prompt: "HISTORICAL_PAYLOAD",
      operations: [
        {
          phase: "names",
          category: "fields",
          mapping: [{ from: "Old", to: "w" }],
          selectors: [{ kind: "record", scope: "api::Vec" }],
        },
      ],
    },
  ];
  const bindings = [
    {
      file: "api.h",
      offset: tree["api.h"].indexOf("Old"),
      line: 1,
      column: tree["api.h"].indexOf("Old") + 1,
      translationUnit: "main.cpp",
      role: "field",
      name: "Old",
      scope: "api::Vec::Old",
      declaringScope: "api::Vec",
      definition: true,
      id: "PRIVATE_FIELD_ID",
      files: ["api.h"],
    },
  ];
  const repairs = barrierRepairNodes({
    category: "structure",
    tree,
    nodes,
    bindings,
    diagnostics: [{ file: "api.h", kind: "owner", scope: "api", selector: "structVec" }],
    compiler: [
      {
        file: "main.cpp",
        line: 2,
        column: 33,
        message: "no member named 'w' in 'api::Vec'",
        severity: "error",
      },
    ],
  });
  const operations = repairs.flatMap((node) => node.operations);
  const names = operations.filter((op) => op.action === "rename-binding");
  assert.equal(names.length, 1);
  assert.equal(names[0].target.name, "Old");
  assert.deepEqual(names[0].required, { name: "w" });
  assert.deepEqual(names[0].files, ["api.h", "main.cpp"]);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].diagnostics.length, 1);
  assert.equal(repairs[0].diagnostics[0].file, "main.cpp");
  assert.equal(
    operations.some((op) => op.action === "replace-identifier"),
    false,
  );
  assert.equal(JSON.stringify(repairs).includes("HISTORICAL_"), false);
  assert.equal(JSON.stringify(repairs).includes("PRIVATE_"), false);
  assert.ok(
    repairs.every((node) => !Object.hasOwn(node, "original") && !Object.hasOwn(node, "taskId")),
  );
});

test("a missing member in another class or with another public name stays explicit inspection work", () => {
  for (const [type, member] of [
    ["Peer", "w"],
    ["Vec", "other"],
  ]) {
    const tree = {
      "api.h": "namespace api { struct Vec { int Old; }; struct Peer { int x; }; }\n",
      "main.cpp": `#include "api.h"\nint read(api::${type} v) { return v.${member}; }\n`,
    };
    const nodes = [
      {
        id: "field-goal",
        operations: [
          {
            phase: "names",
            category: "fields",
            mapping: [{ from: "Old", to: "w" }],
            selectors: [{ kind: "record", scope: "api::Vec" }],
          },
        ],
      },
    ];
    const bindings = [
      {
        file: "api.h",
        offset: tree["api.h"].indexOf("Old"),
        name: "Old",
        role: "field",
        scope: "api::Vec::Old",
        declaringScope: "api::Vec",
        definition: true,
        translationUnit: "main.cpp",
        line: 1,
        column: tree["api.h"].indexOf("Old") + 1,
        id: "PRIVATE_UNRELATED_FIELD",
        files: ["api.h"],
      },
    ];
    const compiler = [
      {
        file: "main.cpp",
        line: 2,
        column: 33,
        severity: "error",
        message: `no member named '${member}' in 'api::${type}'`,
      },
    ];
    const repairs = barrierRepairNodes({ category: "structure", tree, nodes, bindings, compiler });
    const rename = repairs.find((node) => node.operations[0].action === "rename-binding");
    assert.ok(rename);
    assert.deepEqual(rename.operations[0].files, ["api.h"]);
    assert.deepEqual(rename.diagnostics, []);
    const inspect = repairs.find((node) => node.operations[0].action === "inspect");
    assert.ok(inspect);
    assert.deepEqual(inspect.diagnostics, compiler);
  }
});
