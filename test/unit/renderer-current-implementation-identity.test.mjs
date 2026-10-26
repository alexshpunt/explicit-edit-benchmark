import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";
import {
  applyCoherentStructure,
  applyCurrentStructure,
} from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";

const original = {
  "api.h": "#pragma once\nnamespace sample { int picked(int value); int picked(float value); }\n",
  "main.cpp": '#include "api.h"\nint peer() { return 3; }\n',
  "part.cpp":
    '#include "api.h"\nnamespace sample {\nint picked(int renamed) { return renamed + 1; }\nint picked(float other) { return (int)other + 2; }\n}\n',
};
const move = {
  id: "picked",
  phase: "structure",
  action: "implementation",
  file: "part.cpp",
  includes: [{ file: "api.h", quoted: true }],
  targets: [
    {
      selector: {
        kind: "function",
        scope: "sample",
        name: "picked",
        signature: "int (int)",
        declarator: "intpicked(intvalue)",
        definition: true,
      },
      context: [],
    },
  ],
};
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/implementation-identity-"));
  const planner = currentNamingPlanner(directory, { signal: t.signal, maxViews: 1 });
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}
const apply = (tree, request, implementation) =>
  applyCurrentStructure(tree, request, { implementation });
const plainError = (error) => error.constructor === Error;

test("current implementation identity reuses unchanged summaries and invalidates changed physical origins", async (t) => {
  const planner = await fixture(t);
  const first = await planner.implementation(original, move);
  assert.deepEqual(apply(original, move, first), original);
  assert.throws(() => applyCoherentStructure(original, move), plainError);
  const second = await planner.implementation(original, move);
  assert.equal(second.statistics.snapshotAttempts, first.statistics.snapshotAttempts);
  assert.ok(second.statistics.cacheHits > first.statistics.cacheHits);
  assert.deepEqual(apply(original, move, second), original);

  const changed = {
    ...original,
    "copy.h": original["api.h"],
    "part.cpp": original["part.cpp"].replace('"api.h"', '"copy.h"'),
  };
  assert.throws(() => apply(changed, move, second), plainError);
  const refreshed = await planner.implementation(changed, move);
  assert.ok(refreshed.statistics.snapshotAttempts > second.statistics.snapshotAttempts);
  // Include requirements still apply; existing definitions and overloads keep their bytes.
  assert.deepEqual(apply(changed, move, refreshed), {
    ...changed,
    "part.cpp": '#include "api.h"\n' + changed["part.cpp"],
  });
});

test("current implementation identity removes a differently spelled source duplicate and retains the selected destination", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...original,
    "main.cpp":
      original["main.cpp"] + "namespace sample { int picked(int value) { return value + 9; } }\n",
  };
  const resolution = await planner.implementation(before, move);
  const result = apply(before, move, resolution);
  assert.equal(result["part.cpp"], original["part.cpp"]);
  assert.equal(result["main.cpp"].includes("return value + 9"), false);
  assert.equal(result["main.cpp"].includes("return 3;"), true);
  assert.throws(() => apply(before, { ...move, id: "another-request" }, resolution), plainError);
});

test("current implementation identity rejects a missing scope or canonical overload and propagates compiler source failures", async (t) => {
  const planner = await fixture(t);
  for (const update of [{ scope: "other" }, { signature: "int (double)" }]) {
    const request = {
      ...move,
      targets: [{ ...move.targets[0], selector: { ...move.targets[0].selector, ...update } }],
    };
    const resolution = await planner.implementation(original, request);
    assert.throws(() => apply(original, request, resolution), plainError);
  }
  const broken = { ...original, "part.cpp": original["part.cpp"] + "MissingType broken;\n" };
  await assert.rejects(
    planner.implementation(broken, move),
    (error) => error.compilerSourceFailure === true,
  );
  const restored = await planner.implementation(original, move);
  assert.deepEqual(apply(original, move, restored), original);
});
