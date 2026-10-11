import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveObligations } from "../../scripts/multi-agent/experiments/atomic-slice.mjs";
import {
  atomicSlice,
  assertSliceObligations,
} from "../../scripts/multi-agent/experiments/atomic-slice.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  pack,
  treeIdentity,
  writeTree,
  cppTokens,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { renameCategory } from "../../src/suites/explicit-edit-multi-agent/generation/semantic-names.mjs";
import { maskOrigin } from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";

const steps = [
  {
    id: "step-01",
    phase: "structure",
    dependsOn: [],
    prompt: "Move the declaration.",
    adds: [{ key: "declaration", value: { file: "shape.h", name: "buildRect" } }],
    replaces: [],
  },
  {
    id: "step-02",
    phase: "structure",
    dependsOn: ["step-01"],
    prompt: "Move the definition.",
    adds: [{ key: "definition", value: { file: "shape.cpp", name: "buildRect" } }],
    replaces: [],
  },
  {
    id: "step-03",
    phase: "names",
    dependsOn: ["step-02"],
    prompt: "Restore the name.",
    adds: [
      { key: "declaration", value: { file: "shape.h", name: "make_rect" } },
      { key: "definition", value: { file: "shape.cpp", name: "make_rect" } },
    ],
    replaces: ["declaration", "definition"],
  },
];

await test("requests inherit earlier obligations and explicitly replace names without losing ownership", () => {
  const active = resolveObligations(steps);
  assert.equal(active[1].declaration.name, "buildRect");
  assert.deepEqual(active[2], {
    declaration: { file: "shape.h", name: "make_rect" },
    definition: { file: "shape.cpp", name: "make_rect" },
  });
  assert.equal(active[0].definition, undefined);
});

await test("a broken sequence cannot silently drop, contradict or reorder obligations", () => {
  assert.throws(() => resolveObligations([steps[0], steps[0]]), /step/i);
  assert.throws(() => resolveObligations([steps[0], steps[2]]), /step/i);
  assert.throws(() => resolveObligations([{ ...steps[0], dependsOn: ["future"] }]), /dependency/i);
  assert.throws(
    () => resolveObligations([steps[0], { ...steps[1], adds: steps[0].adds }]),
    /replacement/i,
  );
  assert.throws(
    () => resolveObligations([steps[0], { ...steps[1], replaces: ["unknown"] }]),
    /replacement/i,
  );
  assert.throws(() => resolveObligations([{ ...steps[0], prompt: "" }]), /prompt/i);
  assert.throws(
    () => resolveObligations([{ ...steps[0], prompt: "Move to yocto_shape.h." }]),
    /origin/i,
  );
  assert.throws(
    () =>
      resolveObligations([steps[0], { ...steps[1], adds: [steps[1].adds[0], steps[1].adds[0]] }]),
    /duplicate/i,
  );
  assert.throws(
    () => resolveObligations([...steps, { ...steps[1], id: "step-04", dependsOn: ["step-03"] }]),
    /phase/i,
  );
});

