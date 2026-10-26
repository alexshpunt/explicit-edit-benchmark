import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const identifiers = (source) =>
  cppTokens(source).filter((token) => /^[A-Za-z_]\w*$/.test(token.text));
const at = (source, marker, name) => {
  const begin = source.indexOf(marker),
    nameOffset = marker.indexOf(name);
  assert.ok(begin >= 0 && nameOffset >= 0);
  const start = begin + nameOffset;
  const identifier = identifiers(source).findIndex((token) => token.start === start);
  assert.ok(identifier >= 0);
  return identifier;
};
const rename = (source, marker, name, to, role = "variable") => ({
  phase: "repair",
  action: "rename-binding",
  target: {
    file: "main.cpp",
    translationUnit: "main.cpp",
    identifier: at(source, marker, name),
    name,
    role,
  },
  required: { name: to },
  files: ["main.cpp"],
});
async function fixture(t, tree) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/directed-reference-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "tools");
  await writeTree(workspace, tree);
  await prepareConcurrentExecutor(tools);
  const executor = concurrentExecutor(workspace, tools, { signal: t.signal });
  t.after(async () => {
    await executor.close();
    await rm(root, { recursive: true, force: true });
  });
  return { executor, read: () => readTree(workspace) };
}

test("fresh repair declarations keep their ordinal while a function and its bound parameters change", async (t) => {
  const source =
    "int Old(int Left, int Right) { return Left + Right; }\nint main() { return Old(1, 2); }\n";
  const current = await fixture(t, { "main.cpp": source });
  const operations = [
    rename(source, "int Old(", "Old", "chosen", "function"),
    rename(source, "int Left,", "Left", "left"),
    rename(source, "int Right)", "Right", "right"),
  ];
  const receipts = await current.executor.executeBatch(
    operations.map((operation, id) => ({ id: `problem-${id}`, operations: [operation] })),
  );
  assert.ok(receipts.every((receipt) => receipt.status === "edited"));
  assert.deepEqual(await current.read(), {
    "main.cpp":
      "int chosen(int left, int right) { return left + right; }\nint main() { return chosen(1, 2); }\n",
  });
});

test("a declaration repair selects one compiler binding among same-spelling local shadows", async (t) => {
  const source =
    "int f() { int total = 0; { int value = 1; total += value; } { int value = 2; total += value; } return total; }\n";
  const current = await fixture(t, { "main.cpp": source });
  const operation = rename(source, "int value = 2", "value", "second");
  const receipt = await current.executor.execute({ id: "second-shadow", operations: [operation] });
  assert.equal(receipt.status, "edited");
  assert.deepEqual(await current.read(), {
    "main.cpp": source.replace("int value = 2; total += value", "int second = 2; total += second"),
  });
});

test("an inspect conflict does not block a located unresolved-identifier repair in the same delivery", async (t) => {
  const source = "int restored() { return 1; }\nint main() { return old_call(); }\n";
  const current = await fixture(t, { "main.cpp": source });
  const operations = [
    { phase: "repair", action: "inspect", target: { file: "main.cpp" }, files: ["main.cpp"] },
    {
      phase: "repair",
      action: "replace-identifier",
      target: {
        file: "main.cpp",
        identifier: at(source, "old_call()", "old_call"),
        name: "old_call",
      },
      required: { name: "restored" },
      files: ["main.cpp"],
    },
  ];
  const receipts = await current.executor.executeBatch(
    operations.map((operation, id) => ({ id: `diagnostic-${id}`, operations: [operation] })),
  );
  assert.equal(receipts[0].status, "conflict");
  assert.equal(receipts[1].status, "edited");
  assert.deepEqual(await current.read(), {
    "main.cpp": source.replace("old_call()", "restored()"),
  });
});

