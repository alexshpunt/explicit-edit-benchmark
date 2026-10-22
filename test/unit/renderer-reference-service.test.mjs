import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const rename = (id, from, to) => ({
  id,
  operations: [
    {
      id,
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from, to }],
      selectors: [
        { kind: "function", scope: "sum", signature: "int (int, int)", definition: true },
      ],
    },
  ],
});
async function setup(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/reference-service-"));
  const tools = path.join(root, "executor"),
    workspace = path.join(root, "workspace");
  await prepareConcurrentExecutor(tools);
  await writeTree(workspace, { "main.cpp": "int sum(int a, int b) { return a + b; }\n" });
  const executors = [];
  t.after(async () => {
    await Promise.all(executors.map((executor) => executor.close()));
    await rm(root, { recursive: true, force: true });
  });
  return { tools, workspace, executors };
}
async function descendants(pid) {
  let children;
  try {
    children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return children.concat((await Promise.all(children.map(descendants))).flat());
}
async function alive(pid) {
  try {
    await readFile(`/proc/${pid}/stat`, "utf8");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

await test(
  "separate isolated participants share compiler reuse without sharing participant lifetimes",
  { timeout: 20_000 },
  async (t) => {
    const { tools, workspace, executors } = await setup(t);
    const first = concurrentExecutor(workspace, tools),
      second = concurrentExecutor(workspace, tools);
    executors.push(first, second);
    const [a, b] = await Promise.all([
      first.execute(rename("a", "a", "left_long")),
      second.execute(rename("b", "b", "right")),
    ]);
    assert.notEqual(a.lifetime, b.lifetime);
    assert.equal(a.delivered, 1);
    assert.equal(b.delivered, 1);
    assert.equal(Math.max(a.planner.snapshotAttempts, b.planner.snapshotAttempts), 1);
    assert.equal(Math.max(a.planner.cacheHits, b.planner.cacheHits), 1);
    assert.deepEqual(await readTree(workspace), {
      "main.cpp": "int sum(int left_long, int right) { return left_long + right; }\n",
    });
    await first.close();
    const next = await second.execute(rename("again", "right", "final"));
    assert.equal(next.lifetime, b.lifetime);
    assert.equal(next.delivered, 2);
  },
);
await test(
  "cancellation waits for the service namespace and its session-escaped compiler children",
  { timeout: 20_000 },
  async (t) => {
    const { tools, workspace, executors } = await setup(t);
    const compiler = path.join(tools, "cpp/compiler-ast.mjs");
    const source = await readFile(compiler, "utf8");
    const original =
      '"clang++",\n    [...flags, "-fsyntax-only", "-Xclang", "-ast-dump=json", sourcePath]';
    assert.ok(source.includes(original));
    await writeFile(
      compiler,
      source.replace(original, '"bash",\n    ["-c", "setsid sleep 30 & wait"]'),
    );
    const controller = new AbortController();
    const executor = concurrentExecutor(workspace, tools, { signal: controller.signal });
    executors.push(executor);
    const delivery = executor.execute(rename("cancelled", "a", "left"));
    const settled = assert.rejects(delivery, /closed|exited|abort|cancel/i);
    let owned = [];
    for (let attempt = 0; attempt < 400; attempt++) {
      const candidates = await descendants(process.pid);
      const roots = [];
      for (const pid of candidates) {
        try {
          if ((await readFile(`/proc/${pid}/cmdline`, "utf8")).includes(tools)) roots.push(pid);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      owned = [
        ...new Set(
          (await Promise.all(roots.map(async (pid) => [pid, ...(await descendants(pid))]))).flat(),
        ),
      ];
      let sleeping = false;
      for (const pid of owned) {
        try {
          sleeping ||= (await readFile(`/proc/${pid}/cmdline`, "utf8"))
            .replaceAll("\0", " ")
            .includes("sleep 30");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (sleeping) break;
      await delay(10);
    }
    assert.ok(
      owned.length >= 5,
      "The reference service and actual compiler subtree must have started",
    );
    controller.abort(Error("cancel reference"));
    await settled;
    assert.ok(
      (await Promise.all(owned.map(alive))).every((value) => !value),
      "Delivery rejection must await all owned process teardown",
    );
    await executor.close();
    assert.deepEqual(await readTree(workspace), {
      "main.cpp": "int sum(int a, int b) { return a + b; }\n",
    });
  },
);
