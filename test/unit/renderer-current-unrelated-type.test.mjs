import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const type = (from, to, scope = from) => ({
  id: from,
  operations: [
    {
      id: from,
      phase: "names",
      category: "functions-types",
      mapping: [{ from, to }],
      selectors: [{ kind: "type", scope }],
    },
  ],
});
const fn = (from, to, signature, scope = from) => ({
  id: from,
  operations: [
    {
      id: from,
      phase: "names",
      category: "functions-types",
      mapping: [{ from, to }],
      selectors: [{ kind: "function", scope, owner: { scope, signature, definition: true } }],
    },
  ],
});
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/current-unrelated-type-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}

await test("an unrelated nested type rename does not reopen independent function bindings", async (t) => {
  const planner = await fixture(t);
  const before = {
    "main.cpp":
      "struct Map { struct Entry {}; }; int first(int x) { return x; } int second(int x) { return first(x); }\n",
  };
  const renamedType = await planner.plan(before, type("Entry", "Value", "Map::Entry"));
  planner.acknowledge(before, renamedType.after);
  const first = await planner.plan(renamedType.after, fn("first", "read", "int (int)"));
  assert.equal(
    first.after["main.cpp"],
    "struct Map { struct Value {}; }; int read(int x) { return x; } int second(int x) { return read(x); }\n",
  );
  assert.equal(first.statistics.snapshotAttempts, 1);
  assert.equal(first.statistics.cacheHits, 1);
  planner.acknowledge(renamedType.after, first.after);
  const second = await planner.plan(first.after, fn("second", "consume", "int (int)"));
  assert.equal(second.statistics.snapshotAttempts, 1);
  assert.ok(second.after["main.cpp"].includes("int consume(int x) { return read(x); }"));
});

await test("a function selector cannot reuse a signature containing an old or current renamed type", async (t) => {
  const planner = await fixture(t);
  const before = { "main.cpp": "struct First {}; First take(First value) { return value; }\n" };
  const renamed = await planner.plan(before, type("First", "Box"));
  planner.acknowledge(before, renamed.after);
  await assert.rejects(
    planner.plan(renamed.after, fn("take", "wrong", "First (First)")),
    /Missing current owner\/signature binding/,
  );
  const current = await planner.plan(renamed.after, fn("take", "consume", "Box (Box)"));
  assert.equal(current.statistics.cacheHits, 0);
  assert.ok(current.after["main.cpp"].includes("Box consume(Box value)"));
});

await test("type-renamed method owners and unexplained source changes still require a fresh compiler view", async (t) => {
  const planner = await fixture(t);
  const before = {
    "main.cpp": "struct First { int get(int x) { return x; } }; int other(int x) { return x; }\n",
  };
  const renamed = await planner.plan(before, type("First", "Box"));
  planner.acknowledge(before, renamed.after);
  const method = await planner.plan(renamed.after, fn("get", "read", "int (int)", "Box::get"));
  assert.equal(method.statistics.snapshotAttempts, 2);
  assert.ok(method.after["main.cpp"].includes("int read(int x)"));
  planner.acknowledge(renamed.after, method.after);
  const changed = {
    "main.cpp": method.after["main.cpp"].replace("return x; }\n", "return x + 1; }\n"),
  };
  const other = await planner.plan(changed, fn("other", "consume", "int (int)"));
  assert.equal(other.statistics.snapshotAttempts, 3);
  assert.ok(other.after["main.cpp"].includes("int consume(int x) { return x + 1; }"));
});
