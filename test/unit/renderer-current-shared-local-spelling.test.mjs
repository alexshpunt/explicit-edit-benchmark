import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";
import { scopedNamingSession } from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

const request = (signature = "int (int)") => ({
  id: "shared-parameter",
  operations: [
    {
      id: "shared-parameter",
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from: "paramScale", to: "scale" }],
      selectors: [
        {
          kind: "variable",
          scope: "api::refine::paramScale",
          owner: {
            scope: "api::refine",
            signature,
            definition: true,
          },
        },
      ],
    },
  ],
});
const input = {
  "api.h": "#pragma once\nnamespace api { int refine(int paramScale); }\n",
  "part.cpp":
    '#include "api.h"\nnamespace api { int refine(int paramScale) { return paramScale + 1; } }\n',
  "peer.cpp": "int unrelated(int paramScale) { return paramScale * 2; }\n",
  "main.cpp": "int waiting_for_move() { return moved_helper(); }\n",
};
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/shared-local-spelling-"));
  const planner = currentNamingPlanner(root);
  t.after(async () => {
    planner.close();
    await rm(root, { recursive: true, force: true });
  });
  return planner;
}

test("same-spelling parameters in unrelated files do not make a definition depend on their compiler state", async (t) => {
  const planner = await fixture(t);
  const before = structuredClone(input);
  const result = await planner.plan(before, request());
  assert.deepEqual(result.after, {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("paramScale", "scale"),
  });
  assert.deepEqual(before, input);
  planner.acknowledge(before, result.after);
});

test("a scoped local view still requires the actual current owner signature and valid owner includes", async (t) => {
  const planner = await fixture(t);
  // Isolate owner selection from the deliberately broken unrelated translation unit.
  const valid = { ...input, "main.cpp": input["main.cpp"].replace("moved_helper()", "0") };
  await assert.rejects(
    planner.plan(valid, request("long (int)")),
    /Missing current owner\/signature binding/,
  );
  await assert.rejects(
    planner.plan({ ...input, "api.h": input["api.h"] + "MissingType broken;\n" }, request()),
    /Compiler AST failed:/,
  );
});

test("a repeated physical owner cannot silently select just one implementation", async (t) => {
  const planner = await fixture(t);
  const before = { ...input, "duplicate.cpp": input["part.cpp"] };
  await assert.rejects(planner.plan(before, request()), /Compiler AST failed:/);
  assert.deepEqual(before, { ...input, "duplicate.cpp": input["part.cpp"] });
});

test("a confined compiler plan cannot rename an included definition or a block-scope extern", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/local-definition-guards-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    {
      tree: {
        "api.h":
          "#pragma once\nnamespace api { inline int refine(int paramScale) { return paramScale; } }\n",
        "part.cpp": '#include "api.h"\n',
      },
      task: request(),
    },
    {
      tree: {
        "part.cpp":
          "namespace api { int paramScale = 1; int refine(int other) { extern int paramScale; return paramScale + other; } }\n",
      },
      task: request(),
    },
  ];
  cases[1].task.operations[0].selectors[0].scope = "api::paramScale";
  for (const [index, item] of cases.entries()) {
    const directory = path.join(root, String(index));
    await mkdir(directory);
    const session = await scopedNamingSession(item.tree, directory, { file: "part.cpp" });
    try {
      await assert.rejects(
        session.plan(item.task.operations[0], { localDefinitionOnly: true }),
        /Unsupported local reference/,
      );
    } finally {
      session.close();
    }
  }
});
