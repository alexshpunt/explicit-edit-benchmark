import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const input = {
  "api.h": "namespace api { inline int refine(int PPos, int extra) { return PPos + extra; } }\n",
  "part.cpp": "namespace api { static int refine(float other) { return (int)other; } }\n",
  "main.cpp": "int waiting_for_move() { return moved_helper(); }\n",
};
const request = () => ({
  id: "header-owner-collision",
  operations: [
    {
      id: "header-owner-collision",
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from: "PPos", to: "pos" }],
      selectors: [
        {
          kind: "variable",
          scope: "api::refine::PPos",
          owner: { scope: "api::refine", signature: "int (int, int)", definition: true },
        },
      ],
    },
  ],
});
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/header-owner-collision-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}
test("a same-name implementation cannot hide an actual header-defined owner", async (t) => {
  const planner = await fixture(t);
  const result = await planner.plan(input, request());
  assert.deepEqual(result.after, {
    ...input,
    "api.h": input["api.h"].replaceAll("PPos", "pos"),
  });
});
test("a same-spelling implementation parameter still cannot select another header overload", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("other", "PPos"),
  };
  const result = await planner.plan(before, request());
  assert.deepEqual(result.after, {
    ...before,
    "api.h": input["api.h"].replaceAll("PPos", "pos"),
  });
  planner.acknowledge(before, result.after);
  const next = request();
  next.operations[0].mapping = [{ from: "extra", to: "amount" }];
  next.operations[0].selectors[0].scope = "api::refine::extra";
  const peerChanged = {
    ...result.after,
    "main.cpp": input["main.cpp"] + "// unrelated peer write\n",
  };
  const second = await planner.plan(peerChanged, next);
  assert.deepEqual(second.after, {
    ...peerChanged,
    "api.h": result.after["api.h"].replaceAll("extra", "amount"),
  });
});
test("a header fallback still requires the requested current owner signature", async (t) => {
  const planner = await fixture(t);
  const task = request();
  task.operations[0].selectors[0].owner.signature = "int (double, double)";
  await assert.rejects(
    planner.plan(input, task),
    /Missing current owner\/signature binding|Compiler AST failed:/,
  );
});
test("a header fallback cannot hide errors in the selected header or its includes", async (t) => {
  const planner = await fixture(t);
  await assert.rejects(
    planner.plan(
      {
        ...input,
        "api.h": '#include "broken.h"\n' + input["api.h"],
        "broken.h": "MissingType broken;\n",
      },
      request(),
    ),
    /Compiler AST failed:/,
  );
});
test("an actual implementation compiler error is not replaced with a different valid header overload", async (t) => {
  const planner = await fixture(t);
  const task = request();
  task.operations[0].selectors[0].owner.signature = "int (int)";
  const before = {
    ...input,
    "part.cpp": "namespace api { int refine(int PPos) { return missing_helper(PPos); } }\n",
  };
  await assert.rejects(planner.plan(before, task), /Compiler AST failed:/);
});
