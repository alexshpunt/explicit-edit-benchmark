import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { withReferencePlanner } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-planners.mjs";

await test("reference compiler permits bound overlapping work and cancel only their own leases", async () => {
  await mkdir(".tmp", { recursive: true });
  const workspace = await mkdtemp(path.resolve(".tmp/concurrent-planners-"));
  let active = 0,
    peak = 0,
    completed = 0;
  try {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withReferencePlanner(workspace, undefined, async () => {
          peak = Math.max(peak, ++active);
          await delay(30);
          active--;
          completed++;
        }),
      ),
    );
    assert.equal(peak, 2);
    assert.equal(completed, 6);
    await mkdir(path.join(workspace, ".renderer-planner-0"));
    await mkdir(path.join(workspace, ".renderer-planner-1"));
    const abort = new AbortController();
    const waiting = withReferencePlanner(workspace, abort.signal, () =>
      assert.fail("No available permit"),
    );
    abort.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    await assert.rejects(mkdir(path.join(workspace, ".renderer-planner-0")), { code: "EEXIST" });
    await assert.rejects(mkdir(path.join(workspace, ".renderer-planner-1")), { code: "EEXIST" });
  } finally {
    await rm(workspace, { recursive: true });
  }
});
