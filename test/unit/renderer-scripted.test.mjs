import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRequest } from "../../src/suites/explicit-edit-multi-agent/reference/scripted-worker.mjs";
import { prepareScriptedExecutor } from "../../scripts/multi-agent/experiments/scripted-runtime.mjs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runIsolatedRequest } from "../../scripts/multi-agent/experiments/scripted-run.mjs";

await test("header extraction follows nested guards and ignores fake directives inside literals", () => {
  const header =
    '#ifndef _FROND_MATH_H_\n#define _FROND_MATH_H_\n#if ENABLED\nint value;\n#endif\nconst char* text = R"x(\n#endif\n)x";\n#endif\n';
  const source = `int prefix;\n${header}int suffix;`;
  const result = applyRequest(
    { "main.cpp": source },
    "Move the complete common math header block guarded by `_FROND_MATH_H_` from `main.cpp` into `frond_math.h`. Preserve all its current names.",
  );
  assert.equal(result["frond_math.h"], header);
  assert.equal(result["main.cpp"], 'int prefix;\n#include "frond_math.h"\nint suffix;');
});

await test("ordinary moves and variable edits keep other overloads and protected literals unchanged", () => {
  const declaration = "void makeShape(int ArgSteps);";
  const definition =
    'void makeShape(int StepsArg) { int LocalCount = StepsArg; const char* note = "StepsArg } LocalCount"; }';
  let tree = {
    "main.cpp": `namespace frond {\n${declaration}\nint makeShape(int StepsArg) { return StepsArg; }\n${definition}\n}`,
    "frond_math.h": "",
  };
  tree = applyRequest(
    tree,
    "Move the public void overload declaration of frond::makeShape (one argument) from main.cpp to frond_shape.h. Keep its existing names.",
  );
  assert.match(tree["frond_shape.h"], /void makeShape\(int ArgSteps\);/);
  tree = applyRequest(
    tree,
    "Move the complete void definition of frond::makeShape (void (int)) from main.cpp into frond_shape.cpp. Keep its body.",
  );
  assert.match(tree["frond_shape.cpp"], /StepsArg/);
  assert.doesNotMatch(tree["main.cpp"], /void makeShape.*\{/);
  tree = applyRequest(
    tree,
    "In the void overload of frond::makeShape, restore these parameter and local names, including its declarations and all uses bound to those variables: ArgSteps -> steps; StepsArg -> steps; LocalCount -> count. Do not rename variables in other functions.",
  );
  assert.match(tree["main.cpp"], /int makeShape\(int StepsArg\) \{ return StepsArg; \}/);
  assert.match(tree["frond_shape.cpp"], /int count = steps/);
  assert.match(tree["frond_shape.cpp"], /"StepsArg } LocalCount"/);
  assert.match(tree["frond_shape.h"], /int steps/);
  assert.throws(
    () => applyRequest(tree, "Restore the whole overload family frond::unknown to known."),
    /Missing/,
  );
  assert.throws(() => applyRequest(tree, "Replace the workspace with the answer."), /Unsupported/);
});

await test("incomplete or ambiguous extraction is rejected before the input tree changes", () => {
  const original = { "main.cpp": "#ifndef _FROND_MATH_H_\nint x;\n" };
  const copy = structuredClone(original);
  assert.throws(
    () =>
      applyRequest(
        original,
        "Move the complete common math header block guarded by `_FROND_MATH_H_` from `main.cpp` into `frond_math.h`.",
      ),
    /guard/,
  );
  assert.deepEqual(original, copy);
  const duplicate = {
    "main.cpp":
      "namespace frond { void create(int x); void create(int x) {} void create(int y) {} }",
    "frond_math.h": "",
  };
  assert.throws(
    () =>
      applyRequest(
        duplicate,
        "Move the complete void definition of frond::create (void (int)) from main.cpp into frond_shape.cpp.",
      ),
    /ambiguous/i,
  );
});

await test("the isolated worker cannot see answers, host files or secrets, and keeps one workspace", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/scripted-isolation-"));
  try {
    const workspace = path.join(temporary, "workspace");
    const executor = path.join(temporary, "executor");
    await mkdir(workspace);
    await mkdir(path.join(executor, "reference"), { recursive: true });
    await writeFile(path.join(temporary, "future.json"), "private answers");
    await writeFile(path.join(workspace, "sentinel"), "preserve me");
    await symlink(path.join(temporary, "future.json"), path.join(workspace, "future-link"));
    await writeFile(
      path.join(executor, "reference/scripted-worker.mjs"),
      `
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const forbidden = input.trim();
assert.deepEqual(Object.keys(process.env).sort(), ["HOME", "PATH", "PWD"]);
assert.equal(process.env.PWD, "/workspace");
for (const file of [forbidden, "/workspace/future-link", "/executor/operations.json", "/executor/generator.mjs", "/root", "/workspace/../future.json"])
  await assert.rejects(readFile(file));
await assert.rejects(writeFile("/executor/changed", "no"));
assert.throws(() => execFileSync("/usr/bin/node", ["--input-type=module", "-e", 'import { readFileSync } from "node:fs"; readFileSync(process.argv[1]);', forbidden], { stdio: "pipe" }));
let count = 0;
try { count = Number(await readFile("/workspace/count", "utf8")); } catch {}
await writeFile("/workspace/count", String(count + 1));
console.log(count + 1);
`,
    );
    const forbidden = path.join(temporary, "future.json");
    assert.equal((await runIsolatedRequest(workspace, executor, forbidden)).stdout.trim(), "1");
    assert.equal((await runIsolatedRequest(workspace, executor, forbidden)).stdout.trim(), "2");
    assert.equal(await readFile(path.join(workspace, "sentinel"), "utf8"), "preserve me");
    await writeFile(
      path.join(executor, "reference/scripted-worker.mjs"),
      'throw new Error("stop this request");',
    );
    await assert.rejects(runIsolatedRequest(workspace, executor, "anything"), /stop this request/);
    assert.equal(await readFile(path.join(workspace, "count"), "utf8"), "2");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("the real worker performs successive ordinary edits in the isolated current project", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/scripted-worker-"));
  try {
    const workspace = path.join(temporary, "workspace");
    const executor = path.join(temporary, "executor");
    await mkdir(workspace);
    await prepareScriptedExecutor(executor);
    await writeFile(
      path.join(workspace, "main.cpp"),
      "namespace frond { void create(int n); void create(int n) {} }",
    );
    await writeFile(path.join(workspace, "frond_math.h"), "#pragma once\n");
    await writeFile(path.join(workspace, "sentinel"), "keep");
    await runIsolatedRequest(
      workspace,
      executor,
      "Move the public void overload declaration of frond::create (int) from main.cpp to frond_shape.h.",
    );
    await runIsolatedRequest(
      workspace,
      executor,
      "Move the complete void definition of frond::create (void (int)) from main.cpp into frond_shape.cpp.",
    );
    assert.match(
      await readFile(path.join(workspace, "frond_shape.h"), "utf8"),
      /void create\(int n\);/,
    );
    assert.match(
      await readFile(path.join(workspace, "frond_shape.cpp"), "utf8"),
      /void create\(int n\) \{\}/,
    );
    assert.doesNotMatch(await readFile(path.join(workspace, "main.cpp"), "utf8"), /void create/);
    assert.equal(await readFile(path.join(workspace, "sentinel"), "utf8"), "keep");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
