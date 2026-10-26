import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { byteToCharacter } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-offsets.mjs";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { prepareBarrierSymbolMap } from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";
import { diagnoseRepairRequirements } from "../../src/suites/explicit-edit-multi-agent/grading/repair-requirements.mjs";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";

function currentRepair(tree, binding, name) {
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
      owner: {
        scope: binding.owner.scope,
        signature: binding.owner.signature,
        definition: binding.owner.definition,
      },
      line: binding.line,
      column: binding.column,
    },
    required: { name },
    files: [binding.file],
  };
}

test("fresh lambda repairs select each parameter and local by its actual compiler location", async (t) => {
  const first =
    "  auto first = [](int FirstArg) { int FirstLocal = FirstArg + 3; return FirstLocal; };";
  const second =
    "  auto second = [](int SecondArg) { int SecondLocal = SecondArg + 7; return SecondLocal; };";
  const tree = {
    "api.h": "#pragma once\nnamespace api { int inspect(int FirstArg); int peer(int FirstArg); }\n",
    "main.cpp": '#include "api.h"\nint main() { return api::inspect(1) + api::peer(2); }\n',
    "part.cpp": [
      '#include "api.h"',
      "// π keeps compiler byte positions distinct from JavaScript positions.",
      "namespace api {",
      "int inspect(int Input) {",
      first,
      second,
      "  return first(Input) + second(Input);",
      "}",
      "int peer(int FirstArg) { int FirstLocal = FirstArg + 11; return FirstLocal; }",
      "}",
      "",
    ].join("\n"),
  };
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/directed-lambda-repair-"));
  const workspace = path.join(root, "workspace");
  const tools = path.join(root, "tools");
  let executor;
  t.after(async () => {
    await executor?.close();
    await rm(root, { recursive: true, force: true });
  });
  const { bindings } = await prepareBarrierSymbolMap(tree, {
    evidence: path.join(root, "current-facts"),
  });
  const requests = [
    ["FirstArg", "input"],
    ["FirstLocal", "value"],
    ["SecondArg", "input"],
    ["SecondLocal", "value"],
  ].map(([name, required], index) => {
    const matches = bindings.filter(
      (binding) =>
        binding.file === "part.cpp" &&
        binding.role === "variable" &&
        binding.name === name &&
        binding.owner?.scope === "api::inspect",
    );
    assert.equal(matches.length, 1);
    const [binding] = matches;
    assert.equal(binding.scope, `api::inspect::operator()::${name}`);
    assert.equal(binding.owner.definition, true);
    const operation = currentRepair(tree, binding, required);
    assert.equal(Object.hasOwn(operation.target, "id"), false);
    assert.equal(Object.hasOwn(operation.target, "offset"), false);
    assert.equal(JSON.stringify(operation).includes(binding.id), false);
    return { id: `fresh-lambda-problem-${index}`, operations: [operation] };
  });
  await writeTree(workspace, tree);
  await prepareConcurrentExecutor(tools);
  executor = concurrentExecutor(workspace, tools, { signal: t.signal });
  const receipts = await executor.executeBatch(requests);
  assert.deepEqual(
    receipts.map((receipt) => receipt.id),
    requests.map((request) => request.id),
  );
  assert.deepEqual(
    receipts.map((receipt) => receipt.status),
    requests.map(() => "edited"),
    JSON.stringify(
      receipts.map(({ id, status, sourceFailure }) => ({ id, status, sourceFailure })),
    ),
  );
  assert.deepEqual(await readTree(workspace), {
    ...tree,
    "part.cpp": tree["part.cpp"]
      .replace(first, "  auto first = [](int input) { int value = input + 3; return value; };")
      .replace(second, "  auto second = [](int input) { int value = input + 7; return value; };"),
  });
});

test("public callable context spelling does not hide a current template-lambda problem or select a local record", async (t) => {
  const lambda = "auto predicate = +[](T Old) { return Old > 0; };";
  const tree = {
    "api.h":
      "#pragma once\nnamespace api {\ntemplate<typename T> inline bool inspect(T Input) { struct Callback { bool run(T Old) { return Old > 0; } }; " +
      lambda +
      " return predicate(Input) && Callback{}.run(Input); }\n}\n",
    "main.cpp": '#include "api.h"\nint main() { return api::inspect(2); }\n',
  };
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/directed-template-lambda-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "tools");
  let executor;
  t.after(async () => {
    await executor?.close();
    await rm(root, { recursive: true, force: true });
  });
  const { bindings } = await prepareBarrierSymbolMap(tree, {
    evidence: path.join(root, "current-facts"),
  });
  const nodes = [
    {
      id: "public-requirement",
      operations: [
        {
          phase: "names",
          category: "locals-parameters",
          mapping: [{ from: "Old", to: "value" }],
          selectors: [
            {
              kind: "variable",
              scope: "api::inspect::__invoke::Old",
              owner: { scope: "api::inspect", signature: "bool (T)", definition: true },
            },
          ],
        },
      ],
    },
  ];
  const operations = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].target.scope, "api::inspect::operator()::Old");
  assert.equal(JSON.stringify(operations).includes("__invoke"), false);
  assert.equal(Object.hasOwn(operations[0].target, "id"), false);
  assert.equal(Object.hasOwn(operations[0].target, "offset"), false);
  await writeTree(workspace, tree);
  await prepareConcurrentExecutor(tools);
  executor = concurrentExecutor(workspace, tools, { signal: t.signal });
  const receipts = await executor.executeBatch([
    { id: "fresh-template-lambda-problem", operations },
  ]);
  assert.equal(receipts[0].status, "edited", JSON.stringify(receipts));
  assert.deepEqual(await readTree(workspace), {
    ...tree,
    "api.h": tree["api.h"].replace(lambda, "auto predicate = +[](T value) { return value > 0; };"),
  });
});
