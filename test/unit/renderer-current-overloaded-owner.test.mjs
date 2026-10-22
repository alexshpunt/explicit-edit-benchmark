import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";
const input = {
  "api.h": "#pragma once\nnamespace api { int refine(int); int refine(float); }\n",
  "part.cpp": '#include "api.h"\nnamespace api { int refine(int PPos) { return PPos + 1; } }\n',
  "peer.cpp":
    '#include "api.h"\nnamespace api { int refine(float PPos) { return (int)PPos * 2; } }\n',
  "main.cpp": "int waiting_for_move() { return moved_helper(); }\n",
};
const request = () => ({
  id: "overloaded-owner",
  operations: [
    {
      id: "overloaded-owner",
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from: "PPos", to: "pos" }],
      selectors: [
        {
          kind: "variable",
          scope: "api::refine::PPos",
          owner: { scope: "api::refine", signature: "int (int)", definition: true },
        },
      ],
    },
  ],
});
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/overloaded-owner-"));
  const planner = currentNamingPlanner(directory);
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return planner;
}
test("same-spelling owners in different implementations are distinguished by actual compiler signatures", async (t) => {
  const planner = await fixture(t);
  const result = await planner.plan(input, request());
  assert.deepEqual(result.after, {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("PPos", "pos"),
  });
  planner.acknowledge(input, result.after);
});
test("compiler owner selection distinguishes namespaces rather than a shared final name", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "peer.cpp": "namespace other { int refine(int PPos) { return PPos * 2; } }\n",
  };
  const result = await planner.plan(before, request());
  assert.deepEqual(result.after, {
    ...before,
    "part.cpp": input["part.cpp"].replaceAll("PPos", "pos"),
  });
});
test("an unrelated fixed-arity overload body cannot block the selected implementation", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "paste.h": "#define STEP(current) current ## _size\n",
    "peer.cpp":
      '#include "paste.h"\nnamespace api { int refine(float first, float second) { return missing_helper(); } }\n',
  };
  const result = await planner.plan(before, request());
  assert.deepEqual(result.after, {
    ...before,
    "part.cpp": input["part.cpp"].replaceAll("PPos", "pos"),
  });
});
test("a same-arity unrelated body without the selected binding cannot block the target", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "peer.cpp": "namespace api { int refine(float other) { return missing_helper(); } }\n",
  };
  const result = await planner.plan(before, request());
  assert.deepEqual(result.after, {
    ...before,
    "part.cpp": input["part.cpp"].replaceAll("PPos", "pos"),
  });
});
test("preprocessing cannot hide a selected spelling generated inside another owner", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "peer.cpp":
      "#define PARAM PPos\nnamespace api { int refine(float PARAM) { return missing_helper(); } }\n",
  };
  await assert.rejects(planner.plan(before, request()), /Compiler AST failed:/);
});
test("a macro-generated parameter spelling still requires the candidate compiler proof", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "part.cpp": "namespace api { int refine(int PPos, int second) { return PPos + second; } }\n",
    "peer.cpp":
      "#define PARAMS int PPos, int second\nnamespace api { int refine(PARAMS) { return missing_helper(); } }\n",
  };
  const task = request();
  task.operations[0].selectors[0].owner.signature = "int (int, int)";
  await assert.rejects(planner.plan(before, task), /Compiler AST failed:/);
});
test("simple one-argument templates do not hide an incompatible overload arity", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "part.cpp":
      "#include <vector>\nnamespace api { static int refine(std::vector<int>& values) { int PPos = values.size(); return PPos; } }\n",
    "peer.cpp":
      "#include <vector>\nnamespace api { static int refine(const std::vector<int>& values, bool flag) { int PPos = missing_helper(); return PPos; } }\n",
  };
  const task = request();
  task.operations[0].selectors[0].owner.signature = "int (std::vector<int> &)";
  const result = await planner.plan(before, task);
  assert.deepEqual(result.after, {
    ...before,
    "part.cpp": before["part.cpp"].replaceAll("PPos", "pos"),
  });
});
test("multi-argument templates cannot be counted as extra function parameters", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "part.cpp":
      "#include <vector>\nnamespace api { static int refine(std::vector<int>& values) { int PPos = values.size(); return PPos; } }\n",
    "peer.cpp":
      "#include <utility>\nnamespace api { static int refine(std::pair<int, int> PPos) { return missing_helper(); } }\n",
  };
  const task = request();
  task.operations[0].selectors[0].owner.signature = "int (std::vector<int> &)";
  await assert.rejects(planner.plan(before, task), /Compiler AST failed:/);
});
test("explicit line directives cannot prove that another implementation lacks the binding", async (t) => {
  const planner = await fixture(t);
  for (const directive of [
    '#line 1 "opaque.cpp"',
    '#li\\\nne 1 "opaque.cpp"',
    '%:line 1 "opaque.cpp"',
  ]) {
    const before = {
      ...input,
      "peer.cpp":
        directive + "\nnamespace api { int refine(float other) { return missing_helper(); } }\n",
    };
    await assert.rejects(planner.plan(before, request()), /Compiler AST failed:/);
  }
});
test("cached owner metadata does not reuse another binding's implementation choice", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "part.cpp": "namespace api { static int refine(int PPos) { return PPos + 1; } }\n",
    "peer.cpp": "namespace api { static int refine(int QPos) { return QPos * 2; } }\n",
  };
  const first = await planner.plan(before, request());
  planner.acknowledge(before, first.after);
  const next = request();
  next.operations[0].mapping = [{ from: "QPos", to: "quantity" }];
  next.operations[0].selectors[0].scope = "api::refine::QPos";
  const second = await planner.plan(first.after, next);
  assert.deepEqual(second.after, {
    ...first.after,
    "peer.cpp": before["peer.cpp"].replaceAll("QPos", "quantity"),
  });
});
test("an acknowledged owner proof cannot hide a newly duplicated peer definition", async (t) => {
  const planner = await fixture(t);
  const first = await planner.plan(input, request());
  planner.acknowledge(input, first.after);
  const changed = { ...first.after, "peer.cpp": first.after["part.cpp"] };
  const next = request();
  next.operations[0].mapping = [{ from: "pos", to: "position" }];
  next.operations[0].selectors[0].scope = "api::refine::pos";
  await assert.rejects(planner.plan(changed, next), /Compiler AST failed:/);
});
test("repeated actual owners and invalid candidate includes do not silently select one implementation", async (t) => {
  const planner = await fixture(t);
  await assert.rejects(
    planner.plan({ ...input, "peer.cpp": input["part.cpp"] }, request()),
    /Compiler AST failed:/,
  );
  await assert.rejects(
    planner.plan({ ...input, "peer.cpp": input["peer.cpp"] + "MissingType broken;\n" }, request()),
    /Compiler AST failed:/,
  );
});
