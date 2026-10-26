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
  assert.equal(typeof binding.owner?.signature, "string");
  return {
    phase: "repair",
    action: "rename-binding",
    category: "functions-types",
    target: {
      file: binding.file,
      translationUnit: binding.translationUnit,
      identifier,
      name: binding.name,
      role: binding.role,
      scope: binding.scope,
      owner: {
        scope: binding.owner.scope,
        signature: binding.owner.signature,
        definition: binding.owner.definition,
      },
      line: binding.line,
      column: binding.column,
    },
    required: { name: "scale" },
    files: binding.files,
  };
}

for (const unrelatedError of [false, true])
  test(`a fresh function repair recovers an incomplete overload call across translation units (unrelated error: ${unrelatedError})`, async (t) => {
    const initial = {
      "api.h":
        "#pragma once\n// π: Old stays in this comment.\nnamespace api { struct Vec { float value; }; float Old(float x); inline float scale(Vec v) { return v.value; } float read(); float other(); }\nnamespace peer { inline float Old(float x) { return x + 10.0f; } }\n",
      "first.cpp":
        '#include "api.h"\nnamespace api { float read() { const char* text = "Old"; return scale(2.0f) + Old(3.0f) + scale(Vec{4.0f}) + peer::Old(5.0f) + text[0]; } }\n',
      "second.cpp":
        '#include "api.h"\n// Old remains a comment, not a reference.\nnamespace api { float Old(float x) { return x + 1.0f; } float other() { return Old(6.0f) + peer::Old(7.0f) + scale(Vec{8.0f}); } }\n',
      "main.cpp":
        '#include "api.h"\nint unrelated() { return 1; }\nint main() { return static_cast<int>(api::read() + api::other()) + unrelated(); }\n',
    };
    const expected = {
      ...initial,
      "api.h": initial["api.h"].replace("float Old(float x);", "float scale(float x);"),
      "first.cpp": initial["first.cpp"].replace("+ Old(3.0f)", "+ scale(3.0f)"),
      "second.cpp": initial["second.cpp"]
        .replace("float Old(float x)", "float scale(float x)")
        .replace("return Old(6.0f)", "return scale(6.0f)"),
    };
    const candidate = unrelatedError
      ? { ...initial, "main.cpp": initial["main.cpp"].replace("return 1;", "return Missing();") }
      : initial;
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/directed-incomplete-functions-"));
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
        binding.file === "api.h" && binding.role === "function" && binding.scope === "api::Old",
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
    const misplaced = { ...operation, target: { ...operation.target, scope: "peer::Old" } };
    const rejected = await executor.execute({
      id: "wrong-current-function-scope",
      operations: [misplaced],
    });
    assert.equal(rejected.status, "conflict");
    assert.deepEqual(await readTree(workspace), candidate);
    const misnamed = {
      ...operation,
      target: { ...operation.target, name: "Different", scope: "api::Different" },
    };
    const wrongName = await executor.execute({
      id: "wrong-current-function-name",
      operations: [misnamed],
    });
    assert.equal(wrongName.status, "conflict");
    assert.deepEqual(await readTree(workspace), candidate);
    const incompatible = {
      ...operation,
      target: {
        ...operation.target,
        owner: { ...operation.target.owner, signature: "int (int)" },
      },
    };
    const wrongSignature = await executor.execute({
      id: "wrong-current-function-signature",
      operations: [incompatible],
    });
    assert.equal(wrongSignature.status, "conflict");
    assert.deepEqual(await readTree(workspace), candidate);
    const receipt = await executor.execute({
      id: "fresh-current-function",
      operations: [operation],
    });
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
