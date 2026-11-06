import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupAssemblyMarkers,
  prepareAssemblyPlan,
  scriptedAssemblyWriter,
} from "../../src/suites/explicit-edit-multi-agent/extraction/assembly-case.mjs";

const source = [
  "#include <vector>",
  "",
  "int helper_value = 1;",
  "int limit = 2;",
  "int first(int a);",
  "struct Shape { int x; };",
  "int residual() { return 0; }",
  "int first(int a);",
  "int second(int b) { return b; }",
  "",
].join("\n");

function fixture() {
  const fragment = (id, text, from = 0) => {
    const start = source.indexOf(text, from);
    assert.ok(start >= 0);
    return { id, start, end: start + text.length, text };
  };
  const secondDeclaration = source.indexOf("int first(int a);") + 1;
  const headerPreamble = "#pragma once\n\n#include <vector>\n\n";
  const implementationPreamble = '#include "a.h"\n\n';
  return {
    initial: { "main.cpp": source },
    tasks: [
      {
        id: "b",
        file: "b.cpp",
        kind: "implementation",
        preamble: implementationPreamble,
        replacement: "",
        using: [],
        destination: implementationPreamble + "int second(int b) { return b; }\n",
        fragments: [fragment("b-1", "int second(int b) { return b; }")],
      },
      {
        id: "a",
        file: "a.h",
        kind: "header",
        preamble: headerPreamble,
        replacement: '#include "a.h"\n',
        using: [],
        destination:
          headerPreamble +
          "int helper_value = 1;\nint limit = 2;\nint first(int a);\nstruct Shape { int x; };\nint first(int a);\n",
        fragments: [
          fragment("a-1", "int helper_value = 1;"),
          fragment("a-2", "int limit = 2;"),
          fragment("a-3", "int first(int a);"),
          fragment("a-4", "struct Shape { int x; };"),
          fragment("a-5", "int first(int a);", secondDeclaration),
        ],
      },
    ],
  };
}

test("orders regions by unity build and joins adjacent unnamed units into one block", async () => {
  const setup = await prepareAssemblyPlan(fixture());
  assert.deepEqual(
    setup.regions.map((region) => region.file),
    ["a.h", "b.cpp"],
  );
  assert.deepEqual(setup.regions[1].headerLines, ['#include "a.h"']);
  const kinds = setup.items.map((item) => [item.kind, item.fragments.length]);
  assert.deepEqual(kinds, [
    ["named", 1],
    ["block", 2],
    ["named", 1],
    ["named", 1],
    ["named", 1],
  ]);
  const scaffold = setup.trees.scaffold["main.cpp"];
  assert.ok(scaffold.startsWith("#include <vector>\n\n#pragma region a.h\n"));
  assert.ok(scaffold.includes("#pragma endregion\n\n#pragma region b.cpp\n"));
  assert.ok(!scaffold.includes('#include "a.h"'), "Project includes stay out of regions");
  assert.ok(!scaffold.includes("#pragma once"));
});

test("names units without their source text and gives blocks text and original neighbours", async () => {
  const setup = await prepareAssemblyPlan(fixture());
  const prompts = setup.deliveries.map((delivery) => delivery.prompt).join("\n");
  assert.ok(prompts.includes("the struct `Shape` in the global namespace"));
  assert.ok(!prompts.includes("int x;"), "Named unit bodies are not shown");
  assert.ok(prompts.includes("main.cpp contains 2 copies of it"));
  const block = setup.deliveries.find((delivery) =>
    delivery.items.some((item) => item.kind === "block"),
  ).prompt;
  assert.ok(
    block.includes(
      "in the original main.cpp, precedes the function declaration `int first(int a)` in the global namespace",
    ),
  );
  assert.ok(block.includes("Its first line is `int helper_value = 1;`"));
  assert.ok(block.includes("```cpp\nint helper_value = 1;\nint limit = 2;\n```"));
  assert.ok(!prompts.includes("{"), "No structured data reaches agents");
});

