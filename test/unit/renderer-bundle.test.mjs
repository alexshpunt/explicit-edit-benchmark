import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pack,
  unpack,
  packingPlan,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

await test("packing moves source into the bundle and the inverse extracts it without snapshots", () => {
  const tree = {
    "main.cpp": '#include "part.h"\nint main() { return value(); }\n',
    "part.cpp":
      '// parallel_for stays in this comment\nconst char* name = "parallel_for";\nint parallel_for() { return 7; }\nint value() { return parallel_for(); }\n',
    "part.h": "// Keep this license.\n#pragma once\nint value();\n",
  };
  const operation = {
    kind: "append",
    source: "part.cpp",
    target: "main.cpp",
    renames: { parallel_for: "part_parallel_for" },
  };
  const { tree: packed, record } = pack(tree, operation);
  assert.equal(packed["part.cpp"], undefined);
  assert.match(packed["main.cpp"], /int part_parallel_for\(\)/);
  assert.match(packed["main.cpp"], /\/\/ parallel_for stays/);
  assert.match(packed["main.cpp"], /"parallel_for"/);
  assert.deepEqual(unpack(packed, record), tree);
  assert.equal(JSON.stringify(record).includes("return 7"), false);
  assert.deepEqual(pack(tree, operation), pack({ ...tree }, operation));
  assert.notEqual(treeIdentity(packed), treeIdentity(tree));
});

await test("a header is inserted once and all include sites are restored exactly", () => {
  const tree = {
    "main.cpp":
      '// #include "part.h"\n/*\n#include "part.h"\n*/\n#include "part.h"\n#include "part.h"\n',
    "part.h": "// license\n#ifndef PART_H\n#define PART_H\nint value();\n#endif\n",
  };
  const { tree: packed, record } = pack(tree, {
    kind: "include",
    source: "part.h",
    target: "main.cpp",
  });
  assert.equal(packed["main.cpp"].split("// license").length, 2);
  assert.deepEqual(unpack(packed, record), tree);
  assert.equal(record.edits.length, 2);
});

await test("files without a final newline round-trip without merging the next directive", () => {
  const tree = {
    "main.cpp": '#include "part.h"\nint main() {}\n',
    "part.h": "// keep\n#ifndef PART\n#define PART\n#endif",
  };
  const { tree: packed, record } = pack(tree, {
    kind: "include",
    source: "part.h",
    target: "main.cpp",
  });
  assert.match(packed["main.cpp"], /#endif\nint main/);
  assert.deepEqual(unpack(packed, record), tree);
});

await test("an incompatible state is rejected rather than replaced with saved source", () => {
  const { tree, record } = pack(
    { "main.cpp": "int main() {}\n", "part.cpp": "// retained\nint helper() { return 1; }\n" },
    { kind: "append", source: "part.cpp", target: "main.cpp" },
  );
  const changed = { ...tree, "main.cpp": `${tree["main.cpp"]}// agent edit\n` };
  const before = structuredClone(changed);
  assert.throws(() => unpack(changed, record), /identity/);
  assert.deepEqual(changed, before);
  assert.throws(() => pack(tree, record.operation), /source/);
});

await test("vendor declarations and macro-controlled implementation both survive in one file", () => {
  const tree = {
    "main.cpp": "#include <vendor/part.h>\nint main() { return value(); }\n",
    "support/part.cpp": '#define PART_IMPLEMENTATION\n#include "vendor/part.h"\n',
    "support/vendor/part.h":
      "#ifndef PART_H\n#define PART_H\nint value();\n#endif\n#ifdef PART_IMPLEMENTATION\nint value() { return 7; }\n#endif\n",
  };
  let current = tree;
  const records = [];
  for (const operation of packingPlan(tree)) {
    const result = pack(current, operation);
    current = result.tree;
    records.push(result.record);
  }
  assert.deepEqual(Object.keys(current), ["main.cpp"]);
  assert.equal(current["main.cpp"].split("int value() { return 7; }").length, 3);
  assert.doesNotMatch(current["main.cpp"], /#include/);
  for (const record of records.reverse())
    current = unpack(current, JSON.parse(JSON.stringify(record)));
  assert.deepEqual(current, tree);
});
await test("header packing waits until only the bundle includes the header", () => {
  const tree = {
    "main.cpp": '#include "outer.h"\n',
    "outer.h": '#ifndef OUTER\n#define OUTER\n#include "inner.h"\n#endif\n',
    "inner.h": "// keep\nint value();\n",
  };
  assert.throws(
    () => pack(tree, { kind: "include", source: "inner.h", target: "main.cpp" }),
    /included by/,
  );
  const plan = packingPlan(tree);
  assert.deepEqual(
    plan.map((step) => step.source),
    ["outer.h", "inner.h"],
  );
  let current = tree;
  const records = [];
  for (const operation of plan) {
    const result = pack(current, operation);
    current = result.tree;
    records.push(result.record);
  }
  for (const record of records.reverse()) current = unpack(current, record);
  assert.deepEqual(current, tree);
});
