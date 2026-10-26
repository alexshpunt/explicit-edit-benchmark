import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { byteToCharacter } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-offsets.mjs";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import { scopedNamingSession } from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  evaluateBarrierSymbolMap,
  prepareBarrierSymbolMap,
} from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";

function repair(tree, binding) {
  const start = byteToCharacter(tree[binding.file])(binding.offset);
  const identifier = cppTokens(tree[binding.file])
    .filter((token) => /^[A-Za-z_]\w*$/.test(token.text))
    .findIndex((token) => token.start === start && token.text === binding.name);
  assert.ok(identifier >= 0);
  return {
    phase: "repair",
    action: "rename-binding",
    category: "locals-parameters",
    target: {
      file: binding.file,
      translationUnit: binding.translationUnit,
      identifier,
      name: binding.name,
      role: binding.role,
      scope: binding.scope,
      line: binding.line,
      column: binding.column,
    },
    required: { name: "limit" },
    files: binding.files,
  };
}

for (const unrelatedError of [false, true])
  test(`a fresh global repair recovers an incomplete candidate across translation units (unrelated error: ${unrelatedError})`, async (t) => {
    const initial = {
      "api.h":
        "#pragma once\n// π: Old stays in this comment.\nnamespace api { constexpr int Old = 7; int read(); int other(); }\nnamespace peer { constexpr int Old = 19; }\n",
      "first.cpp":
        '#include "api.h"\nnamespace api { int read() { const char* text = "Old"; return limit + Old + peer::Old + text[0]; } }\n',
      "second.cpp":
        '#include "api.h"\n// Old remains a comment, not a reference.\nnamespace api { int other() { return Old + peer::Old; } }\n',
      "main.cpp":
        '#include "api.h"\nint unrelated() { return 1; }\nint main() { return api::read() + api::other() + unrelated(); }\n',
    };
    const expected = {
      ...initial,
      "api.h": initial["api.h"].replace("constexpr int Old = 7", "constexpr int limit = 7"),
      "first.cpp": initial["first.cpp"].replace("limit + Old", "limit + limit"),
      "second.cpp": initial["second.cpp"].replace("return Old +", "return limit +"),
    };
    const candidate = unrelatedError
      ? { ...initial, "main.cpp": initial["main.cpp"].replace("return 1;", "return Missing();") }
      : initial;
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/directed-incomplete-globals-"));
    const workspace = path.join(root, "workspace"),
      tools = path.join(root, "tools");
    let executor;
    t.after(async () => {
      await executor?.close();
      await rm(root, { recursive: true, force: true });
    });
    const expectedMap = await prepareBarrierSymbolMap(expected, {
      evidence: path.join(root, "expected"),
    });
    const failed = await evaluateBarrierSymbolMap(candidate, expectedMap, {
      evidence: path.join(root, "before"),
    });
    assert.equal(failed.status, "fail");
    assert.ok(failed.compilerDiagnostics.length > 0);
    const bindings = failed.bindings.filter(
      (binding) =>
        binding.file === "api.h" && binding.role === "variable" && binding.scope === "api::Old",
    );
    assert.equal(bindings.length, 1);
    const operation = repair(candidate, bindings[0]);
    assert.equal(Object.hasOwn(operation.target, "id"), false);
    assert.equal(Object.hasOwn(operation.target, "offset"), false);
    assert.equal(JSON.stringify(operation).includes(bindings[0].id), false);
    const strict = path.join(root, "strict");
    await mkdir(strict);
    await assert.rejects(
      scopedNamingSession(candidate, strict),
      (error) => error.compilerSourceFailure === true,
    );
    await writeTree(workspace, candidate);
    await prepareConcurrentExecutor(tools);
    executor = concurrentExecutor(workspace, tools, { signal: t.signal });
    const local = failed.bindings.find(
      (binding) => binding.file === "first.cpp" && binding.scope === "api::read::text",
    );
    assert.ok(local);
    const localReceipt = await executor.execute({
      id: "local-without-current-owner",
      operations: [repair(candidate, local)],
    });
    assert.equal(localReceipt.status, "conflict");
    assert.deepEqual(await readTree(workspace), candidate);
    const misplaced = { ...operation, target: { ...operation.target, scope: "peer::Old" } };
    const rejected = await executor.execute({
      id: "wrong-current-global-owner",
      operations: [misplaced],
    });
    assert.equal(rejected.status, "conflict");
    assert.deepEqual(await readTree(workspace), candidate);
    const receipt = await executor.execute({ id: "fresh-current-global", operations: [operation] });
    assert.equal(receipt.status, "edited", JSON.stringify(receipt));
    const after = await readTree(workspace);
    assert.deepEqual(after, { ...expected, "main.cpp": candidate["main.cpp"] });
    const graded = await evaluateBarrierSymbolMap(after, expectedMap, {
      evidence: path.join(root, "after"),
    });
    assert.equal(graded.status, unrelatedError ? "fail" : "pass");
    if (unrelatedError) assert.ok(graded.compilerDiagnostics.length > 0);
    else assert.equal(graded.compilerDiagnostics.length, 0);
  });
