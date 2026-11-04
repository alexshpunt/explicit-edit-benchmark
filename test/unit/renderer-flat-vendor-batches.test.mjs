import assert from "node:assert/strict";
import test from "node:test";

import { flatVendorContract } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-vendor-contract.mjs";
import { prepareFlatVendorBatches } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-vendor-batches.mjs";
import { prepareFlatBatchProse } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-batch-prose.mjs";

function makeTask(role, pieces) {
  const preamble = role === "header" ? "#pragma once\n" : '#include "vendor.h"\n';
  let offset = 0;
  const fragments = pieces.map((text, index) => {
    const start = offset;
    offset += text.length;
    return { id: `fragment-${index}`, start, end: offset, text };
  });
  return {
    id: role,
    file: role === "header" ? "vendor.h" : "vendor.cpp",
    kind: role === "header" ? "vendor-header" : "implementation",
    preamble,
    using: [],
    replacement: role === "header" ? '#include "vendor.h"\n' : "",
    fragments,
    destination: preamble + pieces.join(""),
  };
}

test("header batches expose only selected declarations and directives with scaffold and replacement first", async () => {
  const task = makeTask("header", [
    "#define CHUNK_FACTOR(x) ((x) + 87231)\n",
    "typedef struct { int value; } ChunkThing;\n",
    "int chunk_sample(ChunkThing x);\n",
  ]);
  const contract = await flatVendorContract(task.destination, "header");
  const prepared = await prepareFlatVendorBatches(task, contract);
  const first = prepared.render([task.fragments[0]]);
  const later = prepared.render([task.fragments[1], task.fragments[2]]);
  assert.deepEqual(
    first.directives.map((item) => item.name),
    ["CHUNK_FACTOR(x)"],
  );
  assert.equal(first.entities.length, 0);
  assert.deepEqual(
    later.entities.map((item) => item.signature),
    ["ChunkThing", "int chunk_sample(ChunkThing x)"],
  );
  assert.equal(later.directives.length, 0);
  assert.ok(first.prompt.includes("CHUNK_FACTOR(x)"));
  assert.ok(!first.prompt.includes("ChunkThing"));
  assert.ok(!first.prompt.includes("87231"));
  assert.ok(later.prompt.includes("ChunkThing"));
  assert.equal(first.first, true);
  assert.equal(later.first, false);
  assert.ok(first.prompt.includes('#include "vendor.h"'));
});

test("implementation batches associate nested directives with their containing function", async () => {
  const task = makeTask("implementation", [
    "#define OUTER(x) ((x) + 93284)\n",
    "int nested(int x) {\n#define LOCAL 123456\n  return OUTER(x) + LOCAL;\n#undef LOCAL\n}\n",
    "int unrelated(int x) { return x; }\n",
  ]);
  const contract = await flatVendorContract(task.destination, "implementation");
  const prepared = await prepareFlatVendorBatches(task, contract);
  const batch = prepared.render([task.fragments[1]]);
  assert.deepEqual(
    batch.entities.map((entity) => entity.signature),
    ["int nested(int x)"],
  );
  assert.deepEqual(
    batch.directives.map((item) => item.name),
    ["LOCAL", "LOCAL"],
  );
  assert.ok(batch.directives.every((item) => item.inside.signature === "int nested(int x)"));
  assert.ok(batch.prompt.includes("LOCAL"));
  assert.ok(!batch.prompt.includes("unrelated"));
  assert.ok(!batch.prompt.includes("123456"));
});

test("scaffolded vendor units use fixed source and destination markers instead of preceding units", async () => {
  const task = makeTask("implementation", [
    "#define OUTER(x) (x)\n",
    "int nested(int x) { return OUTER(x); }\n",
  ]);
  const contract = await flatVendorContract(task.destination, "implementation");
  const prepared = await prepareFlatVendorBatches(task, contract);
  const id = task.fragments[1].id;
  const batch = prepared.render([task.fragments[1]], {
    markers: new Map([[id, "// TO_1"]]),
    sourceMarkers: new Map([[id, "/* FROM_1 */"]]),
  });
  assert.ok(batch.prompt.includes("// TO_1"));
  assert.ok(batch.prompt.includes("/* FROM_1 */"));
  assert.ok(!batch.prompt.includes("Insert these units after"));
  assert.throws(() => prepared.render([task.fragments[1]], { markers: new Map() }));
});
test("vendor delivery rejects a missing or duplicated live unit", async () => {
  const task = makeTask("header", ["#define UNIQUE_VENDOR 7\n", "int vendor_item();\n"]);
  const source = task.fragments.map(({ text }) => text).join("");
  const contract = await flatVendorContract(task.destination, "header");
  const prepared = await prepareFlatBatchProse(
    { initial: { "main.cpp": source }, tasks: [task] },
    new Map([[task.id, { flatVendor: contract }]]),
  );
  const options = { currentSource: source };
  const batch = prepared.render(task, [task.fragments[0]], options);
  assert.doesNotThrow(() => prepared.validate(source, batch));
  assert.throws(() =>
    prepared.render(task, [task.fragments[0]], {
      currentSource: source.replace(task.fragments[0].text, ""),
    }),
  );
  assert.throws(() =>
    prepared.render(task, [task.fragments[0]], { currentSource: source + task.fragments[0].text }),
  );
});
test("unknown, reversed, and contract-incomplete fragment sets are refused", async () => {
  const task = makeTask("header", ["#define N 1\n", "int thing();\n"]);
  const contract = await flatVendorContract(task.destination, "header");
  const prepared = await prepareFlatVendorBatches(task, contract);
  assert.throws(() => prepared.render([task.fragments[1], task.fragments[0]]));
  assert.throws(() => prepared.render([{ ...task.fragments[0], id: "unknown" }]));
  await assert.rejects(
    prepareFlatVendorBatches({ ...task, fragments: [task.fragments[0]] }, contract),
  );
  await assert.rejects(prepareFlatVendorBatches(task, { ...contract, directives: [] }));
});