test("interleaves the first delivery of every region before any second delivery", async () => {
  const setup = await prepareAssemblyPlan(fixture());
  const files = setup.deliveries.map((delivery) => delivery.file);
  assert.equal(files[0], "a.h");
  assert.equal(files[1], "b.cpp");
  assert.deepEqual(
    setup.deliveries.map((delivery) => delivery.queueIndex),
    files.map((_, index) => index),
  );
  assert.equal(
    setup.deliveries.reduce((sum, delivery) => sum + delivery.items.length, 0),
    setup.items.length,
  );
});

test("the scripted writer reaches the assembled and final references in any delivery order", async () => {
  const setup = await prepareAssemblyPlan(fixture());
  const writer = scriptedAssemblyWriter(setup);
  let main = setup.trees.scaffold["main.cpp"];
  for (const delivery of [...setup.deliveries].reverse())
    main = writer.assemble(main, delivery.items);
  assert.equal(main, setup.trees.assembled["main.cpp"]);
  let tree = { "main.cpp": main };
  for (const entry of [...setup.extractions].reverse()) tree = writer.extract(tree, entry);
  assert.deepEqual(tree, setup.trees.final);
  assert.ok(setup.trees.final["a.h"].startsWith("#pragma once\n\n#include <vector>\n"));
  assert.ok(setup.trees.final["b.cpp"].startsWith('#include "a.h"\n'));
  assert.ok(setup.trees.final["main.cpp"].startsWith('#include <vector>\n\n#include "a.h"\n'));
  assert.ok(setup.trees.final["main.cpp"].includes("int residual() { return 0; }"));
  assert.ok(!setup.trees.final["main.cpp"].includes("int second"));
});

test("extraction prose names header lines and the main.cpp replacement", async () => {
  const setup = await prepareAssemblyPlan(fixture());
  const [header, implementation] = setup.extractions.map((entry) => entry.prompt);
  assert.ok(header.includes("```cpp\n#pragma once\n```"));
  assert.ok(header.includes('with the line `#include "a.h"`.'));
  assert.ok(implementation.includes('```cpp\n#include "a.h"\n```'));
  assert.ok(implementation.includes("In main.cpp, remove the whole region"));
});

test("marker cleanup removes only complete issued marker lines and counts them", async () => {
  const setup = await prepareAssemblyPlan(fixture());
  const marker = [...setup.markers][0].trim();
  const { tree, remaining } = cleanupAssemblyMarkers(
    {
      "main.cpp": `  ${marker}\nint x;\n${marker} trailing\n// __EXPLICIT_EDIT_SLOT_9_9__\n`,
      "a.h": Buffer.from([0xff]),
    },
    setup.markers,
  );
  assert.equal(remaining, 1);
  assert.equal(
    tree["main.cpp"],
    `int x;\n${marker} trailing\n// __EXPLICIT_EDIT_SLOT_9_9__\n`,
  );
  assert.ok(Buffer.isBuffer(tree["a.h"]));
});

test("rejects an unnamed block that its text and neighbours do not identify", async () => {
  const text = "int a1();\nint v = 1;\nint b1();\nint a1();\nint v = 1;\nint b1();\n";
  const fragments = [];
  for (let start = 0, index = 0; start < text.length; index++) {
    const end = text.indexOf("\n", start);
    fragments.push({ id: `c-${index}`, start, end, text: text.slice(start, end) });
    start = end + 1;
  }
  const plan = {
    initial: { "main.cpp": text },
    tasks: [
      {
        id: "c",
        file: "c.h",
        kind: "header",
        preamble: "#pragma once\n\n",
        replacement: '#include "c.h"\n',
        using: [],
        destination: "#pragma once\n\n" + text,
        fragments,
      },
    ],
  };
  await assert.rejects(prepareAssemblyPlan(plan), /not identified by its text and neighbours/);
});