for (const duplicate of [false, true])
  test(`a directed move uses the current global identity and preserves an existing destination (${duplicate})`, async (t) => {
    const initial = {
      "api.h": "#pragma once\nextern int restored;\n",
      "main.cpp": '#include "api.h"\nint restored = 1;\nint peer() { return 2; }\n',
      "part.cpp": '#include "api.h"\n' + (duplicate ? "int restored = 8;\n" : ""),
    };
    const current = await fixture(t, initial);
    const receipt = await current.executor.execute({
      id: "wrong-owner",
      operations: [
        {
          phase: "repair",
          action: "move-declaration",
          target: {
            file: "main.cpp",
            name: "restored",
            role: "variable",
            translationUnit: "main.cpp",
          },
          required: {
            file: "part.cpp",
            qualifiedName: "restored",
            scope: "::",
            name: "restored",
            kind: "variable",
            definition: true,
          },
          setup: { includes: [{ file: "api.h", quoted: true }] },
          files: ["main.cpp", "part.cpp"],
        },
      ],
    });
    assert.equal(receipt.status, "edited");
    const tree = await current.read();
    assert.equal(tree["main.cpp"].includes("int restored = 1;"), false);
    assert.equal(tree["main.cpp"].includes("return 2;"), true);
    assert.equal(tree["part.cpp"].match(/int restored = /g)?.length, 1);
    assert.ok(tree["part.cpp"].includes(duplicate ? "int restored = 8;" : "int restored = 1;"));
  });

test("two pure local declaration repairs reuse the current private compiler snapshot", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/directed-cache-"));
  const planner = currentNamingPlanner(directory, { signal: t.signal, maxViews: 1 });
  t.after(async () => {
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  const source = "int f(int Left, int Right) { return Left + Right; }\n";
  const before = { "main.cpp": source };
  const first = await planner.repair(before, rename(source, "int Left,", "Left", "left"));
  planner.acknowledge(before, first.after);
  const second = await planner.repair(first.after, rename(source, "int Right)", "Right", "right"));
  assert.equal(second.statistics.snapshotAttempts, first.statistics.snapshotAttempts);
  assert.ok(second.statistics.cacheHits > first.statistics.cacheHits);
  planner.acknowledge(first.after, second.after);
  assert.deepEqual(second.after, {
    "main.cpp": "int f(int left, int right) { return left + right; }\n",
  });
});

test("a fresh header-parameter repair handles enum definitions without changing the independent body binding", async (t) => {
  const header = "#pragma once\nenum class Mode { off, on };\nint f(int Arg);\n";
  const body = '#include "api.h"\nint f(int Arg) { return Arg; }\n';
  const initial = {
    "api.h": header,
    "main.cpp": '#include "api.h"\nint main() { return f(1); }\n',
    "part.cpp": body,
  };
  const current = await fixture(t, initial);
  const operation = {
    phase: "repair",
    action: "rename-binding",
    category: "locals-parameters",
    target: {
      file: "api.h",
      translationUnit: "part.cpp",
      identifier: at(header, "int Arg)", "Arg"),
      name: "Arg",
      role: "variable",
      scope: "f::Arg",
      owner: { scope: "f", signature: "int (int)", definition: false },
    },
    required: { name: "argument" },
    files: ["api.h"],
  };
  const receipt = await current.executor.execute({
    id: "current-header-parameter",
    operations: [operation],
  });
  assert.equal(receipt.status, "edited");
  assert.deepEqual(await current.read(), {
    ...initial,
    "api.h": header.replace("int Arg", "int argument"),
  });
});

test("invalid current identifier ordinals remain conflicts and never rename another token", async (t) => {
  const initial = { "main.cpp": "int f(int Arg) { return Arg; }\n" };
  const current = await fixture(t, initial);
  const requests = ["rename-binding", "replace-identifier"].flatMap((action) =>
    [-1, Number.MAX_SAFE_INTEGER].map((identifier) => ({
      id: `${action}-${identifier}`,
      operations: [
        {
          phase: "repair",
          action,
          target: {
            file: "main.cpp",
            translationUnit: "main.cpp",
            identifier,
            name: "Arg",
            role: "variable",
          },
          required: { name: "argument" },
          files: ["main.cpp"],
        },
      ],
    })),
  );
  const receipts = await current.executor.executeBatch(requests);
  assert.equal(receipts.length, requests.length);
  assert.ok(receipts.every((receipt) => receipt.status === "conflict"));
  assert.deepEqual(await current.read(), initial);
});
