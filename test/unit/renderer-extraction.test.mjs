import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  pack,
  treeIdentity,
  writeTree,
  compactBlankLines,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { maskOrigin } from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import { headerRestoration } from "../../src/suites/explicit-edit-multi-agent/tasks/restoration-extraction.mjs";
import { applyRequest } from "../../src/suites/explicit-edit-multi-agent/reference/scripted-worker.mjs";
import {
  includeDirectives,
  withoutBlankLayoutLines,
} from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import { runBatchedRequestChain } from "../../src/suites/explicit-edit-multi-agent/tasks/request-batches.mjs";

await test("direct include requirements ignore fake directives in literals, comments and continued macros", () => {
  const source = [
    '#include "first.h"',
    'const char* note = R"(',
    '#include "literal.h"',
    ')";',
    "/*",
    '#include "comment.h"',
    "*/",
    "#define BODY \\",
    '#include "macro.h"',
    "#include <vector>",
    '#include "last.h"',
    "",
  ].join("\n");
  assert.deepEqual(
    includeDirectives(source).map(({ file, quoted }) => ({ file, quoted })),
    [
      { file: "first.h", quoted: true },
      { file: "vector", quoted: false },
      { file: "last.h", quoted: true },
    ],
  );
});

await test("header comparison ignores only layout gaps, not raw-string contents or macro terminators", () => {
  assert.equal(withoutBlankLayoutLines("int a;\n\nint b;\n"), "int a;\nint b;\n");
  const raw = 'const char* s = R"(a\n\nb)";\n';
  assert.equal(withoutBlankLayoutLines(raw), raw);
  assert.notEqual(
    withoutBlankLayoutLines(raw),
    withoutBlankLayoutLines(raw.replace("a\n\n", "a\n")),
  );
  const macro = "#define VALUE \\\n\nint a;\n";
  assert.equal(withoutBlankLayoutLines(macro), macro);
  assert.notEqual(withoutBlankLayoutLines("int a;\n"), withoutBlankLayoutLines("int b;\n"));
});

function fixture() {
  const original = {
    "main.cpp": '#include "yocto_shape.h"\nint main() { return yocto::measure() == 3 ? 0 : 1; }',
    "yocto_math.h":
      "#ifndef _YOCTO_MATH_H_\n#define _YOCTO_MATH_H_\nnamespace yocto { inline int width() { return 3; } }\n#endif",
    "yocto_geometry.h":
      '#ifndef _YOCTO_GEOMETRY_H_\n#define _YOCTO_GEOMETRY_H_\n#include "yocto_math.h"\n#endif',
    "yocto_shape.h":
      '#ifndef _YOCTO_SHAPE_H_\n#define _YOCTO_SHAPE_H_\n#include "yocto_geometry.h"\n#include "yocto_math.h"\n#if 0\ninline const char* note = R"(\n#ifndef FAKE\n#endif\n)";\n#endif\nnamespace yocto { int measure(); }\n#endif',
    "yocto_shape.cpp":
      '#include "yocto_shape.h"\nnamespace yocto { int measure() { return width(); } }',
  };
  let payload = original;
  const operations = [];
  for (const operation of [
    { kind: "append", source: "yocto_shape.cpp", target: "main.cpp" },
    { kind: "include", source: "yocto_shape.h", target: "main.cpp" },
    { kind: "include", source: "yocto_geometry.h", target: "main.cpp" },
    { kind: "include", source: "yocto_math.h", target: "main.cpp" },
  ]) {
    const result = pack(payload, operation);
    payload = result.tree;
    operations.push(result.record);
  }
  const masked = maskOrigin(payload, { name: "frond" });
  payload = masked.tree;
  operations.push(masked.record);
  return {
    payload,
    manifest: { initial: treeIdentity(original), final: treeIdentity(payload), operations },
  };
}

await test("public header tasks extract current nested blocks before names, and compile only at the batch boundary", async () => {
  const { payload, manifest } = fixture();
  const plan = headerRestoration(payload, manifest);
  assert.equal(plan.requests.length, 3);
  assert.deepEqual(plan.pendingSources, ["frond_shape.cpp"]);
  assert.deepEqual(plan, headerRestoration(payload, structuredClone(manifest)));
  assert.doesNotMatch(
    JSON.stringify(plan.requests),
    /yocto|offset|sourceStart|sourceLength|sourceHash/i,
  );
  assert.deepEqual(
    plan.requests.map((request) => request.file),
    ["frond_math.h", "frond_geometry.h", "frond_shape.h"],
  );
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/header-batch-"));
  let current = plan.initial;
  let graded = 0;
  try {
    const result = await runBatchedRequestChain(plan.requests, {
      identity: () => treeIdentity(current),
      execute: async ({ prompt, index }) => {
        current = compactBlankLines(applyRequest(current, prompt)).tree;
        const expected = plan.stages[index].tree;
        assert.deepEqual(Object.keys(current).sort(), Object.keys(expected).sort());
        for (const file of Object.keys(current).filter((name) => name !== "main.cpp"))
          assert.equal(current[file], expected[file]);
        assert.ok(current["main.cpp"].includes(`#include "${plan.requests[index].file}"`));
      },
      grade: async () => {
        graded++;
        const workspace = path.join(root, "workspace");
        await writeTree(workspace, current);
        execFileSync("clang++", [
          "-std=c++17",
          path.join(workspace, "main.cpp"),
          "-o",
          path.join(root, "program"),
        ]);
        execFileSync(path.join(root, "program"));
        return { status: "pass" };
      },
    });
    assert.equal(result.status, "pass", JSON.stringify(result.batchReport.terminal));
    assert.equal(result.passedRequests, 3);
    assert.equal(graded, 1);
    assert.deepEqual(plan.requests.at(-1).includes, ["frond_geometry.h", "frond_math.h"]);
    assert.match(current["frond_shape.h"], /#include "frond_math.h"/);
    assert.match(current["frond_shape.h"], /#ifndef FAKE/);
    assert.ok(!current["main.cpp"].includes("int measure();"));
    assert.match(current["main.cpp"], /int measure\(\) \{ return width\(\); \}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("header tasks reject changed payloads, ambiguous guards and implementation bodies instead of hiding uncovered work", () => {
  const { payload, manifest } = fixture();
  assert.throws(
    () => headerRestoration({ "main.cpp": payload["main.cpp"] + " " }, manifest),
    /identity/i,
  );
  const plan = headerRestoration(payload, manifest);
  const duplicate = {
    "main.cpp":
      plan.initial["main.cpp"] + "\n#ifndef _FROND_MATH_H_\n#define _FROND_MATH_H_\n#endif",
  };
  assert.throws(() => applyRequest(duplicate, plan.requests[0].prompt), /ambiguous/i);
  assert.deepEqual(
    plan.pendingSources,
    ["frond_shape.cpp"],
    "Implementation extraction is explicitly pending, not counted as complete",
  );
});
