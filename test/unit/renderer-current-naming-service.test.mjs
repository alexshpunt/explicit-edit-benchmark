import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const input = { "main.cpp": "int sum(int a, int b) { return a + b; }\n" };
const rename = (id, from, to, scope = "sum", signature = "int (int, int)") => ({
  id,
  operations: [
    {
      id,
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from, to }],
      selectors: [{ kind: "function", scope, signature, definition: true }],
    },
  ],
});
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/current-naming-"));
  const planner = currentNamingPlanner(root);
  t.after(async () => {
    planner.close();
    await rm(root, { recursive: true, force: true });
  });
  return planner;
}

await test("independent delivered bindings share one compiler snapshot and rebase committed peer offsets", async (t) => {
  const planner = await fixture(t);
  const a = await planner.plan(input, rename("a", "a", "longer_left"));
  planner.acknowledge(input, a.after);
  const b = await planner.plan(a.after, rename("b", "b", "right"));
  assert.equal(
    b.after["main.cpp"],
    "int sum(int longer_left, int right) { return longer_left + right; }\n",
  );
  assert.equal(b.statistics.snapshotAttempts, 1);
  assert.equal(b.statistics.cacheHits, 1);
  planner.acknowledge(a.after, b.after);
});
await test("a rejected CAS reuses its consumed current request but does not acknowledge it", async (t) => {
  const planner = await fixture(t);
  const task = rename("a", "a", "left");
  const first = await planner.plan(input, task);
  const retry = await planner.plan(input, task);
  assert.deepEqual(retry.after, first.after);
  assert.equal(retry.statistics.snapshotAttempts, 1);
  assert.equal(retry.statistics.pendingHits, 1);
  assert.throws(() => planner.acknowledge(input, input), /pending/);
  planner.acknowledge(input, retry.after);
});
await test("unknown peer mutations and structural relocation invalidate the frozen compiler view", async (t) => {
  const planner = await fixture(t);
  const a = await planner.plan(input, rename("a", "a", "left"));
  planner.acknowledge(input, a.after);
  const changed = {
    "main.cpp": a.after["main.cpp"].replace("a + b", "a - b").replace("left + b", "left - b"),
  };
  const b = await planner.plan(changed, rename("b", "b", "right"));
  assert.equal(b.statistics.snapshotAttempts, 2);
  assert.ok(b.after["main.cpp"].includes("left - right"));
  planner.acknowledge(changed, b.after);
  const moved = { "part.cpp": b.after["main.cpp"], "main.cpp": "int main() { return 0; }\n" };
  const c = await planner.plan(moved, rename("c", "right", "last"));
  assert.equal(c.statistics.snapshotAttempts, 3);
  assert.ok(c.after["part.cpp"].includes("left - last"));
});
await test("a CAS conflict with unexplained peer bytes drops the consumed pending plan", async (t) => {
  const planner = await fixture(t);
  const task = rename("a", "a", "left");
  await planner.plan(input, task);
  const peer = { "main.cpp": "// peer moved every offset\n" + input["main.cpp"] };
  const retry = await planner.plan(peer, task);
  assert.equal(retry.statistics.snapshotAttempts, 2);
  assert.equal(retry.statistics.pendingHits, 0);
  assert.ok(retry.after["main.cpp"].startsWith("// peer moved every offset\n"));
  assert.ok(retry.after["main.cpp"].includes("return left + b"));
  planner.acknowledge(peer, retry.after);
});
await test("a legal separate-TU project falls back without caching an invalid combined view", async (t) => {
  const planner = await fixture(t);
  const before = {
    "api.h": "#pragma once\nint FnRun(int); int other(int);\n",
    "a.cpp":
      '#include "api.h"\nstatic int helper(int x) { return x; } int FnRun(int x) { return helper(x); }\n',
    "b.cpp":
      '#include "api.h"\nstatic int helper(int x) { return x + 1; } int other(int x) { return FnRun(helper(x)); }\n',
  };
  const result = await planner.plan(before, {
    id: "function",
    operations: [
      {
        id: "function",
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "FnRun", to: "run" }],
        selectors: [{ kind: "function", scope: "FnRun" }],
      },
    ],
  });
  assert.equal(result.statistics.fallbacks, 1);
  assert.equal(result.statistics.cacheHits, 0);
  assert.deepEqual(
    result.after,
    Object.fromEntries(
      Object.entries(before).map(([file, source]) => [file, source.replaceAll("FnRun", "run")]),
    ),
  );
  planner.acknowledge(before, result.after);
});
await test("type and owner signature changes reopen analysis instead of selecting stale declarations", async (t) => {
  const planner = await fixture(t);
  const before = { "main.cpp": "struct Box { int value; }; int get(Box b) { return b.value; }\n" };
  const type = await planner.plan(before, {
    id: "type",
    operations: [
      {
        id: "type",
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "Box", to: "Item" }],
        selectors: [{ kind: "type", scope: "Box" }],
      },
    ],
  });
  planner.acknowledge(before, type.after);
  const parameter = await planner.plan(
    type.after,
    rename("parameter", "b", "item", "get", "int (Item)"),
  );
  assert.equal(parameter.statistics.snapshotAttempts, 2);
  assert.ok(parameter.after["main.cpp"].includes("get(Item item) { return item.value; }"));
});
await test("helper views stay file-local and changing translation-unit views invalidates reuse", async (t) => {
  const planner = await fixture(t);
  const before = {
    "a.cpp": "static int helper(int x) { return x; } int a() { return helper(1); }\n",
    "b.cpp": "static int helper(int x) { return x + 1; } int b() { return helper(1); }\n",
  };
  const helper = (id, file, to) => ({
    id,
    operations: [
      { id, phase: "names", category: "helpers", file, mapping: [{ from: "helper", to }] },
    ],
  });
  const a = await planner.plan(before, helper("a", "a.cpp", "first"));
  planner.acknowledge(before, a.after);
  const b = await planner.plan(a.after, helper("b", "b.cpp", "second"));
  assert.equal(b.statistics.snapshotAttempts, 2);
  assert.ok(b.after["a.cpp"].includes("first(1)"));
  assert.ok(b.after["b.cpp"].includes("second(1)"));
});
