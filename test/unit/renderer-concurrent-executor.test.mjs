import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

await test("global current-owner renames cross real translation units without merging equal private helpers or skipping missing owners", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/concurrent-units-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "executor");
  const before = {
    "frond_api.h":
      "#pragma once\nnamespace frond { struct Box { int value; }; int FnRun(const Box&); int other(const Box&); }\n",
    "frond_a.cpp":
      '#include "frond_api.h"\nnamespace frond { static const int limit = 2; static int helper(int x) { return x + limit; } int FnRun(const Box& b) { return helper(b.value); } }\n',
    "frond_b.cpp":
      '#include "frond_api.h"\nnamespace frond { static const int limit = 3; static int helper(int x) { return x + limit; } int other(const Box& b) { return FnRun(b) + helper(b.value); } }\n',
    "main.cpp":
      '#include "frond_api.h"\nint main() { frond::Box b{1}; return frond::other(b) == 7 ? 0 : 1; }\n',
  };
  let executor;
  try {
    await writeTree(workspace, before);
    const files = Object.keys(before)
      .filter((file) => file.endsWith(".cpp"))
      .map((file) => path.join(workspace, file));
    const program = path.join(root, "program");
    execFileSync("clang++", ["-std=c++17", ...files, "-o", program]);
    execFileSync(program);
    await prepareConcurrentExecutor(tools);
    executor = concurrentExecutor(workspace, tools);
    const receipt = await executor.execute({
      id: "global",
      operations: [
        {
          id: "function",
          phase: "names",
          category: "functions-types",
          mapping: [{ from: "FnRun", to: "run" }],
          selectors: [{ kind: "function", scope: "frond::FnRun" }],
        },
        {
          id: "type",
          phase: "names",
          category: "functions-types",
          mapping: [{ from: "Box", to: "Item" }],
          selectors: [{ kind: "type", scope: "frond::Box" }],
        },
      ],
    });
    const renamed = await readTree(workspace);
    const expected = Object.fromEntries(
      Object.entries(before).map(([file, text]) => [
        file,
        text.replaceAll("FnRun", "run").replaceAll("Box", "Item"),
      ]),
    );
    assert.deepEqual(renamed, expected);
    assert.equal(receipt.committed, treeIdentity(renamed));
    const local = await executor.execute({
      id: "local",
      operations: [
        {
          id: "parameter",
          phase: "names",
          category: "locals-parameters",
          mapping: [{ from: "b", to: "item" }],
          selectors: [
            {
              kind: "function",
              scope: "frond::run",
              signature: "int (const Item &)",
              definition: true,
            },
          ],
        },
      ],
    });
    assert.equal(local.lifetime, receipt.lifetime);
    assert.equal(local.delivered, 2);
    assert.ok(
      !(await readdir(workspace)).some((name) => /^\.renderer-(?:planner-|edit-lock)/.test(name)),
      "An edit receipt must include completion of owned resource cleanup",
    );
    const final = await readTree(workspace);
    assert.equal(
      final["frond_a.cpp"],
      expected["frond_a.cpp"]
        .replace("const Item& b", "const Item& item")
        .replace("helper(b.value)", "helper(item.value)"),
    );
    assert.equal(final["frond_b.cpp"], expected["frond_b.cpp"]);
    execFileSync("clang++", ["-std=c++17", ...files, "-o", program]);
    execFileSync(program);
    await assert.rejects(
      executor.execute({
        id: "absent",
        operations: [
          {
            id: "missing",
            phase: "names",
            category: "functions-types",
            mapping: [{ from: "run", to: "changed" }],
            selectors: [{ kind: "function", scope: "frond::does_not_exist" }],
          },
        ],
      }),
      /Missing current owner/,
    );
    assert.deepEqual(await readTree(workspace), final);
  } finally {
    executor?.close();
    await rm(root, { recursive: true, force: true });
  }
});
