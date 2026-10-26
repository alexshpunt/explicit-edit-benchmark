import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { prepareConcurrentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import { coherentTaskPrompt } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import { scriptedPiFactory } from "./pi-atomic-reference.mjs";

assert.ok(process.env.RENDERER_PI_RUNTIME, "Set RENDERER_PI_RUNTIME to the installed Pi runtime");

test("real Pi executes fifty current atoms per native bash call and retains distinct histories", async (t) => {
  const root = await mkdtemp(path.resolve(".tmp/pi-atomic-reference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const names = ["North", "South", ...Array.from({ length: 98 }, (_, i) => `Unit${i}`), "West"];
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
  const deliver = (agent, ids) =>
    drivers[agent].execute(ids.map((id) => tasks.get(id).prompt).join("\n\n---\n\n"), {
      atomicId: ids[0],
      atomicIds: ids,
    });
  const [first, peer] = await Promise.all([
    deliver(0, names.slice(0, 50)),
    deliver(1, names.slice(50, 100)),
  ]);
  await assert.rejects(readFile(path.join(workspace, "west.h")), { code: "ENOENT" });
  assert.equal(first.scriptedReference.receipts.length, 50);
  assert.equal(peer.scriptedReference.receipts.length, 50);
  const next = await deliver(0, ["West"]);
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
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readFile(path.join(workspace, "main.cpp"), "utf8");
    const missing = names.filter((name) => current.includes(`#ifndef ${name.toUpperCase()}_H`));
    if (!missing.length) break;
    await Promise.all(
      [0, 1].map(async (agent) => {
        const owned = missing.filter((name) =>
          name === "West" ? agent === 0 : names.indexOf(name) < 50 ? agent === 0 : agent === 1,
        );
        if (owned.length) await deliver(agent, owned);
      }),
    );
  }
  for (const name of names) {
    assert.match(
      await readFile(path.join(workspace, `${name.toLowerCase()}.h`), "utf8"),
      new RegExp(`inline int ${name}\\(\\)`),
    );
  }
  assert.equal(
    (await readFile(path.join(workspace, "main.cpp"), "utf8")).match(/#include/g).length,
    101,
  );
});

test("a scripted editor compiler failure remains infrastructure rather than a provider outage", async (t) => {
  const root = await mkdtemp(path.resolve(".tmp/pi-atomic-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    path.join(workspace, "main.cpp"),
    "int helper(int value) { return missing_helper(value); }\n",
  );
  const operation = {
    phase: "names",
    category: "helpers",
    file: "main.cpp",
    mapping: [{ from: "helper", to: "restored" }],
  };
  const task = {
    id: "broken-compiler-input",
    operations: [operation],
    prompt: coherentTaskPrompt("Rename the file-local helper", [operation]),
  };
  const tools = path.join(root, "executor");
  await prepareConcurrentExecutor(tools);
  const createDriver = scriptedPiFactory({
    runtime: process.env.RENDERER_PI_RUNTIME,
    tools,
    tasks: new Map([[task.id, task]]),
    artifacts: path.join(root, "artifacts"),
  });
  const driver = await createDriver(workspace, path.join(root, "state"), 0);
  t.after(() => driver.close());
  await assert.rejects(driver.execute(task.prompt, { atomicId: task.id }), (error) => {
    assert.equal(error.category, "infrastructure");
    assert.match(error.message, /^Compiler AST failed:/);
    assert.match(error.message, /missing_helper/);
    assert.ok(error.execution.sessionId);
    assert.ok(error.execution.failedToolCalls > 0);
    return true;
  });
  assert.equal(
    await readFile(path.join(workspace, "main.cpp"), "utf8"),
    "int helper(int value) { return missing_helper(value); }\n",
  );
});
