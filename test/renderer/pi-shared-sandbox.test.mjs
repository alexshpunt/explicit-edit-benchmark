import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { test } from "node:test";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import {
  readProcessTable,
  startSharedSandbox,
} from "../../src/suites/explicit-edit-multi-agent/execution/shared-sandbox.mjs";
import { providerFixture } from "./provider-fixture.mjs";

assert.ok(
  process.env.RENDERER_PI_RUNTIME,
  "Set RENDERER_PI_RUNTIME to the separate installed Pi runtime",
);

const running = (text) => readProcessTable().filter((entry) => entry.command.includes(text));

const COMMANDS = {
  // A detached language-server host outlives the agent that started it.
  start: "(exec -a shared-server-host.mjs sleep 3072 >/dev/null 2>&1 &); echo shared > /tmp/a.txt",
  look: "cat /tmp/a.txt > seen.txt; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done > processes.txt",
  hang: "sleep 3071",
};

test("real Pi agents share one sandbox; closing one kills only its own processes", async (t) => {
  const root = await mkdtemp(path.resolve(".tmp/pi-shared-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const provider = await providerFixture(root, (body) => {
    if (body.messages.at(-1).role === "tool") return {};
    const prompt = JSON.stringify(body.messages.at(-1));
    return { command: COMMANDS[Object.keys(COMMANDS).find((key) => prompt.includes(key))] };
  });
  t.after(() => provider.close());
  const sandbox = await startSharedSandbox(path.join(root, "sandbox"));
  t.after(() => sandbox.stop());
  const start = (name) =>
    startBaseline(workspace, path.join(root, name), provider.config, { sharedSandbox: sandbox });

  const first = await start("first");
  await first.execute("start");
  await first.close();
  assert.equal(running("shared-server-host.mjs 3072").length, 1, "The shared host survives its agent");

  const second = await start("second");
  await second.execute("look");
  assert.equal(await readFile(path.join(workspace, "seen.txt"), "utf8"), "shared\n");
  const processes = await readFile(path.join(workspace, "processes.txt"), "utf8");
  assert.match(processes, /shared-server-host\.mjs 3072/, "Agents see each other's processes");

  const hanging = second.execute("hang").catch((error) => error);
  while (!running("sleep 3071").length) await delay(50);
  await second.close();
  await hanging;
  assert.equal(running("sleep 3071").length, 0, "Closing an agent kills its running commands");
  assert.equal(running("shared-server-host.mjs 3072").length, 1, "Closing an agent keeps the shared host");

  await sandbox.stop();
  assert.equal(running("shared-server-host.mjs 3072").length, 0, "Stopping the sandbox kills everything in it");
});
