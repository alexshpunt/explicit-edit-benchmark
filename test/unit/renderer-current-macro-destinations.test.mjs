import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/macro-destination-"));
  const planner = currentNamingPlanner(directory, { signal: t.signal, maxViews: 1 });
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}

const initial = {
  "api.h":
    "#pragma once\n#ifdef IMPLEMENTATION\nint selected(int after, int ready) { return after + ready; }\n#else\nint selected(int, int);\n#endif\n",
  "a-main.cpp": '#include "api.h"\nint main() { return selected(1, 2); }\n',
  "z-impl.cpp": '#define IMPLEMENTATION\n#include "api.h"\n',
};
const local = (from, to) => ({
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
          scope: `selected::${from}`,
          owner: { scope: "selected", signature: "int (int, int)", definition: true },
        },
      ],
    },
  ],
});

test("completed macro-owned bindings reuse actual-TU summaries and changed source is replanned", async (t) => {
  const planner = await fixture(t);
  const first = await planner.plan(initial, local("before", "after"));
  assert.deepEqual(first.after, initial);
  planner.acknowledge(initial, first.after);

  const second = await planner.plan(initial, local("not_ready", "ready"));
  assert.deepEqual(second.after, initial);
  assert.equal(second.statistics.snapshotAttempts, first.statistics.snapshotAttempts);
  planner.acknowledge(initial, second.after);

  const changed = {
    ...initial,
    "api.h": initial["api.h"].replaceAll("ready", "not_ready"),
  };
  const third = await planner.plan(changed, local("not_ready", "ready"));
  assert.deepEqual(third.after, initial);
  assert.ok(third.statistics.snapshotAttempts > second.statistics.snapshotAttempts);
  planner.acknowledge(changed, third.after);
});

test("completed coupled declarations require all public owner contexts across actual TUs", async (t) => {
  const planner = await fixture(t);
  const task = {
    id: "function",
    operations: [
      {
        id: "function",
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "Original", to: "selected" }],
        selectors: [false, true].map((definition) => ({
          kind: "function",
          scope: "Original",
          owner: { scope: "Original", signature: "int (int, int)", definition },
        })),
      },
    ],
  };
  const result = await planner.plan(initial, task);
  assert.deepEqual(result.after, initial);
  planner.acknowledge(initial, result.after);

  const missingDefinition = {
    ...initial,
    "z-impl.cpp": '#define ANOTHER_CONTEXT\n#include "api.h"\n',
  };
  await assert.rejects(
    planner.plan(missingDefinition, task),
    (error) => error.constructor === Error,
  );
  const restored = await planner.plan(initial, task);
  assert.deepEqual(restored.after, initial);
});
