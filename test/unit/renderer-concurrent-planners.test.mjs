import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { sharedReferencePlanner } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-planners.mjs";
import { prepareConcurrentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
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
await test(
  "reference planning shares only a workspace's current public requests and keeps unrelated projects isolated",
  { timeout: 20_000 },
  async () => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/reference-planners-"));
    const tools = path.join(root, "tools"),
      first = path.join(root, "first"),
      second = path.join(root, "second");
    await prepareConcurrentExecutor(tools);
    const tree = { "main.cpp": "int sum(int a, int b) { return a + b; }\n" };
    await writeTree(first, tree);
    await writeTree(second, tree);
    const a = sharedReferencePlanner(first, tools),
      b = sharedReferencePlanner(first, tools),
      other = sharedReferencePlanner(second, tools);
    try {
      const results = await Promise.all([
        a.execute(rename("a", "a", "long_left")),
        b.execute(rename("b", "b", "right")),
        other.execute(rename("other", "a", "different")),
      ]);
      assert.equal(
        Math.max(...results.slice(0, 2).map((result) => result.planner.snapshotAttempts)),
        1,
      );
      assert.equal(results[2].planner.snapshotAttempts, 1);
      assert.ok((await readTree(first))["main.cpp"].includes("long_left + right"));
      assert.ok((await readTree(second))["main.cpp"].includes("different + b"));
      await a.release();
      const next = await b.execute(rename("next", "right", "last"));
      assert.equal(next.status, "edited");
    } finally {
      await Promise.all([a.close(), b.close(), other.close()]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
