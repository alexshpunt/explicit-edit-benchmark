import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  fullExecutor,
  prepareFullExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/full-executor.mjs";
import { prepareCoherentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-executor.mjs";
import { prepareConcurrentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";

async function stagedFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...(await stagedFiles(root, name)));
    else files.push(name);
  }
  return files.sort();
}

await test("clustered reference runtimes stage only editing dependencies and cannot read trusted host inputs", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/reference-runtime-"));
  const shared = [
    "reference/full-worker.mjs",
    "reference/full-structure-edit.mjs",
    "reference/implementation-edit.mjs",
    "reference/scripted-worker.mjs",
    "cpp/cpp-structure.mjs",
    "cpp/cpp-tokens.mjs",
    "cpp/cpp-offsets.mjs",
    "cpp/scoped-names.mjs",
    "cpp/joined-project.mjs",
    "cpp/clangd-renames.mjs",
    "cpp/compiler-ast.mjs",
    "generation/generator.mjs",
    "generation/origin-markers.mjs",
    "generation/semantic-names.mjs",
    "generation/name-vocabulary.mjs",
  ];
  const cases = [
    { entry: "full-worker.mjs", prepare: prepareFullExecutor, extra: [] },
    {
      entry: "coherent-worker.mjs",
      prepare: prepareCoherentExecutor,
      extra: ["reference/coherent-edit.mjs"],
    },
    {
      entry: "concurrent-worker.mjs",
      prepare: prepareConcurrentExecutor,
      extra: [
        "reference/coherent-edit.mjs",
        "reference/concurrent-commit.mjs",
        "reference/concurrent-plan.mjs",
        "reference/concurrent-planners.mjs",
      ],
    },
  ];
  try {
    const trusted = path.join(root, "trusted.json");
    await writeFile(trusted, "private future tasks and answers");
    for (const item of cases) {
      const tools = path.join(root, item.entry);
      const workspace = path.join(root, item.entry + "-workspace");
      await mkdir(workspace);
      await item.prepare(tools);
      assert.deepEqual(await stagedFiles(tools), [...shared, ...item.extra].sort());
      const entry = path.join(tools, "reference/full-worker.mjs");
      assert.deepEqual(
        await readFile(entry),
        await readFile(path.join("src/suites/explicit-edit-multi-agent/reference", item.entry)),
      );
      await writeFile(
        entry,
        `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { treeIdentity } from "../generation/generator.mjs";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  for (const file of [request.trusted, "/executor/prepare.mjs", "/executor/tasks/coherent-tasks.mjs", "/executor/grading/coherent-grade.mjs", "/executor/generation/run.mjs", "/executor/fixtures", "/workspace/../trusted.json"])
    await assert.rejects(readFile(file));
  await assert.rejects(writeFile("/executor/late-write", "forbidden"));
  await writeFile("/workspace/current.txt", request.id);
  console.log(JSON.stringify({ status: "edited", identity: treeIdentity({ "current.txt": request.id }) }));
}
`,
      );
      const worker = fullExecutor(workspace, tools);
      try {
        await worker.deliver({ id: "first", trusted });
        await worker.deliver({ id: "second", trusted });
        assert.equal(await readFile(path.join(workspace, "current.txt"), "utf8"), "second");
      } finally {
        worker.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
