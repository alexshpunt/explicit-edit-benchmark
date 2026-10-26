import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { closeHarness, runHarness } from "../../scripts/harness-runtime.mjs";
import { tempDirectory } from "../helpers/temp.mjs";

async function fixture(t, script) {
  const root = await tempDirectory("harness-persistent-death-");
  const workspace = path.join(root, "workspace"),
    state = path.join(root, "state");
  await mkdir(workspace);
  const node = path.join(root, "node");
  await copyFile(process.execPath, node);
  t.after(async () => {
    await closeHarness(state);
    await rm(root, { recursive: true, force: true });
  });
  return {
    workspace,
    state,
    adapter: {
      kind: "custom",
      command: "/usr/bin/true",
      args: [],
      readOnly: [node],
      driver: { command: node, args: ["-e", script], persistent: true },
    },
    artifacts: (name) => path.join(root, name),
  };
}

const script = `
const fs = require("node:fs");
fs.appendFileSync("/workspace/starts", "start\\n");
process.on("exit", () => fs.writeFileSync("/workspace/exited", "closed"));
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const { prompt } = JSON.parse(line);
  fs.appendFileSync("/workspace/turns", prompt + "\\n");
  console.log(JSON.stringify({ type: "eval/turn-complete", reason: { kind: "completed" } }));
  setTimeout(() => process.exit(23), 20);
});`;

test(
  "an idle persistent child death rejects the next untimed dispatch without respawning",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, script);
    const first = await runHarness(f.adapter, {
      workspace: f.workspace,
      state: f.state,
      artifacts: f.artifacts("first"),
      prompt: "first",
      timeoutMs: null,
    });
    assert.equal(first.exitCode, 0);
    const end = performance.now() + 5000;
    for (;;) {
      try {
        await readFile(path.join(f.workspace, "exited"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      assert.ok(performance.now() < end);
      await delay(10);
    }
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 500);
    try {
      await assert.rejects(
        runHarness(f.adapter, {
          workspace: f.workspace,
          state: f.state,
          artifacts: f.artifacts("second"),
          prompt: "must not run",
          timeoutMs: null,
          signal: controller.signal,
        }),
        (error) => error.name !== "AbortError",
      );
      assert.equal(controller.signal.aborted, false);
    } finally {
      clearTimeout(guard);
    }
    assert.equal(await readFile(path.join(f.workspace, "starts"), "utf8"), "start\n");
    assert.equal(await readFile(path.join(f.workspace, "turns"), "utf8"), "first\n");
  },
);

test(
  "a cancelled persistent child stays terminal until its caller explicitly closes it",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, script.replace("setTimeout(() => process.exit(23), 20);", ""));
    const controller = new AbortController();
    const first = await runHarness(f.adapter, {
      workspace: f.workspace,
      state: f.state,
      artifacts: f.artifacts("first"),
      prompt: "first",
      timeoutMs: null,
    });
    assert.equal(first.exitCode, 0);
    const running = runHarness(f.adapter, {
      workspace: f.workspace,
      state: f.state,
      artifacts: f.artifacts("cancel"),
      prompt: "cancel",
      timeoutMs: null,
      signal: controller.signal,
    });
    running.catch(() => {});
    controller.abort();
    await assert.rejects(running, { name: "AbortError" });
    await assert.rejects(
      runHarness(f.adapter, {
        workspace: f.workspace,
        state: f.state,
        artifacts: f.artifacts("restart"),
        prompt: "must not run",
        timeoutMs: null,
      }),
    );
    assert.equal(await readFile(path.join(f.workspace, "starts"), "utf8"), "start\n");
  },
);
