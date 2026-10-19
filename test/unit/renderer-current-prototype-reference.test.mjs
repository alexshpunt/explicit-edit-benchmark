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
          owner: { scope: "api::refine", signature: "int (int, int)", definition: false },
        },
      ],
    },
  ],
});

async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/prototype-reference-"));
  const planner = currentNamingPlanner(root);
  t.after(async () => {
    planner.close();
    await rm(root, { recursive: true, force: true });
  });
  return planner;
}

const input = {
  "api.h": "#pragma once\nnamespace api { int refine(int first, int second); }\n",
  "main.cpp": '#include "api.h"\nint waiting_for_move() { return moved_helper(); }\n',
  "part.cpp": "int moved_helper() { return 1; }\n",
};

await test("a current header prototype parameter can be renamed during unrelated implementation movement", async (t) => {
  const planner = await fixture(t);
  const before = structuredClone(input);
  const first = await planner.plan(before, request("first", "left"));
  assert.deepEqual(first.after, { ...input, "api.h": input["api.h"].replace("first", "left") });
  assert.deepEqual(before, input);
  planner.acknowledge(before, first.after);
  const second = await planner.plan(first.after, request("second", "right"));
  assert.deepEqual(second.after, {
    ...input,
    "api.h": input["api.h"].replace("first", "left").replace("second", "right"),
  });
  planner.acknowledge(first.after, second.after);
});

await test("prototype reference analysis does not ignore errors in the selected current header", async (t) => {
  const planner = await fixture(t);
  const before = { ...input, "api.h": input["api.h"] + "MissingType broken;\n" };
  await assert.rejects(planner.plan(before, request("first", "left")), /Compiler AST failed:/);
  assert.equal(before["api.h"], input["api.h"] + "MissingType broken;\n");
});

await test("a prototype outside headers still uses the actual implementation view", async (t) => {
  const planner = await fixture(t);
  const before = {
    "other.h": "#pragma once\nstruct Item {};\n",
    "main.cpp": "namespace api { int refine(int first, int second); }\n",
  };
  const result = await planner.plan(before, request("first", "left"));
  assert.deepEqual(result.after, {
    ...before,
    "main.cpp": before["main.cpp"].replace("first", "left"),
  });
});

await test("parameters defined outside headers still require valid implementation analysis", async (t) => {
  const planner = await fixture(t);
  const task = request("first", "left");
  task.operations[0].selectors[0].owner.definition = true;
  const before = {
    ...input,
    "main.cpp":
      input["main.cpp"] +
      "namespace api { int refine(int first, int second) { return first + second; } }\n",
  };
  await assert.rejects(planner.plan(before, task), /Compiler AST failed:/);
});

await test("header-defined template locals also remain editable during implementation movement", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "api.h":
      "#pragma once\nnamespace api { template<typename T> int refine(int first, int second) { auto local = first + second; return local; } }\n",
  };
  const task = request("local", "result");
  task.operations[0].selectors[0].owner.definition = true;
  const result = await planner.plan(before, task);
  assert.deepEqual(result.after, {
    ...before,
    "api.h": before["api.h"].replaceAll("local", "result"),
  });
});

await test("a local binding outside headers retains the legal separate-translation-unit fallback", async (t) => {
  const planner = await fixture(t);
  const before = {
    "api.h": input["api.h"],
    "a.cpp":
      '#include "api.h"\nstatic int helper(int x) { return x; }\nnamespace api { int refine(int first, int second) { return helper(first) + second; } }\n',
    "b.cpp":
      '#include "api.h"\nstatic int helper(int x) { return x + 1; }\nint other() { return helper(1); }\n',
  };
  const task = request("first", "left");
  task.operations[0].selectors[0].owner.definition = true;
  const result = await planner.plan(before, task);
  assert.deepEqual(result.after, {
    ...before,
    "a.cpp": before["a.cpp"].replaceAll("first", "left"),
  });
  assert.equal(result.statistics.fallbacks, 1);
  planner.acknowledge(before, result.after);
});

await test("unrelated implementation writes do not discard an unchanged current-header compiler view", async (t) => {
  const planner = await fixture(t);
  const first = await planner.plan(input, request("first", "left"));
  planner.acknowledge(input, first.after);
  const moved = {
    ...first.after,
    "main.cpp": input["main.cpp"] + "int another_unfinished_move() { return later_helper(); }\n",
  };
  const second = await planner.plan(moved, request("second", "right"));
  assert.equal(second.statistics.snapshotAttempts, 1);
  assert.equal(second.statistics.cacheHits, 1);
  assert.equal(second.after["main.cpp"], moved["main.cpp"]);
  planner.acknowledge(moved, second.after);
  const changed = {
    ...second.after,
    "api.h": second.after["api.h"].replace("int left", "long left"),
  };
  const task = request("right", "last");
  task.operations[0].selectors[0].owner.signature = "int (long, int)";
  const last = await planner.plan(changed, task);
  assert.equal(last.statistics.snapshotAttempts, 2);
  assert.ok(last.after["api.h"].includes("int last"));
});

await test("a header view cannot hide implementation input behind a project include", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "api.h": '#include "dependency.cpp"\n' + input["api.h"],
    "dependency.cpp": "using Dependency = int;\n",
  };
  await assert.rejects(planner.plan(before, request("first", "left")), /Compiler AST failed:/);
});
