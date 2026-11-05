import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { executeChunkDelivery } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-delivery-deadline.mjs";
import { runChunkTeam } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-team.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_RUNTIME;

test(
  "a real correction participant can time out inside the retained barrier",
  { skip: process.platform !== "linux" || !runtime, timeout: 30000 },
  async (t) => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/chunk-team-barrier-pi-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const provider = await providerFixture(root, (_body, n) =>
      n === 1
        ? {
            command:
              "printf partial > /workspace/repair.txt; sleep 20; printf late >> /workspace/repair.txt",
          }
        : {},
    );
    const drivers = [];
    t.after(async () => {
      for (const d of drivers) if (!d.closed) await d.terminate();
      provider.close();
      await rm(root, { recursive: true, force: true });
    });
    await runChunkTeam([{ id: "wave", batches: [0] }], {
      agents: 1,
      async createDriver(_agent, session, { signal }) {
        const d = await startPiParticipant(
          workspace,
          path.join(root, `state-${session}`),
          { ...provider.config, runtime },
          {
            signal,
            enforceProcessBoundary: true,
            eventsFile: path.join(root, `events-${session}.jsonl`),
          },
        );
        drivers.push(d);
        return d;
      },
      async execute() {},
      async onDrained({ participants, signal }) {
        const p = participants[0];
        const outcome = await executeChunkDelivery(p.driver, "Repair the project.", {
          signal,
          timeoutMs: 2000,
          retire: p.retire,
        });
        assert.equal(outcome.status, "timed-out");
        assert.equal(p.driver.closed, true);
      },
    });
    assert.equal(await readFile(path.join(workspace, "repair.txt"), "utf8"), "partial");
    assert.ok(drivers.every((d) => d.closed));
  },
);
test(
  "a real timed-out Pi keeps partial edits while its peer continues the queue",
  { skip: process.platform !== "linux" || !runtime, timeout: 30000 },
  async (t) => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/chunk-team-deadline-pi-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const provider = await providerFixture(root, (body) => {
      const messages = body.messages ?? [];
      if (messages.at(-1)?.role === "tool") return {};
      const prompt = messages.findLast((x) => x.role === "user")?.content ?? "";
      return JSON.stringify(prompt).includes("SLOW")
        ? {
            command:
              "printf partial > /workspace/slow.txt; sleep 20; printf late >> /workspace/slow.txt",
          }
        : { command: "printf done >> /workspace/fast.txt" };
    });
    const drivers = [];
    t.after(async () => {
      for (const d of drivers) if (!d.closed) await d.terminate();
      provider.close();
      await rm(root, { recursive: true, force: true });
    });
    const result = await runChunkTeam(
      [{ id: "task", batches: [{ id: "slow" }, { id: "fast" }, { id: "next" }] }],
      {
        agents: 2,
        async createDriver(_agent, session, { signal }) {
          const d = await startPiParticipant(
            workspace,
            path.join(root, `state-${session}`),
            { ...provider.config, runtime },
            {
              signal,
              enforceProcessBoundary: true,
              eventsFile: path.join(root, `events-${session}.jsonl`),
            },
          );
          drivers.push(d);
          return d;
        },
        async execute(driver, batch, { signal }) {
          const result = await executeChunkDelivery(driver, batch.id === "slow" ? "SLOW" : "FAST", {
            signal,
            timeoutMs: batch.id === "slow" ? 2000 : 8000,
          });
          return result.status === "timed-out" ? { timedOut: true } : result.receipt;
        },
      },
    );
    assert.equal(result.status, "partial");
    assert.equal(result.timeouts.length, 1);
    assert.equal(result.timeouts[0].batchId, "slow");
    assert.deepEqual(result.unissued, []);
    assert.equal(await readFile(path.join(workspace, "slow.txt"), "utf8"), "partial");
    assert.equal(await readFile(path.join(workspace, "fast.txt"), "utf8"), "donedone");
    assert.equal(drivers.length, 2);
    assert.ok(drivers.every((d) => d.closed));
    await delay(150);
    assert.equal(await readFile(path.join(workspace, "slow.txt"), "utf8"), "partial");
  },
);
