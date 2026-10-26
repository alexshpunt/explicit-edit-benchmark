import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";

assert.ok(process.env.RENDERER_PI_RUNTIME);

async function fixture(t, respond) {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/pi-baseline-idle-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const provider = await providerFixture(root, respond);
  const drivers = [];
  t.after(async () => {
    await Promise.all(drivers.map((driver) => driver.close()));
    provider.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    provider,
    async start(name) {
      const state = path.join(root, name);
      const driver = await startBaseline(workspace, state, provider.config, {
        eventsFile: path.join(root, `${name}.jsonl`),
      });
      drivers.push(driver);
      return { driver, state };
    },
  };
}

function payload(message) {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  return JSON.parse(text);
}
function identity(receipt) {
  return [receipt.sessionId, receipt.lifetime, receipt.agentPid];
}

function processGroup(state) {
  const groups = execFileSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(`--bind ${state} /state`) && line.includes("--unshare-pid"))
    .map((line) => line.trim().split(/\s+/, 2).map(Number))
    .filter(([pid, pgid]) => pid === pgid);
  assert.ok(groups.length > 0);
  return groups.map(([pid]) => pid).sort((left, right) => left - right);
}

async function until(check) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    assert.ok(performance.now() < end);
    await delay(10);
  }
}

test(
  "idle inspection preserves two real Pi processes and separate histories without inference",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const request = payload(body.messages.findLast(({ role }) => role === "user"));
      return { command: `printf '%s\\n' '${request.value}' >> /workspace/${request.participant}` };
    });
    const left = await f.start("left");
    const right = await f.start("right");
    const hostGroups = [processGroup(left.state), processGroup(right.state)];
    assert.ok(hostGroups[0].every((pid) => !hostGroups[1].includes(pid)));
    const initial = await Promise.all([left.driver.assertIdle(), right.driver.assertIdle()]);
    assert.notEqual(initial[0].sessionId, initial[1].sessionId);
    assert.notEqual(initial[0].lifetime, initial[1].lifetime);
    assert.equal(f.provider.requests.length, 0);
    const receipts = [[], []];
    for (let round = 1; round <= 2; round++) {
      for (const [index, participant] of [left, right].entries()) {
        const name = index === 0 ? "left" : "right";
        const receipt = await participant.driver.execute(
          JSON.stringify({ participant: name, value: `${name}-${round}` }),
        );
        receipts[index].push(receipt);
        const count = f.provider.requests.length;
        const calls = participant.driver.events.filter(
          ({ type }) => type === "message_start",
        ).length;
        const idle = await participant.driver.assertIdle();
        assert.deepEqual(identity(idle), identity(initial[index]));
        assert.deepEqual(identity(receipt), identity(initial[index]));
        assert.equal(idle.messageCount, receipt.messageCount);
        assert.equal(f.provider.requests.length, count);
        assert.equal(
          participant.driver.events.filter(({ type }) => type === "message_start").length,
          calls,
        );
      }
    }
    for (const [index, participant] of [left, right].entries()) {
      const name = index === 0 ? "left" : "right";
      assert.deepEqual(processGroup(participant.state), hostGroups[index]);
      assert.ok(receipts[index][1].messageCount > receipts[index][0].messageCount);
      assert.equal(await readFile(path.join(f.workspace, name), "utf8"), `${name}-1\n${name}-2\n`);
      const last = f.provider.requests
        .filter((body) => body.messages.at(-1).role === "user")
        .findLast((body) => payload(body.messages.at(-1)).participant === name);
      assert.deepEqual(
        last.messages
          .filter(({ role }) => role === "user")
          .map((message) => payload(message).value),
        [`${name}-1`, `${name}-2`],
      );
    }
    assert.equal(f.provider.errors.length, 0);
  },
);

test(
  "an idle real Pi death rejects inspection and the next assignment without restarting",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, () => ({}));
    const { driver, state } = await f.start("dead");
    await driver.execute("First assignment");
    const first = await driver.assertIdle();
    const group = processGroup(state);
    const count = f.provider.requests.length;
    for (const pid of group) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await until(() => driver.closed);
    await assert.rejects(driver.assertIdle(), { category: "driver_exit" });
    await assert.rejects(driver.execute("Must not start"), { category: "driver_exit" });
    assert.equal(f.provider.requests.length, count);
    const observed = driver.events.filter(({ type }) => type === "baseline_observation");
    assert.ok(
      observed.every(
        (event) => event.lifetime === first.lifetime && event.sessionId === first.sessionId,
      ),
    );
  },
);

test(
  "busy inspection cannot declare a live tool idle and cancellation prevents later writes",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, (body) =>
      body.messages.at(-1).role === "tool"
        ? {}
        : {
            command: "touch /workspace/started; sleep 1; printf late > /workspace/late",
          },
    );
    const { driver } = await f.start("busy");
    const controller = new AbortController();
    t.after(() => controller.abort());
    const executing = driver.execute("Run the pending tool", { signal: controller.signal });
    executing.catch(() => {});
    await until(async () => {
      try {
        await readFile(path.join(f.workspace, "started"));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
    await assert.rejects(driver.assertIdle(), { category: "driver_exit" });
    controller.abort();
    await assert.rejects(executing, { name: "AbortError" });
    assert.equal(driver.closed, true);
    const count = f.provider.requests.length;
    await assert.rejects(driver.assertIdle(), { name: "AbortError" });
    await assert.rejects(driver.execute("Must not restart"), { name: "AbortError" });
    assert.equal(f.provider.requests.length, count);
    await delay(1200);
    await assert.rejects(readFile(path.join(f.workspace, "late")), { code: "ENOENT" });
  },
);
