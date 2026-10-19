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
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/current-type-cache-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}
await test("header-only analysis cannot drop type uses activated by implementation macros", async (t) => {
  const planner = await fixture(t);
  const before = {
    "api.h":
      '#pragma once\n#include "context.h"\ntypedef enum { One, Two } Color;\n#ifdef WITH_BODY\nstruct Info { Color colorspace; };\n#endif\n',
    "context.h": "#pragma once\n#ifdef ENABLE_BODY\n#define WITH_BODY\n#endif\n",
    "main.cpp": '#/**/de\\\nfine ENABLE_BODY\n#include "api.h"\n',
  };
  const result = await planner.plan(before, type("Color", "Palette"));
  assert.equal(result.after["api.h"], before["api.h"].replaceAll("Color", "Palette"));
  assert.equal(result.after["main.cpp"], before["main.cpp"]);
});

await test("an unrelated implementation macro does not hide a closed header during an independent move", async (t) => {
  const planner = await fixture(t);
  const before = {
    "api.h": "#pragma once\nstruct Closed {};\n",
    "other.h": "#pragma once\n#ifdef ENABLE_BODY\nstruct Other {};\n#endif\n",
    "main.cpp":
      '#define ENABLE_BODY\n#include "other.h"\nint pending_move() { return missing(); }\n',
  };
  const result = await planner.plan(before, type("Closed", "Renamed"));
  assert.equal(result.after["api.h"], before["api.h"].replace("Closed", "Renamed"));
  assert.equal(result.after["main.cpp"], before["main.cpp"]);
});
await test("inactive external macro definitions do not block a closed header during an independent move", async (t) => {
  const planner = await fixture(t);
  const before = {
    "api.h": "#pragma once\ninline int closed(int value) { return value; }\n",
    "cuda.h": "#pragma once\n#ifdef __CUDACC__\n#define inline inline __device__\n#endif\n",
    "main.cpp": '#include "cuda.h"\nint pending_move() { return missing(); }\n',
  };
  const task = {
    id: "closed",
    operations: [
      {
        id: "closed",
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "closed", to: "renamed" }],
        selectors: [{ kind: "function", scope: "closed" }],
      },
    ],
  };
  const result = await planner.plan(before, task);
  assert.equal(result.after["api.h"], before["api.h"].replace("closed", "renamed"));
  assert.equal(result.after["main.cpp"], before["main.cpp"]);
});

await test("activating an implementation macro invalidates a pending header-only type plan", async (t) => {
  const planner = await fixture(t);
  const before = {
    "api.h":
      "#pragma once\ntypedef enum { One, Two } Color;\n#ifdef ENABLE_BODY\nstruct Info { Color colorspace; };\n#endif\n",
    "main.cpp": '#include "api.h"\n',
  };
  const task = type("Color", "Palette");
  const pending = await planner.plan(before, task);
  assert.ok(pending.after["api.h"].includes("Color colorspace"));
  const changed = { ...before, "main.cpp": "#define ENABLE_BODY\n" + before["main.cpp"] };
  const current = await planner.plan(changed, task);
  assert.equal(current.after["api.h"], before["api.h"].replaceAll("Color", "Palette"));
  assert.equal(current.after["main.cpp"], changed["main.cpp"]);
  assert.equal(current.statistics.pendingHits, 0);
  planner.acknowledge(changed, current.after);
});
const input = {
  "main.cpp":
    "struct First { struct Inner {}; }; struct Second {}; First take(First value) { return value; }\n",
};

await test("independent plain type bindings reuse a full-project snapshot while signature consumers reopen it", async (t) => {
  const planner = await fixture(t);
  const first = await planner.plan(input, type("First", "Box"));
  planner.acknowledge(input, first.after);
  const second = await planner.plan(first.after, type("Second", "Other"));
  assert.equal(second.statistics.snapshotAttempts, 1);
  assert.equal(second.statistics.cacheHits, 1);
  assert.equal(
    second.after["main.cpp"],
    "struct Box { struct Inner {}; }; struct Other {}; Box take(Box value) { return value; }\n",
  );
  planner.acknowledge(first.after, second.after);
  const nested = await planner.plan(second.after, type("Inner", "Value", "Box::Inner"));
  assert.equal(nested.statistics.snapshotAttempts, 1);
  planner.acknowledge(second.after, nested.after);
  const consumer = {
    id: "take",
    operations: [
      {
        id: "take",
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "take", to: "consume" }],
        selectors: [{ kind: "function", scope: "take", signature: "Box (Box)", definition: true }],
      },
    ],
  };
  const last = await planner.plan(nested.after, consumer);
  assert.equal(last.statistics.snapshotAttempts, 2);
  assert.ok(last.after["main.cpp"].includes("Box consume(Box value)"));
});

await test("full-project type reuse cannot select an earlier destination or hide changed implementation input", async (t) => {
  const planner = await fixture(t);
  const first = await planner.plan(input, type("First", "Box"));
  planner.acknowledge(input, first.after);
  const second = await planner.plan(first.after, type("Box", "Renamed"));
  assert.equal(second.statistics.snapshotAttempts, 2);
  assert.ok(second.after["main.cpp"].includes("Renamed take(Renamed value)"));
  planner.acknowledge(first.after, second.after);
  const changed = { ...second.after, "new.cpp": "struct Third {};\n" };
  const third = await planner.plan(changed, type("Third", "Added"));
  assert.equal(third.statistics.snapshotAttempts, 3);
  assert.equal(third.after["new.cpp"], "struct Added {};\n");
  assert.equal(third.after["main.cpp"], changed["main.cpp"]);
});
