import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const definition = (name) =>
  `namespace api { int ${name}(int first, int second) { return first + second; } }\n`;
const input = {
  "north.cpp": definition("north"),
  "south.cpp": definition("south"),
  "main.cpp": "int waiting_for_move() { return moved_helper(); }\n",
};
const request = (owner, from, to) => ({
  id: `${owner}-${from}`,
  operations: [
    {
      id: `${owner}-${from}`,
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from, to }],
      selectors: [
        {
          kind: "variable",
          scope: `api::${owner}::${from}`,
          owner: { scope: `api::${owner}`, signature: "int (int, int)", definition: true },
        },
      ],
    },
  ],
});
async function fixture(t, options = {}) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/current-view-cache-"));
  const planner = currentNamingPlanner(directory, options);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}
async function commit(planner, before, task) {
  const result = await planner.plan(before, task);
  planner.acknowledge(before, result.after);
  return result;
}
test("acknowledged edits in another implementation do not rebuild a retained compiler view", async (t) => {
  const planner = await fixture(t);
  const north = await commit(planner, input, request("north", "first", "left"));
  const south = await commit(planner, north.after, request("south", "first", "south_left"));
  const returned = await commit(planner, south.after, request("north", "second", "right"));
  assert.deepEqual(returned.after, {
    ...input,
    "north.cpp": input["north.cpp"].replaceAll("first", "left").replaceAll("second", "right"),
    "south.cpp": input["south.cpp"].replaceAll("first", "south_left"),
  });
  assert.equal(returned.statistics.snapshotAttempts, 2);
  assert.equal(returned.statistics.cacheHits, 1);
});
test("header views survive acknowledged implementation edits but invalidate consumers when headers change", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "api.h": definition("boundary"),
    "north.cpp": '#include "api.h"\n' + input["north.cpp"],
  };
  const header = await commit(planner, before, request("boundary", "first", "header_left"));
  const north = await commit(planner, header.after, request("north", "first", "left"));
  const headerAgain = await commit(
    planner,
    north.after,
    request("boundary", "second", "header_right"),
  );
  assert.equal(headerAgain.statistics.snapshotAttempts, 2);
  assert.equal(headerAgain.statistics.cacheHits, 1);
  const northAgain = await commit(planner, headerAgain.after, request("north", "second", "right"));
  assert.equal(northAgain.statistics.snapshotAttempts, 3);
  assert.deepEqual(northAgain.after, {
    ...before,
    "api.h": before["api.h"]
      .replaceAll("first", "header_left")
      .replaceAll("second", "header_right"),
    "north.cpp": before["north.cpp"].replaceAll("first", "left").replaceAll("second", "right"),
  });
});
test("an unexplained peer write cannot reuse an implementation view with otherwise unchanged inputs", async (t) => {
  const planner = await fixture(t);
  const north = await commit(planner, input, request("north", "first", "left"));
  const south = await commit(planner, north.after, request("south", "first", "south_left"));
  const changed = { ...south.after, "main.cpp": input["main.cpp"] + "// unknown peer write\n" };
  const result = await commit(planner, changed, request("north", "second", "right"));
  assert.equal(result.statistics.snapshotAttempts, 3);
  assert.equal(result.statistics.cacheHits, 0);
  assert.equal(result.after["main.cpp"], changed["main.cpp"]);
  assert.equal(result.after["south.cpp"], south.after["south.cpp"]);
});
test("retention is bounded to three recent views and evicts the least recently used one", async (t) => {
  const planner = await fixture(t);
  let current = { ...input, "east.cpp": definition("east"), "west.cpp": definition("west") };
  let result;
  for (const [owner, from, to] of [
    ["north", "first", "left"],
    ["south", "first", "south_left"],
    ["east", "first", "east_left"],
    ["north", "second", "right"],
    ["west", "first", "west_left"],
    ["south", "second", "south_right"],
  ]) {
    result = await commit(planner, current, request(owner, from, to));
    current = result.after;
  }
  assert.equal(result.statistics.snapshotAttempts, 5);
  assert.equal(result.statistics.cacheHits, 1);
  assert.equal(
    current["north.cpp"],
    input["north.cpp"].replaceAll("first", "left").replaceAll("second", "right"),
  );
  assert.equal(
    current["south.cpp"],
    input["south.cpp"].replaceAll("first", "south_left").replaceAll("second", "south_right"),
  );
});
test("a private one-view budget evicts another translation unit without changing its edits", async (t) => {
  const planner = await fixture(t, { maxViews: 1 });
  const north = await commit(planner, input, request("north", "first", "left"));
  const south = await commit(planner, north.after, request("south", "first", "south_left"));
  const returned = await commit(planner, south.after, request("north", "second", "right"));
  assert.equal(returned.statistics.snapshotAttempts, 3);
  assert.equal(returned.statistics.cacheHits, 0);
  assert.deepEqual(returned.after, {
    ...input,
    "north.cpp": input["north.cpp"].replaceAll("first", "left").replaceAll("second", "right"),
    "south.cpp": input["south.cpp"].replaceAll("first", "south_left"),
  });
});
test("a consumed but unacknowledged plan cannot enter the retained-view cache", async (t) => {
  const planner = await fixture(t);
  await planner.plan(input, request("north", "first", "uncommitted"));
  const south = await commit(planner, input, request("south", "first", "south_left"));
  const result = await commit(planner, south.after, request("north", "second", "right"));
  assert.equal(result.statistics.snapshotAttempts, 3);
  assert.equal(result.after["north.cpp"], input["north.cpp"].replaceAll("second", "right"));
  assert.ok(!JSON.stringify(result.after).includes("uncommitted"));
});
