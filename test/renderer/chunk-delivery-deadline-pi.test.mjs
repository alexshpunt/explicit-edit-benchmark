import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { executeChunkDelivery } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-delivery-deadline.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_RUNTIME;

test(
  "delivery timeout stops the actual Pi namespace and keeps its partial edit",
  { skip: process.platform !== "linux" || !runtime, timeout: 30000 },
  async (t) => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/chunk-delivery-deadline-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const provider = await providerFixture(root, (_body, number) =>
      number === 1
        ? {
            command:
              "printf partial > /workspace/edit.txt; sleep 20; printf late >> /workspace/edit.txt",
          }
        : {},
    );
    let driver;
    t.after(async () => {
      try {
        if (driver) await driver.terminate();
      } finally {
        provider.close();
        await rm(root, { recursive: true, force: true });
      }
    });
    driver = await startPiParticipant(
      workspace,
      path.join(root, "agent"),
      { ...provider.config, runtime },
      { enforceProcessBoundary: true, eventsFile: path.join(root, "events.jsonl") },
    );
    const identity = await driver.assertIdle();
    const result = await executeChunkDelivery(driver, "Make the requested edit and finish it.", {
      timeoutMs: 2000,
    });
    assert.deepEqual(result, { status: "timed-out" });
    assert.equal(driver.closed, true);
    assert.equal(provider.requests.length, 1);
    assert.equal(await readFile(path.join(workspace, "edit.txt"), "utf8"), "partial");
    await delay(150);
    assert.equal(await readFile(path.join(workspace, "edit.txt"), "utf8"), "partial");
    const live = [];
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if ((await readlink(`/proc/${pid}/ns/pid`)) !== identity.process.namespace) continue;
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const state = stat
          .slice(stat.lastIndexOf(")") + 1)
          .trim()
          .split(/\s+/)[0];
        if (!["Z", "X"].includes(state)) live.push(pid);
      } catch (error) {
        if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
      }
    }
    assert.deepEqual(live, []);
  },
);
