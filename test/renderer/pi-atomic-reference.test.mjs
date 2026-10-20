import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { prepareConcurrentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import { coherentTaskPrompt } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import { scriptedPiFactory } from "./pi-atomic-reference.mjs";

assert.ok(process.env.RENDERER_PI_RUNTIME, "Set RENDERER_PI_RUNTIME to the installed Pi runtime");

test("real Pi invokes one isolated current-atom edit per bash call and retains distinct histories", async (t) => {
  const root = await mkdtemp(path.resolve(".tmp/pi-atomic-reference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const names = ["North", "South", "West"];
  const initial = names
    .map(
      (name) =>
        `#ifndef ${name.toUpperCase()}_H\n#define ${name.toUpperCase()}_H\ninline int ${name}() { return 1; }\n#endif\n`,
    )
    .join("");
  await writeFile(path.join(workspace, "main.cpp"), initial);
  const tasks = new Map(
    names.map((name) => {
      const operation = {
        phase: "structure",
        action: "header",
        file: `${name.toLowerCase()}.h`,
        guard: `${name.toUpperCase()}_H`,
        includes: [],
      };
      const task = {
        id: name,
        operations: [operation],
        prompt: coherentTaskPrompt(`Extract ${name}`, [operation]),
      };
      return [task.id, task];
    }),
  );
  const tools = path.join(root, "executor");
  await prepareConcurrentExecutor(tools);
  const createDriver = scriptedPiFactory({
    runtime: process.env.RENDERER_PI_RUNTIME,
    tools,
    tasks,
    artifacts: path.join(root, "artifacts"),
  });
  const drivers = [];
  t.after(async () => Promise.all(drivers.map((driver) => driver.close())));
  for (let agent = 0; agent < 2; agent++)
    drivers.push(await createDriver(workspace, path.join(root, `state-${agent}`), agent));
  const deliver = (agent, id) => drivers[agent].execute(tasks.get(id).prompt, { atomicId: id });
  const [first, peer] = await Promise.all([deliver(0, "North"), deliver(1, "South")]);
  await assert.rejects(readFile(path.join(workspace, "west.h")), { code: "ENOENT" });
  const next = await deliver(0, "West");
  assert.equal(first.sessionId, next.sessionId);
  assert.equal(first.lifetime, next.lifetime);
  assert.equal(first.agentPid, next.agentPid);
  assert.notEqual(first.sessionId, peer.sessionId);
  assert.ok(next.messageCount > first.messageCount);
  for (const receipt of [first, peer, next]) {
    assert.equal(receipt.toolCalls, 1);
    assert.equal(receipt.failedToolCalls, 0);
    assert.equal(receipt.scriptedReference.status, "edited");
  }
  for (const name of names) {
    assert.match(
      await readFile(path.join(workspace, `${name.toLowerCase()}.h`), "utf8"),
      new RegExp(`inline int ${name}\\(\\)`),
    );
  }
  assert.equal(
    (await readFile(path.join(workspace, "main.cpp"), "utf8")).match(/#include/g).length,
    3,
  );
});
