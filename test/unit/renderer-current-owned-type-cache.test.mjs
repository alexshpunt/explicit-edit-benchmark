import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const owned = (from, to, signature, scope = "make", definition = true) => ({
  id: from,
  operations: [
    {
      id: from,
      phase: "names",
      category: "functions-types",
      mapping: [{ from, to }],
      selectors: [
        { kind: "type", scope: scope + "::" + from, owner: { scope, signature, definition } },
      ],
    },
  ],
});
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/current-owned-type-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}

await test("independent local types retain a compiler view without combining overloaded owners", async (t) => {
  const planner = await fixture(t);
  let before = {
    "main.cpp":
      "template<class T> auto make(T value) { using First = int; struct FirstHelper { First value; }; return FirstHelper{value}; }\ntemplate<class T> auto make(const T& value) { using Second = double; struct SecondHelper { Second value; }; return SecondHelper{value}; }\n",
  };
  for (const [from, to, signature] of [
    ["First", "Value", "auto (T)"],
    ["Second", "Value", "auto (const T &)"],
    ["FirstHelper", "Helper", "auto (T)"],
    ["SecondHelper", "Helper", "auto (const T &)"],
  ]) {
    const result = await planner.plan(before, owned(from, to, signature));
    assert.equal(result.statistics.snapshotAttempts, 1);
    planner.acknowledge(before, result.after);
    before = result.after;
  }
  assert.equal(
    before["main.cpp"],
    "template<class T> auto make(T value) { using Value = int; struct Helper { Value value; }; return Helper{value}; }\ntemplate<class T> auto make(const T& value) { using Value = double; struct Helper { Value value; }; return Helper{value}; }\n",
  );
});

await test("local type owner signatures cannot select stale pre-rename metadata", async (t) => {
  const planner = await fixture(t);
  const before = {
    "main.cpp":
      "struct Box {}; template<class T> auto make(Box value, T) { using Local = Box; return Local{value}; }\n",
  };
  const renameBox = {
    id: "Box",
    operations: [
      {
        id: "Box",
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "Box", to: "Item" }],
        selectors: [{ kind: "type", scope: "Box" }],
      },
    ],
  };
  const first = await planner.plan(before, renameBox);
  planner.acknowledge(before, first.after);
  await assert.rejects(
    planner.plan(first.after, owned("Local", "Wrong", "auto (Box, T)")),
    /Missing current owner\/signature binding/,
  );
  const current = await planner.plan(first.after, owned("Local", "Value", "auto (Item, T)"));
  assert.equal(current.statistics.cacheHits, 0);
  assert.ok(current.after["main.cpp"].includes("using Value = Item; return Value{value};"));
});

await test("incomplete local type ownership and unknown source changes still reopen analysis", async (t) => {
  const planner = await fixture(t);
  const before = {
    "main.cpp":
      "template<class T> auto make(T value) { using First = int; using Second = int; using Third = int; return First{value}; }\n",
  };
  const firstTask = owned("First", "Value", "auto (T)");
  delete firstTask.operations[0].selectors[0].owner.definition;
  const first = await planner.plan(before, firstTask);
  planner.acknowledge(before, first.after);
  const second = await planner.plan(first.after, owned("Second", "Other", "auto (T)"));
  assert.equal(second.statistics.snapshotAttempts, 2);
  planner.acknowledge(first.after, second.after);
  const changed = {
    "main.cpp": second.after["main.cpp"]
      .replace("First{value}", "First{value + 1}")
      .replace("Value{value}", "Value{value + 1}"),
  };
  const third = await planner.plan(changed, owned("Third", "Last", "auto (T)"));
  assert.equal(third.statistics.snapshotAttempts, 3);
  assert.ok(third.after["main.cpp"].includes("return Value{value + 1};"));
});
