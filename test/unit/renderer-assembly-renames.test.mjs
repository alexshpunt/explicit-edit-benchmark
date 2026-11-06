import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupAssemblyMarkers,
  prepareAssemblyPlan,
  scriptedAssemblyWriter,
} from "../../src/suites/explicit-edit-multi-agent/extraction/assembly-case.mjs";
import { assemblyCorrections } from "../../src/suites/explicit-edit-multi-agent/extraction/assembly-corrections.mjs";
import {
  prepareAssemblyRenames,
  renameIdentifiers,
  renameLeftovers,
  uniqueSpellings,
} from "../../src/suites/explicit-edit-multi-agent/extraction/assembly-renames.mjs";
import {
  compareLineDifferences,
  prepareLineDifferences,
} from "../../src/suites/explicit-edit-multi-agent/grading/line-differences.mjs";

const program = [
  "struct Point { float x; float y; };",
  "struct Size { float x; };",
  "// Point and length are mentioned here.",
  "float length(const Point& p) { return p.x + p.y; }",
  "float area(const Size& s) { return s.x; }",
  'const char* label = "Point";',
  "int main() { Point p{1, 2}; Size s{3}; return int(length(p) + area(s)); }",
  "",
].join("\n");

test("renames whole identifiers in code and keeps comments and literals", () => {
  const names = new Map([["Point", "Spot"]]);
  assert.equal(
    renameIdentifiers('Point PointSet; // Point\nconst char* a = "Point"; Point();', names),
    'Spot PointSet; // Point\nconst char* a = "Point"; Spot();',
  );
});

test("a spelling is unique only when the compiler renames every code occurrence", async () => {
  const { unique } = await uniqueSpellings(program);
  assert.deepEqual(
    unique.map(({ name, kind, uses }) => [name, kind, uses]),
    [
      ["Point", "type", 3],
      ["Size", "type", 3],
      ["area", "function", 2],
      ["length", "function", 2],
      ["y", "field", 2],
    ],
  );
});

const source = [
  "#include <vector>",
  "",
  "int first(int a);",
  "struct Shape { int x; };",
  "int residual() { return first(0); }",
  "int second(int b) { return b; }",
  "",
].join("\n");

function fixture() {
  const fragment = (id, text) => {
    const start = source.indexOf(text);
    return { id, start, end: start + text.length, text };
  };
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
        destination: headerPreamble + "int first(int a);\nstruct Shape { int x; };\n",
        fragments: [
          fragment("a-1", "int first(int a);"),
          fragment("a-2", "struct Shape { int x; };"),
        ],
      },
    ],
  };
}

test("the scripted route through assembly, renames and extraction reaches the renamed reference", async () => {
  const setup = await prepareAssemblyPlan(fixture());
  const renamed = await prepareAssemblyRenames(setup, 100);
  assert.deepEqual(
    renamed.renames.selected.map(({ name, kind, uses }) => [name, kind, uses]),
    [
      ["first", "function", 2],
      ["Shape", "type", 1],
      ["residual", "function", 1],
      ["second", "function", 1],
      ["x", "field", 1],
    ],
  );
  const [first] = renamed.renameDeliveries;
  assert.match(
    first.prompt,
    new RegExp(`Rename the function \`first\` to \`${first.rename.newName}\` in main\\.cpp\\.`),
  );
  assert.match(first.prompt, /Do not change comments, string literals or character literals/);
  assert.ok(!/[{}]/.test(first.prompt), "No structured data reaches agents");

  const writer = scriptedAssemblyWriter(setup);
  let main = setup.trees.scaffold["main.cpp"];
  for (const delivery of setup.deliveries) main = writer.assemble(main, delivery.items);
  for (const delivery of renamed.renameDeliveries) main = writer.rename(main, delivery);
  let tree = { "main.cpp": main };
  for (const extraction of setup.extractions) tree = writer.extract(tree, extraction);
  tree = cleanupAssemblyMarkers(tree, setup.markers).tree;
  assert.deepEqual(tree, renamed.trees.final);
  assert.notDeepEqual(renamed.trees.final, setup.trees.final);

  // The renamed view describes the renamed reference, so it needs no correction.
  const prepared = prepareLineDifferences(setup.trees.markerFree, renamed.trees.final);
  const exact = compareLineDifferences(prepared, renamed.trees.final);
  assert.deepEqual(assemblyCorrections(renamed.reference, prepared, exact, renamed.trees.final), []);
});

test("old names left in code become one rename instruction per name and file", async () => {
  const setup = await prepareAssemblyPlan(fixture());
  const renamed = await prepareAssemblyRenames(setup, 100);
  const shape = renamed.renames.selected.find(({ name }) => name === "Shape");
  const candidate = {
    ...renamed.trees.final,
    "a.h": renamed.trees.final["a.h"].replace(shape.newName, "Shape"),
  };
  const { tree, leftovers } = renameLeftovers(candidate, renamed.renames.selected);
  assert.deepEqual(tree, renamed.trees.final);
  assert.deepEqual([...leftovers], [["a.h", [{ name: "Shape", newName: shape.newName, count: 1 }]]]);
  const prepared = prepareLineDifferences(setup.trees.markerFree, renamed.trees.final);
  const assignments = assemblyCorrections(
    renamed.reference,
    prepared,
    compareLineDifferences(prepared, tree),
    tree,
    { leftovers },
  );
  assert.equal(assignments.length, 1);
  assert.match(
    assignments[0].prompt,
    new RegExp(
      `1\\. The identifier \`Shape\` was renamed to \`${shape.newName}\`, but 1 occurrence of \`Shape\` remains in the code of a\\.h\\. Replace it with`,
    ),
  );
});
