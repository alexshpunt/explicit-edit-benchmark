import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const request = (from, to) => ({
  id: from,
  operations: [
    {
      id: from,
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from, to }],
      selectors: [
        {
          kind: "variable",
          scope: `api::refine::${from}`,
          owner: { scope: "api::refine", signature: "int (int, int)", definition: true },
        },
      ],
    },
  ],
});
const input = {
  "api.h": "#pragma once\nnamespace api { int refine(int, int); }\n",
  "unused.h": "#define JOIN(a, b) a ## b\n",
  "part.cpp":
    '#include "api.h"\nnamespace api { int refine(int first, int second) { return first + second; } }\n',
  "main.cpp": '#include "api.h"\nint waiting_for_move() { return moved_helper(); }\n',
};
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/current-local-tu-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}

await test("a confined definition binding uses its actual translation unit during unrelated movement", async (t) => {
  const planner = await fixture(t);
  const before = structuredClone(input);
  const first = await planner.plan(before, request("first", "left"));
  assert.deepEqual(first.after, {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("first", "left"),
  });
  assert.deepEqual(before, input);
  planner.acknowledge(before, first.after);
  const second = await planner.plan(first.after, request("second", "right"));
  assert.deepEqual(second.after, {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("first", "left").replaceAll("second", "right"),
  });
  assert.equal(second.statistics.snapshotAttempts, 1);
  assert.equal(second.statistics.cacheHits, 1);
  planner.acknowledge(first.after, second.after);
});

await test("local translation-unit selection retains compiler errors in the owner and its includes", async (t) => {
  const planner = await fixture(t);
  for (const file of ["part.cpp", "api.h"]) {
    const before = { ...input, [file]: input[file] + "MissingType broken;\n" };
    await assert.rejects(planner.plan(before, request("first", "left")), /Compiler AST failed:/);
    assert.equal(before[file], input[file] + "MissingType broken;\n");
  }
});

await test("unrelated physical spellings remain untouched by a compiler-owned local rename", async (t) => {
  const planner = await fixture(t);
  for (const extra of ["int first = 1;\n", "int fi\\\nrst = 1;\n"]) {
    const before = { ...input, "peer.cpp": extra };
    const result = await planner.plan(before, request("first", "left"));
    assert.deepEqual(result.after, {
      ...before,
      "part.cpp": input["part.cpp"].replaceAll("first", "left"),
    });
    assert.equal(before["peer.cpp"], extra);
  }
});

await test("token pasting in the selected implementation or its includes prevents a local view", async (t) => {
  const planner = await fixture(t);
  for (const file of ["part.cpp", "api.h"]) {
    const before = { ...input, [file]: input[file] + "#define JOIN(a, b) a ## b\n" };
    await assert.rejects(planner.plan(before, request("first", "left")), /Compiler AST failed:/);
  }
});
await test("a local implementation included by another translation unit cannot hide that context", async (t) => {
  const planner = await fixture(t);
  for (const include of ['#include "part.cpp"\n', '#include \\\n"part.cpp"\n']) {
    const before = { ...input, "main.cpp": include + input["main.cpp"] };
    await assert.rejects(planner.plan(before, request("first", "left")), /Compiler AST failed:/);
  }
});

await test("a block-scope extern cannot hide implementation uses behind a confined declaration spelling", async (t) => {
  const planner = await fixture(t);
  const before = {
    "part.cpp":
      "int some_value = 1; namespace api { int refine(int, int) { extern int some_value; return some_value; } }\n",
    "main.cpp":
      "#define GLOBAL(x) some_ ## x\nnamespace api { extern int GLOBAL(value); } int use() { return api::GLOBAL(value); }\n",
  };
  const task = request("some_value", "restored");
  task.operations[0].selectors[0].scope = "api::some_value";
  await assert.rejects(planner.plan(before, task), /Unsupported local reference/);
});
await test("current local ownership and unexplained input changes still require fresh analysis", async (t) => {
  const planner = await fixture(t);
  const wrong = request("first", "left");
  wrong.operations[0].selectors[0].owner.signature = "long (int, int)";
  // Isolate owner selection from the deliberately broken unrelated translation unit.
  const valid = { ...input, "main.cpp": input["main.cpp"].replace("moved_helper()", "0") };
  await assert.rejects(planner.plan(valid, wrong), /Missing current owner\/signature binding/);
  const first = await planner.plan(input, request("first", "left"));
  planner.acknowledge(input, first.after);
  const changed = {
    ...first.after,
    "part.cpp": first.after["part.cpp"].replace("return left", "return 1 + left"),
  };
  const second = await planner.plan(changed, request("second", "right"));
  assert.ok(second.after["part.cpp"].includes("return 1 + left + right"));
  assert.equal(second.statistics.cacheHits, 0);
  assert.ok(second.statistics.snapshotAttempts > first.statistics.snapshotAttempts);
});

await test("a valid full-project snapshot is retained instead of reopening a narrower local view", async (t) => {
  const planner = await fixture(t);
  const before = {
    "part.cpp": "namespace api { int refine(int shared, int first) { return shared + first; } }\n",
    "peer.cpp": "int unrelated(int shared) { return shared + 1; }\n",
  };
  const fullRequest = request("shared", "value");
  fullRequest.operations[0].selectors = [
    {
      kind: "function",
      scope: "api::refine",
      signature: "int (int, int)",
      definition: true,
    },
  ];
  const shared = await planner.plan(before, fullRequest);
  planner.acknowledge(before, shared.after);
  const first = await planner.plan(shared.after, request("first", "left"));
  assert.deepEqual(first.after, {
    ...before,
    "part.cpp": "namespace api { int refine(int value, int left) { return value + left; } }\n",
  });
  assert.equal(first.statistics.snapshotAttempts, shared.statistics.snapshotAttempts);
  assert.equal(first.statistics.cacheHits, shared.statistics.cacheHits + 1);
  planner.acknowledge(shared.after, first.after);
});

await test("unexplained peer writes cannot retain the previous full-project view", async (t) => {
  const planner = await fixture(t);
  const before = {
    "part.cpp": "namespace api { int refine(int shared, int first) { return shared + first; } }\n",
    "peer.cpp": "int unrelated(int shared) { return shared + 1; }\n",
  };
  const fullRequest = request("shared", "value");
  fullRequest.operations[0].selectors = [
    {
      kind: "function",
      scope: "api::refine",
      signature: "int (int, int)",
      definition: true,
    },
  ];
  const shared = await planner.plan(before, fullRequest);
  planner.acknowledge(before, shared.after);
  const current = {
    ...shared.after,
    "peer.cpp": before["peer.cpp"] + "int waiting() { return missing_helper(); }\n",
  };
  const first = await planner.plan(current, request("first", "left"));
  assert.deepEqual(first.after, {
    ...current,
    "part.cpp": "namespace api { int refine(int value, int left) { return value + left; } }\n",
  });
  assert.equal(first.statistics.snapshotAttempts, shared.statistics.snapshotAttempts + 1);
  assert.equal(first.statistics.cacheHits, shared.statistics.cacheHits);
  planner.acknowledge(current, first.after);
});