await test("the small route moves real definitions before restoring owner-specific names, without changing literals or other overload locals", async () => {
  await mkdir(".tmp", { recursive: true });
  const scratch = await mkdtemp(path.resolve(".tmp/atomic-contract-"));
  try {
    const math = `#ifndef _YOCTO_MATH_H_
#define _YOCTO_MATH_H_
#include <vector>
namespace yocto {
using std::vector;
struct vec4f { float w; };
}
#endif
`;
    const declaration = (name) =>
      `void ${name}(vector<vec4f>& quads, vector<vec4f>& positions, vector<vec4f>& normals, vector<vec4f>& texcoords, int steps = 1, float scale = 1, float uvscale = 1);`;
    const initial = {
      "main.cpp": `#include "yocto_shape.h"
#include <cstdio>
namespace yocto {
vec4f make_rect(int steps) { int scale = steps; return {float(scale)}; }
vec4f make_recty(int steps) { int scale = steps; return make_rect(scale); }
}
int main() {
  std::vector<yocto::vec4f> quads, positions, normals, texcoords;
  yocto::make_recty(quads, positions, normals, texcoords, 2, 3, 4);
  std::printf("%.0f %.0f\\n", quads[0].w, yocto::make_recty(3).w);
}
`,
      "yocto_math.h": math,
      "yocto_shape.h": `#include "yocto_math.h"
namespace yocto {
${declaration("make_rect")}
${declaration("make_recty")}
vec4f make_rect(int steps);
vec4f make_recty(int steps);
}
`,
      "yocto_shape.cpp": `#include "yocto_shape.h"
namespace yocto {
void make_rect(vector<vec4f>& quads, vector<vec4f>& positions, vector<vec4f>& normals, vector<vec4f>& texcoords, int steps, float scale, float uvscale) {
  const char* note = "quads scale make_rect vec4f w";
  float width = steps * scale + uvscale + 0 * note[0];
  quads = {{width}}; positions = quads; normals = quads; texcoords = quads;
}
void make_recty(vector<vec4f>& quads, vector<vec4f>& positions, vector<vec4f>& normals, vector<vec4f>& texcoords, int steps, float scale, float uvscale) {
  make_rect(quads, positions, normals, texcoords, steps, scale, uvscale);
  for (auto& position : positions) position.w += 1;
}
}
`,
    };
    let tree = initial;
    const records = [];
    for (const operation of [
      { kind: "append", source: "yocto_shape.cpp", target: "main.cpp" },
      { kind: "include", source: "yocto_shape.h", target: "main.cpp" },
      { kind: "include", source: "yocto_math.h", target: "main.cpp" },
    ]) {
      const packed = pack(tree, operation);
      tree = packed.tree;
      records.push(packed.record);
    }
    for (const category of ["functions-types", "fields", "locals-parameters"]) {
      const renamed = await renameCategory(tree, category, path.join(scratch, category));
      tree = renamed.tree;
      records.push(renamed.record);
    }
    const masked = maskOrigin(tree);
    tree = masked.tree;
    records.push(masked.record);
    const manifest = {
      initial: treeIdentity(initial),
      final: treeIdentity(tree),
      operations: records,
    };
    const route = await atomicSlice(tree, manifest, path.join(scratch, "route"));
    assert.equal(route.steps.length, 11);
    assert.doesNotMatch(JSON.stringify(route.steps), /yocto/i);
    for (const stage of route.stages) {
      assert.doesNotMatch(JSON.stringify(stage.tree), /yocto/i);
      assert.match(
        Object.values(stage.tree).join("\n"),
        new RegExp(`namespace ${masked.record.name}\\b`),
      );
    }
    assert.equal(route.initial, treeIdentity(tree));
    assert.deepEqual(route.stages[0].tree, tree);
    assert.equal(route.steps.filter((step) => step.phase === "structure").length, 5);
    const structure = route.stages[5].tree;
    assert.deepEqual(
      Object.keys(structure).sort(),
      [
        "main.cpp",
        `${masked.record.name}_math.h`,
        `${masked.record.name}_shape.cpp`,
        `${masked.record.name}_shape.h`,
      ].sort(),
    );
    const before = structure["main.cpp"];
    const after = route.stages[7].tree["main.cpp"];
    // Only void owner variables are restored. The shape-returning wrappers remain renamed.
    assert.equal(before, after);
    for (const [index, stage] of route.stages.entries()) {
      assert.equal(
        cppTokens(Object.values(stage.tree).join("\n")).some((token) =>
          /^\/\/|^\/\*/.test(token.text),
        ),
        false,
      );
      const directory = path.join(scratch, `state-${index}`);
      await writeTree(directory, stage.tree);
      const program = path.join(scratch, `program-${index}`);
      execFileSync("clang++", [
        "-std=c++17",
        ...Object.keys(stage.tree)
          .filter((name) => name.endsWith(".cpp"))
          .map((name) => path.join(directory, name)),
        "-o",
        program,
      ]);
      assert.equal(execFileSync(program, { encoding: "utf8" }), "10 3\n");
    }
    const final = route.stages.at(-1).tree;
    assert.match(
      final[`${masked.record.name}_shape.cpp`],
      /float width = steps \* scale \+ uvscale/,
    );
    assert.match(final[`${masked.record.name}_shape.cpp`], /"quads scale make_rect vec4f w"/);
    assert.match(final[`${masked.record.name}_shape.cpp`], /void make_recty/);
    assert.match(final[`${masked.record.name}_math.h`], /struct vec4f/);
    assert.match(final[`${masked.record.name}_math.h`], /float w/);
    assertSliceObligations(final, route.obligations.at(-1));
    assert.throws(
      () =>
        assertSliceObligations(
          { ...final, [`${masked.record.name}_shape.cpp`]: "" },
          route.obligations.at(-1),
        ),
      /ownership/,
    );
    assert.throws(
      () => assertSliceObligations(route.stages[5].tree, route.obligations[6]),
      /local names/,
    );
    const broken = structuredClone(manifest);
    broken.operations
      .find((record) => record.category === "functions-types")
      .selection.push({
        name: "other",
        role: "function",
        family: "other-family",
        newName: records
          .find((record) => record.category === "functions-types")
          .selection.find((entry) => entry.name === "make_rect").newName,
      });
    await assert.rejects(
      atomicSlice(tree, broken, path.join(scratch, "bad")),
      /unrelated bindings/,
    );
    await assert.rejects(
      atomicSlice({ "main.cpp": tree["main.cpp"] + " " }, manifest, path.join(scratch, "changed")),
      /identity/i,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
