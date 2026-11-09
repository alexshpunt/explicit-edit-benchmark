import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import {
  SHARED_SERVER_MARKER,
  readProcessTable,
  startSharedSandbox,
} from "../../src/suites/explicit-edit-multi-agent/execution/shared-sandbox.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_IDE_RUNTIME;
const options = { skip: process.platform !== "linux" || !runtime, timeout: 120000 };

const namespaceOf = (pid) => {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return null;
  }
};
// Agents join the sandbox from outside, so membership is the PID namespace, not ancestry.
const sandboxProcesses = (sandbox, matches) => {
  const namespace = namespaceOf(sandbox.init);
  return readProcessTable().filter(
    (entry) => matches(entry.command) && namespaceOf(entry.pid) === namespace,
  );
};
const host = (command) => command.includes(SHARED_SERVER_MARKER);
const clangd = (command) => path.basename(command.split(" ")[0]).startsWith("clangd");

test("Pi Agent IDE agents in one sandbox share one clangd", options, async (t) => {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/pi-ide-shared-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    path.join(workspace, "main.cpp"),
    "int add(int a, int b) { return a + b; }\nint main() { return add(1, 2); }\n",
  );
  const provider = await providerFixture(root, (body) =>
    body.messages.at(-1).role === "tool"
      ? {}
      : { toolCall: { name: "lsp_search", arguments: { calls: "main.cpp#add" } } },
  );
  t.after(() => provider.close());
  const sandbox = await startSharedSandbox(path.join(root, "sandbox"));
  t.after(() => sandbox.stop());
  const config = { ...provider.config, runtime, harness: "pi-agent-ide-codemode-no-bash" };
  const start = (name) =>
    startBaseline(workspace, path.join(root, name), config, { sharedSandbox: sandbox });

  const first = await start("first");
  const second = await start("second");
  for (const driver of [first, second]) {
    const result = await driver.execute("Find the callers of add.");
    assert.equal(result.failedToolCalls, 0);
  }
  assert.equal(sandboxProcesses(sandbox, host).length, 1);
  assert.equal(sandboxProcesses(sandbox, clangd).length, 1, "One clangd for both agents");

  await first.close();
  const third = await start("third");
  await third.execute("Find the callers of add again.");
  assert.equal(sandboxProcesses(sandbox, clangd).length, 1, "A later agent reuses it");
  await Promise.all([second.close(), third.close()]);
});
