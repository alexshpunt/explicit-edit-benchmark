import assert from "node:assert/strict";
import { mkdtemp, mkdir, access, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";

assert.ok(process.env.RENDERER_PI_RUNTIME);
async function fixture(t, respond) {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/pi-process-boundary-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const provider = await providerFixture(root, respond),
    drivers = [];
  t.after(async () => {
    await Promise.all(drivers.map((driver) => driver.close()));
    provider.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    workspace,
    provider,
    async start(name) {
      const driver = await startBaseline(workspace, path.join(root, name), provider.config, {
        eventsFile: path.join(root, `${name}.jsonl`),
        enforceProcessBoundary: true,
      });
      drivers.push(driver);
      return driver;
    },
  };
}

test("native process-boundary checks retain two real isolated Pi processes without idle inference", async (t) => {
  const f = await fixture(t, (body) =>
    body.messages.at(-1).role === "tool" ? {} : { command: "printf x >> /workspace/edited" },
  );
  const left = await f.start("left"),
    right = await f.start("right");
  const initial = await Promise.all([left.assertIdle(), right.assertIdle()]);
  assert.notEqual(initial[0].process.agentHostPid, initial[1].process.agentHostPid);
  assert.notEqual(initial[0].process.namespace, initial[1].process.namespace);
  assert.equal(f.provider.requests.length, 0);
  for (const driver of [left, right]) await driver.execute("Perform the current edit.");
  const calls = f.provider.requests.length;
  const final = await Promise.all([left.assertIdle(), right.assertIdle()]);
  assert.deepEqual(
    final.map(({ process }) => process),
    initial.map(({ process }) => process),
  );
  assert.equal(f.provider.requests.length, calls);
});

test("a detached Bash writer fails the runtime boundary and shutdown prevents its late write", async (t) => {
  const f = await fixture(t, (body) =>
    body.messages.at(-1).role === "tool"
      ? {}
      : {
          command:
            "(sleep 5; printf late > /workspace/late) >/tmp/background.log 2>&1 </dev/null &",
        },
  );
  const driver = await f.start("writer");
  await driver.assertIdle();
  await assert.rejects(
    driver.execute("Perform the current edit."),
    (error) => error.category === "infrastructure",
  );
  assert.ok(driver.events.some((event) => event.type === "tool_execution_end" && !event.isError));
  await driver.close();
  assert.equal(driver.closed, true);
  await delay(5100);
  await assert.rejects(access(path.join(f.workspace, "late")), (error) => error.code === "ENOENT");
});
