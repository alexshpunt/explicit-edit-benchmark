import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const input = {
  "api.h": "#pragma once\nnamespace api { int refine(int); }\n",
  "part.cpp":
    '#include "api.h"\nnamespace api { int refine(int x) { auto call = [](int PPos) { return PPos + 1; }; return call(x); } }\n',
  "peer.cpp": "int other(int PPos) { return PPos * 2; }\n",
  "main.cpp": "int waiting_for_move() { return moved_helper(); }\n",
};
const request = () => ({
  id: "nested-parameter",
  operations: [
    {
      id: "nested-parameter",
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from: "PPos", to: "pos" }],
      selectors: [
        {
          kind: "variable",
          scope: "api::refine::operator()::PPos",
          owner: { scope: "api::refine", signature: "int (int)", definition: true },
        },
      ],
    },
  ],
});
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/nested-local-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}

test("a nested lambda parameter uses its physical enclosing definition during unrelated movement", async (t) => {
  const planner = await fixture(t);
  const before = structuredClone(input);
  const result = await planner.plan(before, request());
  assert.deepEqual(result.after, {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("PPos", "pos"),
  });
  assert.deepEqual(before, input);
  planner.acknowledge(before, result.after);
});

test("a nested local view still requires its exact compiler owner, nested scope and includes", async (t) => {
  const planner = await fixture(t);
  const wrong = request();
  wrong.operations[0].selectors[0].scope = "api::refine::missing::PPos";
  await assert.rejects(planner.plan(input, wrong), /Missing current owner\/signature binding/);
  const wrongOwner = request();
  wrongOwner.operations[0].selectors[0].owner.signature = "long (int)";
  await assert.rejects(planner.plan(input, wrongOwner), /Missing current owner\/signature binding/);
  await assert.rejects(
    planner.plan({ ...input, "api.h": input["api.h"] + "MissingType broken;\n" }, request()),
    /Compiler AST failed:/,
  );
});
