import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const task = {
  id: "parameter",
  operations: [
    {
      id: "parameter",
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from: "value", to: "restored" }],
      selectors: [
        { kind: "function", scope: "selected", signature: "int (int)", definition: true },
      ],
    },
  ],
};
const broken = {
  "main.cpp": "int selected(int value) { return value; } int peer() { return missing(); }\n",
};
const repaired = {
  "main.cpp": "int selected(int value) { return value; } int peer() { return 1; }\n",
};
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/current-naming-race-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}

await test("a compiler failure from a replaced source snapshot requests a fresh plan, not a failed delivery", async (t) => {
  const planner = await fixture(t);
  let reads = 0;
  const stale = await planner.plan(broken, task, async () => {
    reads++;
    return repaired;
  });
  assert.equal(stale, undefined);
  assert.equal(reads, 1);
  const current = await planner.plan(repaired, task, async () => repaired);
  assert.equal(current.after["main.cpp"], repaired["main.cpp"].replaceAll("value", "restored"));
  planner.acknowledge(repaired, current.after);
});

await test("an unchanged compiler error remains fatal even when a freshness reader is available", async (t) => {
  const planner = await fixture(t);
  let reads = 0;
  await assert.rejects(
    planner.plan(broken, task, async () => {
      reads++;
      return { ...broken };
    }),
    /Compiler AST failed:/,
  );
  assert.equal(reads, 1);
});

await test("freshness cannot hide a selector error or an error reading current source", async (t) => {
  const planner = await fixture(t);
  let reads = 0;
  const missing = structuredClone(task);
  missing.operations[0].mapping[0].from = "absent";
  await assert.rejects(
    planner.plan(repaired, missing, async () => {
      reads++;
      return broken;
    }),
    /Missing current/,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    planner.plan(broken, task, async () => {
      throw Error("current source read failed");
    }),
    /current source read failed/,
  );
});
