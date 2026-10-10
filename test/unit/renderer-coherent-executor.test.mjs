import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { prepareCoherentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-executor.mjs";
import { fullExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/full-executor.mjs";
import {
  applyCoherentStructure,
  coherentModuleCleanup,
} from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import { execFileSync } from "node:child_process";
import {
  scopedNamingSession,
  applyScopedNamePlan,
  currentNamingSelectors,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

await test("current owner tables follow a type renamed by an earlier module without widening a same-spelling overload", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-current-owners-"));
  const tree = {
    "frond_math.h":
      "#ifndef FROND_MATH_H\n#define FROND_MATH_H\nnamespace frond { struct TypeVecData { int value; }; }\n#endif\n",
    "frond_sampling.h":
      '#include "frond_math.h"\nnamespace frond {\nTypeVecData FuncSample(const TypeVecData& input) { const char* text = "TypeVecData"; return input; }\nint FuncSample(int input) { return input; }\n}\n',
    "main.cpp":
      '#include "frond_sampling.h"\nint main() { return frond::FuncSample(frond::TypeVecData{3}).value == 3 ? 0 : 1; }\n',
  };
  const request = {
    id: "sample",
    category: "functions-types",
    mapping: [{ from: "FuncSample", to: "sample" }],
    selectors: [
      {
        kind: "function",
        scope: "frond::FuncSample",
        owner: {
          scope: "frond::FuncSample",
          signature: "TypeVecData (const TypeVecData &)",
          definition: true,
        },
      },
    ],
  };
  let session, origins;
  try {
    const initial = path.join(root, "initial");
    await mkdir(initial);
    session = await scopedNamingSession(tree, initial, {
      onSelection: (selected) => {
        origins = selected;
      },
    });
    await session.plan(request);
    const selected = origins;
    const typePlan = await session.plan({
      id: "type",
      category: "functions-types",
      mapping: [{ from: "TypeVecData", to: "Vec" }],
      selectors: [{ kind: "type", scope: "frond::TypeVecData" }],
    });
    const current = applyScopedNamePlan(tree, typePlan);
    session.close();
    const actual = selected.map((origin) => ({
      ...origin,
      start:
        origin.start +
        typePlan.edits
          .filter((edit) => edit.file === origin.file && edit.start < origin.start)
          .reduce((sum, edit) => sum + edit.new.length - edit.old.length, 0),
    }));
    const refreshed = path.join(root, "refreshed");
    await mkdir(refreshed);
    const [selectors] = await currentNamingSelectors(current, [actual], refreshed);
    assert.equal(selectors[0].owner.signature, "Vec (const Vec &)");
    const editing = path.join(root, "editing");
    await mkdir(editing);
    session = await scopedNamingSession(current, editing);
    await assert.rejects(session.plan(request), /Missing current owner/);
    const renamed = applyScopedNamePlan(current, await session.plan({ ...request, selectors }));
    assert.match(renamed["frond_sampling.h"], /Vec sample\(const Vec& input\)/);
    assert.match(renamed["frond_sampling.h"], /int FuncSample\(int input\)/);
    assert.match(renamed["frond_sampling.h"], /"TypeVecData"/);
    const workspace = path.join(root, "workspace");
    await writeTree(workspace, renamed);
    const binary = path.join(root, "program");
    execFileSync("clang++", ["-std=c++17", path.join(workspace, "main.cpp"), "-o", binary]);
    execFileSync(binary);
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});
await test("a whole module removes its temporary declarations before their private return type leaves main, without touching another module or the public header", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-module-cleanup-"));
  const tree = {
    "frond_trace.h": "namespace frond { int entry(); }\n",
    "main.cpp":
      '#include "frond_trace.h"\nnamespace frond {\nstatic Private helper();\nint entry();\nint later();\nint later() { return 1; }\n}\nint main() { return frond::entry() == 3 ? 0 : 1; }\n',
    "frond_trace.cpp":
      '#include "frond_trace.h"\nnamespace frond {\nstruct Private { int value; };\nstatic Private helper() { return {3}; }\nint entry() { return helper().value; }\n}\n',
  };
  const declarations = [
    {
      id: "helper",
      action: "remove-generated-declaration",
      selector: { scope: "frond", declarator: "staticPrivatehelper()", definition: false },
    },
    {
      id: "entry",
      action: "remove-generated-declaration",
      selector: { scope: "frond", declarator: "intentry()", definition: false },
    },
    {
      id: "later",
      action: "remove-generated-declaration",
      selector: { scope: "frond", declarator: "intlater()", definition: false },
    },
  ];
  try {
    const broken = path.join(root, "broken");
    await writeTree(broken, tree);
    assert.throws(() =>
      execFileSync("clang++", ["-std=c++17", "-fsyntax-only", path.join(broken, "main.cpp")], {
        stdio: "pipe",
      }),
    );
    const cleanup = coherentModuleCleanup(tree, "frond_trace.cpp", declarations);
    assert.deepEqual(
      cleanup.map(({ id, file }) => ({ id, file })),
      [
        { id: "helper", file: "main.cpp" },
        { id: "entry", file: "main.cpp" },
      ],
    );
    let current = tree;
    for (const request of cleanup) current = applyCoherentStructure(current, request);
    assert.equal(current["frond_trace.h"], tree["frond_trace.h"]);
    assert.equal(current["frond_trace.cpp"], tree["frond_trace.cpp"]);
    assert.match(current["main.cpp"], /int later\(\);/);
    const fixed = path.join(root, "fixed");
    await writeTree(fixed, current);
    const binary = path.join(root, "program");
    execFileSync("clang++", [
      "-std=c++17",
      path.join(fixed, "main.cpp"),
      path.join(fixed, "frond_trace.cpp"),
      "-o",
      binary,
    ]);
    execFileSync(binary);
    assert.throws(
      () => coherentModuleCleanup(current, "frond_trace.cpp", declarations),
      /temporary declaration/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("temporary declarations that travel with a conditional module are removed from that owner, never the public header", () => {
  const tree = {
    "main.cpp": "int main() { return 0; }\n",
    "frond_bvh.h": "namespace frond { bool supported(); }\n",
    "frond_bvh.cpp":
      "namespace frond {\n#ifdef FEATURE\nbool supported();\nbool supported() { return false; }\n#endif\n}\n",
  };
  const request = {
    action: "remove-generated-declaration",
    file: "frond_bvh.cpp",
    selector: { scope: "frond", declarator: "boolsupported()", definition: false },
  };
  const result = applyCoherentStructure(tree, request);
  assert.equal(result["frond_bvh.h"], tree["frond_bvh.h"]);
  assert.equal(result["main.cpp"], tree["main.cpp"]);
  assert.equal(result["frond_bvh.cpp"], tree["frond_bvh.cpp"].replace("bool supported();", ""));
  assert.throws(() => applyCoherentStructure(result, request), /Missing/);
});
await test("whole-task editing moves only delivered module owners and keeps successful bound edits when a later owner is rejected", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-executor-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "executor");
  const initial = {
    "main.cpp": `#ifndef FROND_MATH_H
#define FROND_MATH_H
namespace frond { int first(int value); int second(int value); }
#endif
namespace frond {
int first(int value) { const char* text = "value"; return value + (text[0] == 'x'); }
int second(int value) { return value + 1; }
}
int main() { return frond::first(0); }
`,
  };
  await writeTree(workspace, initial);
  await prepareCoherentExecutor(tools);
  let executor;
  try {
    executor = fullExecutor(workspace, tools);
    await executor.deliver({
      id: "interfaces",
      operations: [
        {
          id: "header",
          phase: "structure",
          action: "header",
          file: "frond_math.h",
          guard: "FROND_MATH_H",
          includes: [],
        },
      ],
    });
    executor.close();
    executor = fullExecutor(workspace, tools);
    const moved = await executor.deliver({
      id: "module",
      operations: [
        {
          id: "first",
          phase: "structure",
          action: "implementation",
          file: "frond_math.cpp",
          includes: [{ file: "frond_math.h", quoted: true }],
          targets: [
            { selector: { scope: "frond", declarator: "intfirst(intvalue)", definition: true } },
            { selector: { scope: "frond", declarator: "intsecond(intvalue)", definition: true } },
          ],
        },
      ],
    });
    assert.equal(moved.targetRows, 1);
    const extracted = await readTree(workspace);
    assert.doesNotMatch(extracted["main.cpp"], /return value/);
    assert.match(extracted["frond_math.cpp"], /return value \+ 1/);
    const contract = prepareCoherentContract(extracted);
    assert.equal(evaluateCoherentContract(extracted, contract).status, "pass");
    executor.close();
    executor = fullExecutor(workspace, tools);
    await assert.rejects(
      executor.deliver({
        id: "names",
        operations: [
          {
            id: "rename-first",
            phase: "names",
            category: "locals-parameters",
            selectors: [
              { kind: "function", scope: "frond::first", signature: "int (int)", definition: true },
            ],
            mapping: [{ from: "value", to: "input" }],
          },
          {
            id: "missing-owner",
            phase: "names",
            category: "locals-parameters",
            selectors: [
              {
                kind: "function",
                scope: "frond::missing",
                signature: "int (int)",
                definition: true,
              },
            ],
            mapping: [{ from: "value", to: "other" }],
          },
        ],
      }),
      /Missing current owner/,
    );
    const retained = await readTree(workspace);
    assert.match(retained["frond_math.cpp"], /int first\(int input\)/);
    assert.match(retained["frond_math.cpp"], /"value"/);
    assert.match(retained["frond_math.cpp"], /int second\(int value\)/);
    assert.equal(evaluateCoherentContract(retained, contract).status, "fail");
  } finally {
    executor?.close();
    await rm(root, { recursive: true, force: true });
  }
});
