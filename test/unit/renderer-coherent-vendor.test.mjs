import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { coherentStructureTasks } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

const file = "support/stb_image/stb_image_resize.h";
const macro = "STB_IMAGE_RESIZE_IMPLEMENTATION";
const guard = "STBIR_INCLUDE_STB_IMAGE_RESIZE_H";
const declarations = (name) => `#ifndef ${guard}
#define ${guard}
#ifdef __cplusplus
extern "C" {
#endif
int ${name}(int arg);
#ifdef __cplusplus
}
#endif
#endif
`;
const implementation = (name) => `#ifdef ${macro}
#ifdef __cplusplus
extern "C" {
#endif
#ifdef FEATURE
int ${name}(int arg) { const char* text = "ResizeBound Discarded"; return arg + 2 + (text[0] == 'x'); }
#else
int ${name}(int arg) { return arg + 2; }
#endif
#ifdef __cplusplus
}
#endif
#endif
`;
const firstDeclarations = declarations("ResizeBound");
const firstImplementation = implementation("Discarded");
const secondDeclarations = declarations("Discarded");
const secondImplementation = implementation("ResizeBound");
const entry = "int main() { return ResizeBound(3) == 5 ? 0 : 1; }\n";
const initial = {
  "main.cpp":
    firstDeclarations +
    firstImplementation +
    `#define ${macro}\n` +
    secondDeclarations +
    secondImplementation +
    entry,
};
const selected = {
  action: "vendor-header",
  file,
  guard,
  macro,
  declarationsCopy: 1,
  implementationCopy: 2,
};
const activate = { action: "vendor-implementation", macro, file: "support/stb.cpp" };
const expected = {
  "main.cpp": `#include "${file}"\n${entry}`,
  [file]: firstDeclarations + "\n" + secondImplementation,
  "support/stb.cpp": `#define ${macro}\n#include "stb_image/stb_image_resize.h"\n`,
};

await test("coherent vendor selectors specify the two retained sections and reject missing or contradictory copy selection", () => {
  const requests = [
    { id: "header", phase: "structure", action: "vendor-header", file, guard, macro },
    { id: "implementation", phase: "structure", action: "vendor-implementation", macro },
    { id: "cleanup", phase: "structure", action: "cleanup-empty-namespaces", includes: [] },
  ];
  const task = coherentStructureTasks(requests).find((item) => item.subsystem === "image-resize");
  assert.equal(task.operations[0].declarationsCopy, 1);
  assert.equal(task.operations[0].implementationCopy, 2);
  assert.equal(task.operations[1].file, "support/stb.cpp");
  const actual = task.operations.reduce(applyCoherentStructure, initial);
  assert.equal(actual[file], expected[file]);
  assert.equal(evaluateCoherentContract(actual, prepareCoherentContract(expected)).status, "pass");
  for (const request of [
    { ...selected, declarationsCopy: undefined },
    { ...selected, declarationsCopy: 2 },
    { ...selected, implementationCopy: 1 },
  ])
    assert.throws(() => applyCoherentStructure(initial, request), /copy selection/i);
  const extracted = applyCoherentStructure(initial, selected);
  assert.throws(
    () => applyCoherentStructure(extracted, { ...activate, file: "main.cpp" }),
    /activation file/i,
  );
  assert.equal(initial["main.cpp"].includes(firstImplementation), true);
});

await test("one merged vendor header keeps the selected code and inactive branches through real separate compilation", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-vendor-"));
  try {
    const actual = [selected, activate].reduce(applyCoherentStructure, initial);
    assert.equal(actual[file], expected[file]);
    const contract = prepareCoherentContract(expected);
    assert.equal(evaluateCoherentContract(actual, contract).status, "pass");
    const formatted = { ...actual, [file]: actual[file].replace("int arg", "int  arg") };
    assert.equal(evaluateCoherentContract(formatted, contract).status, "pass");
    for (const [index, tree] of [actual, formatted].entries()) {
      const workspace = path.join(root, `source-${index}`);
      await writeTree(workspace, tree);
      for (const feature of [false, true]) {
        const program = path.join(root, `program-${index}-${feature}`);
        execFileSync("clang++", [
          "-std=c++17",
          ...(feature ? ["-DFEATURE"] : []),
          path.join(workspace, "main.cpp"),
          path.join(workspace, "support/stb.cpp"),
          "-o",
          program,
        ]);
        execFileSync(program);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("vendor preservation rejects redundant copies, wrong sections, changed literals and inactive bodies even when the active program still works", async () => {
  const contract = prepareCoherentContract(expected);
  const changedInactive = {
    ...expected,
    [file]: expected[file].replace("return arg + 2;", "return arg + 9;"),
  };
  const candidates = [
    { ...expected, [file]: expected[file] + firstImplementation + secondDeclarations },
    { ...expected, [file]: secondDeclarations + "\n" + firstImplementation },
    { ...expected, [file]: expected[file].replace('"ResizeBound Discarded"', '"changed"') },
    changedInactive,
    {
      ...expected,
      [file]: expected[file].replace("#else\nint ResizeBound(int arg) { return arg + 2; }\n", ""),
    },
    { ...expected, [file]: `#if 1\n${expected[file]}#endif\n` },
    { ...expected, "main.cpp": `#define ${macro}\n${expected["main.cpp"]}`, "support/stb.cpp": "" },
  ];
  for (const tree of candidates) {
    const result = evaluateCoherentContract(tree, contract);
    assert.equal(result.status, "fail");
    assert.ok(result.obligations.some((item) => item.status === "fail"));
  }
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-vendor-negative-"));
  try {
    const workspace = path.join(root, "source");
    await writeTree(workspace, changedInactive);
    const program = path.join(root, "program");
    execFileSync("clang++", [
      "-std=c++17",
      "-DFEATURE",
      path.join(workspace, "main.cpp"),
      path.join(workspace, "support/stb.cpp"),
      "-o",
      program,
    ]);
    execFileSync(program);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
