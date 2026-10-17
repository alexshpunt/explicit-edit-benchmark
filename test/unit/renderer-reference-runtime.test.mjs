import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { prepareFullExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/full-executor.mjs";
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
    "cpp/direct-call-edits.mjs",
    "cpp/template-call-witness.mjs",
    "cpp/reference-call-witness.mjs",
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
        "reference/current-naming-service.mjs",
        "reference/current-naming-worker.mjs",
      ],
    },
    {
      entry: "current-naming-worker.mjs",
      channel: true,
      prepare: prepareConcurrentExecutor,
      extra: [
        "reference/coherent-edit.mjs",
        "reference/concurrent-commit.mjs",
        "reference/current-naming-service.mjs",
        "reference/current-naming-worker.mjs",
      ],
    },
  ];
  try {
    const trusted = path.join(root, "trusted.json");
    await writeFile(trusted, "private future tasks and answers");
    const runtime = path.join(root, "hosted-runtime");
    await mkdir(runtime);
    const node = path.join(runtime, "node");
    const adjacent = path.join(runtime, "credentials.json");
    await copyFile(process.execPath, node);
    await writeFile(adjacent, "private runtime neighbor");
    for (const item of cases) {
      const tools = path.join(root, item.entry);
      const workspace = path.join(root, item.entry + "-workspace");
      await mkdir(workspace);
      await item.prepare(tools);
      assert.deepEqual(await stagedFiles(tools), [...shared, ...item.extra].sort());
      const entry = path.join(tools, "reference", item.channel ? item.entry : "full-worker.mjs");
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
  for (const file of [request.trusted, request.adjacent, "/executor/prepare.mjs", "/executor/tasks/coherent-tasks.mjs", "/executor/grading/coherent-grade.mjs", "/executor/generation/run.mjs", "/executor/fixtures", "/workspace/../trusted.json"])
    await assert.rejects(readFile(file));
  await assert.rejects(writeFile("/executor/late-write", "forbidden"));
  await writeFile("/workspace/current.txt", request.id);
  console.log(JSON.stringify({ status: "edited", identity: treeIdentity({ "current.txt": request.id }) }));
}
`,
      );
      // Hosted Node lives outside /usr. Only its executable, not neighboring
      // files or its installation directory, may enter the worker namespace.
      await promisify(execFile)(
        node,
        [
          "--input-type=module",
          "-e",
          `const runtime = await import(process.argv[1]);
const worker = runtime.referenceChannel
  ? runtime.referenceChannel(process.argv[2], process.argv[3], process.argv[6])
  : runtime.fullExecutor(process.argv[2], process.argv[3]);
try {
  await worker.deliver({ id: "first", trusted: process.argv[4], adjacent: process.argv[5] });
  await worker.deliver({ id: "second", trusted: process.argv[4], adjacent: process.argv[5] });
} finally { await worker.close(); }`,
          pathToFileURL(
            path.resolve(
              "src/suites/explicit-edit-multi-agent/reference",
              item.channel ? "concurrent-channel.mjs" : "full-executor.mjs",
            ),
          ).href,
          workspace,
          tools,
          trusted,
          adjacent,
          item.entry,
        ],
        { timeout: 30_000 },
      );
      assert.equal(await readFile(path.join(workspace, "current.txt"), "utf8"), "second");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
