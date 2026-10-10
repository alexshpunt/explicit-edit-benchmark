import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectCandidate } from "../../scripts/multi-agent/experiments/candidate-grader.mjs";
import { GradeFailure } from "../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";

import {
  createSliceContract,
  assertCandidateObligations,
} from "../../scripts/multi-agent/experiments/candidate-obligations.mjs";
import { applyRequest } from "../../src/suites/explicit-edit-multi-agent/reference/scripted-worker.mjs";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

await test("compiled slice obligations accept different formatting and reject cosmetic extraction and bypassed bodies even with identical pixels", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/grader-ownership-"));
  try {
    const header =
      "#ifndef _FROND_MATH_H_\n#define _FROND_MATH_H_\n#include <utility>\nnamespace frond { using std::pair; struct TVec4fType { float fieldWMember; }; inline int size(TVec4fType Arg) { return int(Arg.fieldWMember); } template<class F> void invoke(F fn) { fn(); } }\n#endif\n";
    const initial = {
      "main.cpp": `${header}
#include <fstream>
#include <string>
namespace frond {
using std::pair;
int size(int Arg) { return Arg; }
void func_make_rect_routine(int OldCount);
void create_recty_func(int OldCount);
void func_make_rect_routine(int OldCount) { int OldValue = OldCount; (void)OldValue; }
void create_recty_func(int OldCount) { int OldValue = OldCount; (void)OldValue; }
}
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  frond::invoke([] { int local = 1; (void)local; });
  frond::invoke([] { double other = 2; (void)other; });
  for (int scene = 0; scene < 2; scene++) {
    std::ofstream out(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    for (int i = 0; i < 4096; i++) { float v = float(i % 17 + scene); out.write((char*)&v, 4); }
  }
}
`,
    };
    const inspect = async (name, tree) => {
      const workspace = path.join(temporary, name);
      await writeTree(workspace, tree);
      return inspectCandidate(workspace, path.join(temporary, `${name}-evidence`));
    };
    const original = await inspect("original", initial);
    const lambdaSignatures = (inspection) =>
      [
        ...new Set(
          inspection.declarations
            .filter(
              (item) =>
                item.kind === "FunctionDecl" &&
                item.name === "invoke" &&
                item.definition &&
                item.type.includes("(lambda in "),
            )
            .map((item) => item.type),
        ),
      ].sort();
    assert.equal(lambdaSignatures(original).length, 2);
    for (const { label, leaked } of [
      { label: "path", leaked: { ...initial, "yocto_math.h": "#pragma once\n" } },
      {
        label: "namespace",
        leaked: { "main.cpp": initial["main.cpp"] + "\nnamespace yocto {}\n" },
      },
      {
        label: "guard",
        leaked: { "main.cpp": initial["main.cpp"] + "\n#define _YOCTO_TEST_H_ 1\n" },
      },
      {
        label: "literal",
        leaked: { "main.cpp": initial["main.cpp"] + '\nconst char* origin = "Yocto/GL";\n' },
      },
      {
        label: "spliced",
        leaked: { "main.cpp": initial["main.cpp"] + "\nnamespace yo\\\ncto {}\n" },
      },
      {
        label: "inactive",
        leaked: { "main.cpp": initial["main.cpp"] + "\n#if 0\nnamespace yocto {}\n#endif\n" },
      },
    ]) {
      await assert.rejects(
        inspect(`leak-${label}`, leaked),
        (error) => error.category === "structure" && /origin/i.test(error.message),
      );
    }
    const contract = createSliceContract(initial, original);
    let current = applyRequest(
      initial,
      "Move the complete common math header block guarded by `_FROND_MATH_H_` from `main.cpp` into `frond_math.h`.",
    );
    current["frond_math.h"] = current["frond_math.h"].replace(
      "namespace frond {",
      "namespace frond\n{",
    );
    const active = { "math-module": { file: "frond_math.h" } };
    assert.doesNotThrow(() => assertCandidateObligations(original, {}, contract));
    const extracted = await inspect("extracted", current);
    assert.deepEqual(lambdaSignatures(extracted), lambdaSignatures(original));
    assert.doesNotThrow(() => assertCandidateObligations(extracted, active, contract));
    const cosmetic = {
      ...current,
      "frond_math.h": `#if 0\n${current["frond_math.h"]}\n#endif\n`,
      "main.cpp": header + current["main.cpp"],
    };
    const facade = await inspect("facade", cosmetic);
    assert.deepEqual(facade.pixels, original.pixels);
    assert.throws(() => assertCandidateObligations(facade, active, contract), /Common math/);
    current = applyRequest(
      current,
      "Move the public void overload declaration of frond::func_make_rect_routine (one argument) from main.cpp to frond_shape.h.",
    );
    current = applyRequest(
      current,
      "Move the complete void definition of frond::func_make_rect_routine (void (int)) from main.cpp into frond_shape.cpp.",
    );
    active["make_rect-declaration"] = { file: "frond_shape.h", name: "func_make_rect_routine" };
    active["make_rect-definition"] = { file: "frond_shape.cpp", name: "func_make_rect_routine" };
    const moved = await inspect("moved", current);
    assert.doesNotThrow(() => assertCandidateObligations(moved, active, contract));
    const bypassed = {
      ...current,
      "frond_shape.cpp": current["frond_shape.cpp"].replace(
        "int OldValue = OldCount; (void)OldValue;",
        "",
      ),
    };
    const broken = await inspect("bypassed", bypassed);
    assert.deepEqual(broken.pixels, original.pixels);
    assert.throws(
      () => assertCandidateObligations(broken, active, contract),
      /variable names|body or bound uses/,
    );
    const cached = { ...current };
    cached["main.cpp"] = cached["main.cpp"].replace(
      "for (int i = 0; i < 4096; i++) { float v = float(i % 17 + scene); out.write((char*)&v, 4); }",
      'std::ifstream saved("cached-" + std::to_string(scene)); float v; while (saved >> v) out.write((char*)&v, 4);',
    );
    const cacheWorkspace = path.join(temporary, "cached-renderer");
    await writeTree(cacheWorkspace, cached);
    for (let scene = 0; scene < 2; scene++) {
      const values = Array.from({ length: 4096 }, (_, i) => (i % 17) + scene).join(" ");
      await writeFile(path.join(cacheWorkspace, `cached-${scene}`), values);
    }
    const replay = await inspectCandidate(cacheWorkspace, path.join(temporary, "cached-evidence"));
    assert.deepEqual(replay.pixels, original.pixels);
    assert.throws(() => assertCandidateObligations(replay, active, contract), /Render driver/);
    const changedHelper = {
      ...current,
      "main.cpp": current["main.cpp"].replace(
        "int size(int Arg) { return Arg; }",
        "int size(int Arg) { return 0; }",
      ),
    };
    const helper = await inspect("changed-helper", changedHelper);
    assert.deepEqual(helper.pixels, original.pixels);
    assert.throws(
      () => assertCandidateObligations(helper, active, contract),
      /unrelated implementation/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("candidate inspection records compiled owners, ignores inactive facades and builds fresh in isolation", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/grader-contract-"));
  try {
    const workspace = path.join(temporary, "workspace");
    await mkdir(workspace);
    const secret = path.join(temporary, "secret");
    await writeFile(secret, "not available");
    await writeFile(
      path.join(workspace, "math.h"),
      "#pragma once\nnamespace frond { struct Item { float w; }; template<class T> T identity(T value) { return value; } }\n",
    );
    await writeFile(
      path.join(workspace, "shape.h"),
      '#pragma once\n#include "math.h"\nnamespace frond { void make(int count); }\n',
    );
    await writeFile(
      path.join(workspace, "shape.cpp"),
      '#include "shape.h"\nnamespace frond { void make(int count) { float local = identity(1.5f); (void)local; (void)count; } }\n',
    );
    const program = `#include "shape.h"
#include <fstream>
#include <string>
#include <cstdlib>
#if 0
namespace frond { void facade(int count) {} }
#endif
int main(int argc, char** argv) {
  if (argc != 2 || std::getenv("GRADER_SECRET") || std::ifstream("${secret}").good()) return 1;
  frond::make(frond::identity(2));
  for (int scene = 0; scene < 2; scene++) {
    std::ofstream output(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    for (int i = 0; i < 4096; i++) { float value = float(i % 17 + scene); output.write((char*)&value, sizeof(value)); }
  }
}
`;
    await writeFile(path.join(workspace, "main.cpp"), program);
    await copyFile("/usr/bin/false", path.join(workspace, "renderer"));
    process.env.GRADER_SECRET = "not inherited";
    const result = await inspectCandidate(workspace, path.join(temporary, "first"));
    const definition = result.declarations.find((item) => item.name === "make" && item.definition);
    assert.equal(definition.file, "shape.cpp");
    assert.equal(definition.scope, "frond");
    assert.deepEqual(
      [
        ...new Set(
          result.declarations
            .filter(
              (item) =>
                item.kind === "ParmVarDecl" &&
                item.scope === "frond::identity" &&
                item.name === "value",
            )
            .map((item) => item.ownerType),
        ),
      ].sort(),
      ["T (T)", "float (float)", "int (int)"],
    );
    assert.ok(
      result.declarations.some(
        (item) => item.kind === "FieldDecl" && item.name === "w" && item.file === "math.h",
      ),
    );
    assert.ok(!result.declarations.some((item) => item.name === "facade"));
    assert.equal(result.pixels.length, 2);
    assert.notEqual(result.pixels[0], result.pixels[1]);
    await writeFile(
      path.join(workspace, "main.cpp"),
      program.replace("frond::make(frond::identity(2));", "unknown();"),
    );
    await assert.rejects(
      inspectCandidate(workspace, path.join(temporary, "broken")),
      (error) => error instanceof GradeFailure && error.category === "build",
    );
    await symlink(secret, path.join(workspace, "private-header.h"));
    await assert.rejects(
      inspectCandidate(workspace, path.join(temporary, "linked-secret")),
      (error) =>
        error instanceof GradeFailure &&
        error.category === "structure" &&
        /Unsupported source entry: private-header\.h/.test(error.message),
    );
    await unlink(path.join(workspace, "private-header.h"));
    await writeFile(path.join(workspace, "main.cpp"), program.replace("i % 17 + scene", "0"));
    await assert.rejects(
      inspectCandidate(workspace, path.join(temporary, "constant")),
      (error) =>
        error instanceof GradeFailure &&
        error.category === "behavior" &&
        /Constant replacement image/.test(error.message),
    );
    await writeFile(
      path.join(workspace, "main.cpp"),
      program.replace("i % 17 + scene", "i % 19 + scene"),
    );
    const changedRender = await inspectCandidate(workspace, path.join(temporary, "changed-render"));
    assert.notDeepEqual(changedRender.pixels, result.pixels);
    assert.throws(
      () => assertCandidateObligations(changedRender, {}, { pixels: result.pixels }),
      (error) => error instanceof GradeFailure && error.category === "behavior",
    );
    await writeFile(path.join(workspace, "main.cpp"), `#include "${secret}"\nint main() {}`);
    await assert.rejects(
      inspectCandidate(workspace, path.join(temporary, "include")),
      (error) => error.category === "build" && /file not found/.test(error.message),
    );
  } finally {
    delete process.env.GRADER_SECRET;
    await rm(temporary, { recursive: true, force: true });
  }
});
