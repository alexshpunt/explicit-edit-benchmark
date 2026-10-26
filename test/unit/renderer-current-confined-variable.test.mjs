import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const request = (from = "shared_value", to = "value") => ({
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
          scope: `api::${from}`,
          owner: { scope: "api::build", signature: "int (int)", definition: true },
        },
        {
          kind: "variable",
          scope: `api::${from}`,
          owner: { scope: "api::build", signature: "int (float)", definition: true },
        },
        { kind: "variable", scope: `api::${from}` },
      ],
    },
  ],
});
const input = {
  "api.h": "#pragma once\nnamespace api { int build(int); int build(float); }\n",
  "paste.h": "#define STEP(current) current ## _size\n",
  "part.cpp":
    '#include "api.h"\nnamespace api { int build(int x) { extern int shared_value; return shared_value + x; } int build(float x) { extern int shared_value; return shared_value + (int)x; } int shared_value = 1; }\n',
  "peer.cpp": '#include "paste.h"\nint waiting_for_move() { return moved_helper(); }\n',
};
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/confined-variable-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}

test("a global binding with several block extern owners can be renamed during an unrelated move", async (t) => {
  const planner = await fixture(t);
  const before = structuredClone(input);
  const result = await planner.plan(before, request());
  assert.deepEqual(result.after, {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("shared_value", "value"),
  });
  assert.deepEqual(before, input);
  planner.acknowledge(before, result.after);
});

test("a confined global view retains current owner signatures and errors in its own includes", async (t) => {
  const planner = await fixture(t);
  const wrong = request();
  wrong.operations[0].selectors[0].owner.signature = "long (int)";
  wrong.operations[0].selectors = [wrong.operations[0].selectors[0]];
  // Isolate owner selection from the deliberately broken unrelated translation unit.
  const valid = { ...input, "peer.cpp": input["peer.cpp"].replace("moved_helper()", "0") };
  await assert.rejects(planner.plan(valid, wrong), /Missing current owner\/signature binding/);
  await assert.rejects(
    planner.plan({ ...input, "api.h": input["api.h"] + "MissingType broken;\n" }, request()),
    /Compiler AST failed:/,
  );
});

test("other translation units cannot hide plain, spliced or token-pasted uses of a global binding", async (t) => {
  const planner = await fixture(t);
  const uses = [
    "namespace api { extern int shared_value; int use() { return shared_value; } }\n",
    "namespace api { extern int shared_\\\nvalue; int use() { return shared_\\\nvalue; } }\n",
    "#define GLOBAL(x) shared_ ## x\nnamespace api { extern int GLOBAL(value); int use() { return GLOBAL(value); } }\n",
  ];
  for (const use of uses) {
    const before = { ...input, "other.cpp": use };
    await assert.rejects(planner.plan(before, request()), /Compiler AST failed:/);
    assert.equal(before["other.cpp"], use);
  }
});

test("a pending confined global plan is invalidated when a peer adds a macro-generated use", async (t) => {
  const planner = await fixture(t);
  const result = await planner.plan(input, request());
  assert.ok(result.after["part.cpp"].includes("int value = 1"));
  const before = {
    ...input,
    "peer.cpp":
      input["peer.cpp"] +
      "#define GLOBAL(x) shared_ ## x\nnamespace api { extern int GLOBAL(value); int use() { return GLOBAL(value); } }\n",
  };
  await assert.rejects(planner.plan(before, request()), /Compiler AST failed:/);
});

test("a macro-expanded implementation include cannot hide a second global context", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "peer.cpp": '#define IMPL "part.cpp"\n#include IMPL\n' + input["peer.cpp"],
  };
  await assert.rejects(planner.plan(before, request()), /Compiler AST failed:|Command failed:/);
});
test("a physical implementation included by a peer cannot be treated as a closed global view", async (t) => {
  const planner = await fixture(t);
  for (const include of ['#include "part.cpp"\n', '#include \\\n"part.cpp"\n']) {
    await assert.rejects(
      planner.plan({ ...input, "peer.cpp": include + input["peer.cpp"] }, request()),
      /Compiler AST failed:/,
    );
  }
});
