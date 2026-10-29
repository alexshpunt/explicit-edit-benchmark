import assert from "node:assert/strict";
import { watch } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const baselineRuntime = process.env.RENDERER_PI_RUNTIME;
const ideRuntime = process.env.RENDERER_PI_IDE_RUNTIME;
const options = (runtime) => ({ skip: process.platform !== "linux" || !runtime, timeout: 60000 });

async function liveNamespaceProcesses(identity) {
  const remaining = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if ((await readlink(`/proc/${pid}/ns/pid`)) !== identity.namespace) continue;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const state = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[0];
      if (!["Z", "X"].includes(state)) remaining.push(Number(pid));
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return remaining;
}

async function fixture(t, runtime, respond, harness) {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/pi-round-termination-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const provider = await providerFixture(root, respond);
  const participants = [];
  const terminate = async (participant) => {
    const { driver, initial } = participant;
    if (driver.terminate) await driver.terminate();
    else await driver.close();
    assert.equal(driver.closed, true);
    if (initial) assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
  };
  t.after(async () => {
    const closed = await Promise.allSettled(participants.map(terminate));
    provider.close();
    await rm(root, { recursive: true, force: true });
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  });
  return {
    root,
    workspace,
    provider,
    terminate,
    async start(name) {
      const driver = await startPiParticipant(
        workspace,
        path.join(root, name),
        { ...provider.config, runtime, ...(harness ? { harness } : {}) },
        { eventsFile: path.join(root, `${name}.jsonl`), enforceProcessBoundary: true },
      );
      const participant = { driver, initial: undefined };
      participants.push(participant);
      participant.initial = await driver.assertIdle();
      assert.equal(participant.initial.messageCount, 0);
      return participant;
    },
  };
}

function identity(receipt) {
  return [receipt.sessionId, receipt.lifetime, receipt.agentPid];
}

function getStateResponses(driver) {
  return driver.events.filter((event) => event.type === "response" && event.command === "get_state")
    .length;
}

function userValues(request) {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      return JSON.parse(content);
    });
}

function assertNoOrderlyShutdown(driver) {
  assert.equal(
    driver.events.some(
      (event) => event.type === "baseline_observation" && event.event === "session_shutdown",
    ),
    false,
  );
}

test(
  "turn completion retains a native conversation without post-turn idle RPC",
  options(baselineRuntime),
  async (t) => {
    const f = await fixture(t, baselineRuntime, (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const { value } = userValues(body).at(-1);
      return { command: `printf '%s\\n' '${value}' >> /workspace/packets.txt` };
    });
    const participant = await f.start("sequential");
    const { driver, initial } = participant;
    const inspections = getStateResponses(driver);
    assert.ok(inspections > 0);
    for (const value of ["packet-one", "packet-two"]) {
      const receipt = await driver.execute(JSON.stringify({ value }), { completion: "turn" });
      assert.deepEqual(identity(receipt), identity(initial));
      assert.equal(receipt.failedToolCalls, 0);
      assert.equal(receipt.toolCalls, 1);
      assert.equal(receipt.usage.totalTokens, 60);
      assert.equal(Object.hasOwn(receipt, "messageCount"), false);
      assert.equal(getStateResponses(driver), inspections);
    }
    assert.equal(
      await readFile(path.join(f.workspace, "packets.txt"), "utf8"),
      "packet-one\npacket-two\n",
    );
    assert.equal(f.provider.requests.length, 4);
    assert.deepEqual(userValues(f.provider.requests[2]), [
      { value: "packet-one" },
      { value: "packet-two" },
    ]);
    await driver.terminate();
    assert.equal(driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
    assertNoOrderlyShutdown(driver);
    await driver.terminate();
    await assert.rejects(driver.execute("unused", { completion: "turn" }), {
      category: "driver_exit",
    });
    assert.equal(f.provider.requests.length, 4);
    assert.deepEqual(f.provider.errors, []);
  },
);

test(
  "native IDE turn completion retains Codemode state between ready packets",
  options(ideRuntime),
  async (t) => {
    const f = await fixture(
      t,
      ideRuntime,
      (_body, number) => {
        if (number % 2 === 0) return {};
        const previous = number === 1 ? "undefined" : JSON.stringify("first");
        const next = number === 1 ? "first" : "second";
        assert.ok(number === 1 || number === 3);
        return {
          toolCall: {
            name: "codemode",
            arguments: {
              code: `
if (load("packet") !== ${previous}) throw Error("Unexpected fixture state");
text(await tools.write({ path: "/workspace/phase.txt", content: "${next}\\n" }));
store("packet", "${next}");
`,
            },
          },
        };
      },
      "pi-agent-ide-codemode",
    );
    const { driver, initial } = await f.start("codemode-sequential");
    const inspections = getStateResponses(driver);
    for (const phase of ["first", "second"]) {
      const receipt = await driver.execute(JSON.stringify({ phase }), { completion: "turn" });
      assert.deepEqual(identity(receipt), identity(initial));
      assert.equal(receipt.failedToolCalls, 0);
      assert.equal(getStateResponses(driver), inspections);
      assert.equal(await readFile(path.join(f.workspace, "phase.txt"), "utf8"), `${phase}\n`);
    }
    assert.equal(f.provider.requests.length, 4);
    await driver.terminate();
    assert.equal(driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
    assertNoOrderlyShutdown(driver);
    assert.deepEqual(f.provider.errors, []);
  },
);

test(
  "immediate termination closes detached workers before their delayed edit",
  options(baselineRuntime),
  async (t) => {
    const f = await fixture(t, baselineRuntime, (body) =>
      body.messages.at(-1).role === "tool"
        ? {}
        : {
            command:
              "(sleep 5; printf late > /workspace/late) >/tmp/background.log 2>&1 </dev/null &",
          },
    );
    const participant = await f.start("detached");
    const { driver, initial } = participant;
    await driver.execute(JSON.stringify({ value: "background" }), { completion: "turn" });
    const remaining = await liveNamespaceProcesses(initial.process);
    assert.ok(
      remaining.some(
        (pid) => ![initial.process.rootPid, initial.process.agentHostPid].includes(pid),
      ),
    );
    await driver.terminate();
    assert.equal(driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
    assertNoOrderlyShutdown(driver);
    await delay(5100);
    await assert.rejects(access(path.join(f.workspace, "late")), { code: "ENOENT" });
    assert.equal(f.provider.requests.length, 2);
    assert.deepEqual(f.provider.errors, []);
  },
);

test(
  "an erroneous C++ IDE packet is terminated before diagnostics can wake it again",
  options(ideRuntime),
  async (t) => {
    const invalid = "#pragma once\ninline constexpr int answer = missing_name;\n";
    const f = await fixture(
      t,
      ideRuntime,
      (_body, number) => {
        if (number === 1)
          return {
            toolCall: { name: "write", arguments: { path: "/workspace/item.h", content: invalid } },
          };
        if (number === 3)
          return { toolCall: { name: "read", arguments: { path: "/workspace/item.h" } } };
        assert.ok(number === 2 || number === 4);
        return {};
      },
      "pi-agent-ide-codemode",
    );
    await writeFile(
      path.join(f.workspace, "item.h"),
      "#pragma once\ninline constexpr int answer = 1;\n",
    );
    await writeFile(
      path.join(f.workspace, "item.cpp"),
      '#include "item.h"\nint main() { return answer; }\n',
    );
    await writeFile(
      path.join(f.workspace, "compile_commands.json"),
      JSON.stringify([
        {
          directory: "/workspace",
          file: "/workspace/item.cpp",
          arguments: ["clang++", "-std=c++17", "-c", "/workspace/item.cpp"],
        },
      ]),
    );
    const first = await f.start("cpp-original");
    const inspections = getStateResponses(first.driver);
    const receipt = await first.driver.execute(JSON.stringify({ phase: "original" }), {
      completion: "turn",
    });
    assert.deepEqual(identity(receipt), identity(first.initial));
    assert.equal(receipt.failedToolCalls, 0);
    assert.equal(getStateResponses(first.driver), inspections);
    const cppProcesses = await liveNamespaceProcesses(first.initial.process);
    assert.ok(
      cppProcesses.some(
        (pid) => ![first.initial.process.rootPid, first.initial.process.agentHostPid].includes(pid),
      ),
    );
    await first.driver.terminate();
    assert.equal(first.driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(first.initial.process), []);
    assertNoOrderlyShutdown(first.driver);
    assert.equal(f.provider.requests.length, 2);
    assert.equal(await readFile(path.join(f.workspace, "item.h"), "utf8"), invalid);
    const recovery = await f.start("cpp-recovery");
    assert.notEqual(recovery.initial.sessionId, first.initial.sessionId);
    assert.notEqual(recovery.initial.lifetime, first.initial.lifetime);
    assert.notEqual(recovery.initial.process.namespace, first.initial.process.namespace);
    const inspected = await recovery.driver.execute(JSON.stringify({ phase: "recovery" }), {
      completion: "turn",
    });
    assert.equal(inspected.failedToolCalls, 0);
    await recovery.driver.terminate();
    assert.deepEqual(await liveNamespaceProcesses(recovery.initial.process), []);
    assert.equal(f.provider.requests.length, 4);
    assert.deepEqual(userValues(f.provider.requests[2]), [{ phase: "recovery" }]);
    assert.ok(
      JSON.stringify(f.provider.requests[3].messages.at(-1).content).includes("missing_name"),
    );
    for (const request of f.provider.requests) {
      const tools = new Set(request.tools.map((tool) => tool.function.name));
      for (const tool of [
        "codemode",
        "read",
        "bash",
        "write",
        "search",
        "diff",
        "replace",
        "insert",
        "delete",
        "copy",
        "move",
        "undo",
      ])
        assert.ok(tools.has(tool), tool);
      assert.ok(
        request.messages.some(
          (message) => ["system", "developer"].includes(message.role) && message.content?.length,
        ),
      );
    }
    assert.deepEqual(f.provider.errors, []);
  },
);

test(
  "turn completion preserves external cancellation and namespace closure",
  options(baselineRuntime),
  async (t) => {
    const f = await fixture(t, baselineRuntime, () => ({
      command: "printf ready > /workspace/started; sleep 30; printf late > /workspace/late",
    }));
    const { driver, initial } = await f.start("cancelled");
    const started = Promise.withResolvers();
    const watcher = watch(f.workspace, (_event, filename) => {
      if (filename === "started") started.resolve();
    });
    watcher.on("error", started.reject);
    t.after(() => watcher.close());
    const controller = new AbortController();
    t.after(() => controller.abort());
    const executing = driver.execute(JSON.stringify({ value: "cancelled" }), {
      completion: "turn",
      signal: controller.signal,
    });
    executing.catch(() => {});
    await Promise.race([
      started.promise,
      executing.then(() => assert.fail("The pending write completed")),
    ]);
    controller.abort();
    await assert.rejects(executing, { name: "AbortError" });
    assert.equal(driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
    await assert.rejects(access(path.join(f.workspace, "late")), { code: "ENOENT" });
    assert.equal(f.provider.requests.length, 1);
    assert.deepEqual(f.provider.errors, []);
  },
);

test(
  "an unsupported completion mode cannot start inference",
  options(baselineRuntime),
  async (t) => {
    const f = await fixture(t, baselineRuntime, () => ({}));
    const { driver, initial } = await f.start("invalid-completion");
    await assert.rejects(
      driver.execute(JSON.stringify({ value: "invalid" }), { completion: "unsupported" }),
      { code: "ERR_ASSERTION" },
    );
    assert.equal(f.provider.requests.length, 0);
    await driver.terminate();
    assert.equal(driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
    assert.deepEqual(f.provider.errors, []);
  },
);

test("turn completion reports provider failure without a retry", options(ideRuntime), async (t) => {
  const f = await fixture(
    t,
    ideRuntime,
    () => ({ error: "fixture-access-denied", status: 401 }),
    "pi-agent-ide-codemode",
  );
  const { driver, initial } = await f.start("provider-failure");
  await assert.rejects(
    driver.execute(JSON.stringify({ value: "denied" }), { completion: "turn" }),
    { category: "provider_failure" },
  );
  assert.equal(f.provider.requests.length, 1);
  await driver.terminate();
  assert.equal(driver.closed, true);
  assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
  assert.deepEqual(f.provider.errors, []);
});
