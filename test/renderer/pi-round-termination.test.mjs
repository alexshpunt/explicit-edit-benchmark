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
import { createProviderRecovery } from "../../src/suites/explicit-edit-multi-agent/execution/provider-recovery.mjs";

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

async function fixture(t, runtime, respond, harness, participantOptions = {}) {
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
        {
          ...participantOptions,
          eventsFile: path.join(root, `${name}.jsonl`),
          enforceProcessBoundary: true,
        },
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

function waitForTrace(t, file, driver, predicate) {
  const waiting = Promise.withResolvers();
  waiting.promise.catch(() => {});
  const inspect = () => {
    if (predicate(driver.events)) {
      watcher.close();
      waiting.resolve();
    }
  };
  const watcher = watch(file, inspect);
  watcher.on("error", waiting.reject);
  const abort = () => waiting.reject(t.signal.reason);
  t.signal.addEventListener("abort", abort, { once: true });
  t.after(() => {
    watcher.close();
    t.signal.removeEventListener("abort", abort);
  });
  inspect();
  return waiting.promise;
}

function nativeUserMessages(driver) {
  return driver.events
    .filter((event) => event.type === "message_end" && event.message?.role === "user")
    .map(({ message }) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join(""),
    );
}

function idleBackgroundResponses(failure, errorCount = 4) {
  return (_body, number) => {
    if (number === 1)
      return {
        toolCall: {
          name: "bash",
          arguments: {
            command:
              "printf 'original\\n' >> /workspace/original-once.txt; while [ ! -f /workspace/release-background ]; do sleep 0.05; done; printf 'background-ready\\n'",
            background: true,
          },
        },
      };
    if (number === 3)
      return { command: "printf 'background\\n' >> /workspace/background-once.txt" };
    if (number >= 4 && number < 4 + errorCount) return failure;
    return {};
  };
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

for (const { kind, failure } of [
  { kind: "upstream", failure: { status: 503, error: "fixture-transient-upstream" } },
  { kind: "connection", failure: { streamError: "Connection error." } },
  { kind: "websocket", failure: { streamError: "WebSocket error" } },
])
  test(
    `IDE turn recovers a transient failure after a completed edit without replaying it (${kind})`,
    options(ideRuntime),
    async (t) => {
      const f = await fixture(
        t,
        ideRuntime,
        (body, number) => {
          if (number === 2) return failure;
          if (body.messages.at(-1).role === "tool") return {};
          const { value } = userValues(body).at(-1);
          return { command: `printf '%s\\n' '${value}' >> /workspace/recovered.txt` };
        },
        "pi-agent-ide-codemode",
      );
      const { driver, initial } = await f.start("recovery");
      const first = await driver.execute(JSON.stringify({ value: "first" }), {
        completion: "turn",
        signal: t.signal,
      });
      assert.equal(await readFile(path.join(f.workspace, "recovered.txt"), "utf8"), "first\n");
      assert.equal(first.toolCalls, 1);
      assert.equal(first.failedToolCalls, 0);
      assert.equal(
        driver.events.filter(
          (event) => event.type === "message_end" && event.message?.stopReason === "error",
        ).length,
        1,
      );
      assert.equal(first.lifecycle.filter((event) => event.type === "auto_retry_start").length, 1);
      assert.equal(
        first.lifecycle.filter((event) => event.type === "auto_retry_end" && event.success).length,
        1,
      );
      const second = await driver.execute(JSON.stringify({ value: "second" }), {
        completion: "turn",
        signal: t.signal,
      });
      assert.deepEqual(identity(second), identity(first));
      assert.equal(
        await readFile(path.join(f.workspace, "recovered.txt"), "utf8"),
        "first\nsecond\n",
      );
      assert.deepEqual(userValues(f.provider.requests.at(-1)), [
        { value: "first" },
        { value: "second" },
      ]);
      await driver.terminate();
      assert.equal(driver.closed, true);
      assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
      assert.deepEqual(f.provider.errors, []);
    },
  );
test("exhausted native IDE retries remain a failed delivery", options(ideRuntime), async (t) => {
  const f = await fixture(
    t,
    ideRuntime,
    () => ({ status: 503, error: "fixture-transient-upstream" }),
    "pi-agent-ide-codemode",
  );
  const { driver, initial } = await f.start("exhaustion");
  await assert.rejects(
    driver.execute(JSON.stringify({ value: "unavailable" }), {
      completion: "turn",
      signal: t.signal,
    }),
    (error) => {
      assert.equal(error.category, "provider_failure");
      assert.equal(error.execution.toolCalls, 0);
      const lifecycle = error.execution.lifecycle;
      assert.equal(lifecycle.filter(({ type }) => type === "auto_retry_start").length, 3);
      assert.equal(
        lifecycle.filter(({ type, success }) => type === "auto_retry_end" && success === false)
          .length,
        1,
      );
      return true;
    },
  );
  assert.equal(f.provider.requests.length, 4);
  await driver.terminate();
  assert.equal(driver.closed, true);
  assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
  assert.deepEqual(f.provider.errors, []);
});

test(
  "cancelling native IDE retry backoff stops further requests",
  options(ideRuntime),
  async (t) => {
    const f = await fixture(
      t,
      ideRuntime,
      () => ({ status: 503, error: "fixture-transient-upstream" }),
      "pi-agent-ide-codemode",
    );
    const { driver, initial } = await f.start("backoff");
    const retryStarted = Promise.withResolvers();
    const watcher = watch(path.join(f.root, "backoff.jsonl"), () => {
      if (driver.events.some(({ type }) => type === "auto_retry_start")) retryStarted.resolve();
    });
    t.after(() => watcher.close());
    const controller = new AbortController();
    t.after(() => controller.abort());
    const executing = driver.execute(JSON.stringify({ value: "cancel" }), {
      completion: "turn",
      signal: AbortSignal.any([t.signal, controller.signal]),
    });
    executing.catch(() => {});
    await Promise.race([
      retryStarted.promise,
      executing.then(() => assert.fail("Delivery settled before its native retry")),
    ]);
    controller.abort();
    await assert.rejects(executing, { name: "AbortError" });
    assert.equal(f.provider.requests.length, 1);
    assert.equal(driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
    assert.deepEqual(f.provider.errors, []);
  },
);
test(
  "idle unsolicited native retries recover without another delivery or repeated edit",
  options(ideRuntime),
  async (t) => {
    const recoveryEvents = [];
    const recovery = createProviderRecovery({
      cooldownMs: 25,
      onEvent: (event) => recoveryEvents.push(event),
    });
    const allowContinuation = Promise.withResolvers();
    t.after(() => allowContinuation.resolve());
    let recoveryCalls = 0;
    let recoveryRequest;
    const f = await fixture(
      t,
      ideRuntime,
      idleBackgroundResponses({ status: 429, error: "Rate limit exceeded" }),
      "pi-agent-ide-codemode",
      {
        onRecovery: async (request) => {
          recoveryCalls++;
          recoveryRequest = request;
          const lease = await recovery.wait(request);
          await allowContinuation.promise;
          return lease;
        },
        onProviderFailure: (error) => recovery.stop(error),
      },
    );
    const { driver, initial } = await f.start("idle-recovery");
    const prompt = JSON.stringify({ value: "idle-original" });
    const original = await driver.execute(prompt, { completion: "turn", signal: t.signal });
    assert.deepEqual(identity(original), identity(initial));
    assert.equal(original.failedToolCalls, 0);
    assert.equal(driver.events.filter(({ type }) => type === "agent_settled").length, 1);
    assert.equal(await readFile(path.join(f.workspace, "original-once.txt"), "utf8"), "original\n");
    const held = waitForTrace(t, path.join(f.root, "idle-recovery.jsonl"), driver, (events) =>
      events.some(
        (event) => event.type === "baseline_observation" && event.event === "recovery_wait",
      ),
    );
    await writeFile(path.join(f.workspace, "release-background"), "release\n");
    await held;
    assert.equal(recoveryCalls, 1);
    assert.deepEqual(identity(recoveryRequest), identity(initial));
    assert.equal(recoveryRequest.signal.aborted, false);
    assert.deepEqual(nativeUserMessages(driver), [prompt]);
    assert.equal(
      await readFile(path.join(f.workspace, "background-once.txt"), "utf8"),
      "background\n",
    );
    const completed = waitForTrace(
      t,
      path.join(f.root, "idle-recovery.jsonl"),
      driver,
      (events) =>
        events.filter(({ type }) => type === "agent_settled").length === 2 &&
        events.some(({ type, success }) => type === "provider_recovery_end" && success === true),
    );
    allowContinuation.resolve();
    await completed;
    assert.deepEqual(identity(await driver.assertIdle()), identity(initial));
    assert.equal(f.provider.requests.length, 8);
    assert.equal(recoveryCalls, 1);
    assert.deepEqual(
      recoveryEvents.map(({ type }) => type),
      ["provider_recovery_cooldown", "provider_recovery_probe", "provider_recovery_ready"],
    );
    assert.equal(
      driver.events.filter(
        (event) => event.type === "message_end" && event.message?.stopReason === "error",
      ).length,
      4,
    );
    assert.equal(
      driver.events.filter(({ type, success }) => type === "auto_retry_end" && success === false)
        .length,
      1,
    );
    assert.deepEqual(nativeUserMessages(driver), [prompt]);
    assert.equal(await readFile(path.join(f.workspace, "original-once.txt"), "utf8"), "original\n");
    assert.equal(
      await readFile(path.join(f.workspace, "background-once.txt"), "utf8"),
      "background\n",
    );
    await driver.terminate();
    assert.equal(driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
    assert.deepEqual(f.provider.errors, []);
  },
);

for (const refusal of [
  {
    kind: "billing",
    status: 402,
    error: JSON.stringify({
      type: "server_error",
      message: "Upstream request failed: Insufficient account funds",
    }),
  },
  { kind: "payment-status", status: 402, error: "server_error" },
  { kind: "quota", status: 429, error: "insufficient_quota" },
  { kind: "free-quota", status: 429, error: "FreeUsageLimitError: server_error" },
])
  test(
    `a hard ${refusal.kind} response stops the real participant without retrying completed effects`,
    options(baselineRuntime),
    async (t) => {
      const failures = [];
      let recoveries = 0;
      const recovery = createProviderRecovery({ cooldownMs: 25 });
      const f = await fixture(
        t,
        baselineRuntime,
        (body) =>
          body.messages.at(-1).role === "tool"
            ? { status: refusal.status, error: refusal.error }
            : { command: "printf 'once\\n' >> /workspace/billing-effect.txt" },
        "baseline-agent",
        {
          onRecovery() {
            recoveries++;
            throw Error("A hard refusal entered recovery");
          },
          onProviderFailure(error) {
            failures.push(error);
            recovery.stop(error);
          },
        },
      );
      const { driver, initial } = await f.start("billing-refusal");
      let captured;
      await assert.rejects(
        driver.execute("Perform the assigned file edit", { signal: t.signal }),
        (error) => {
          captured = error;
          return error.category === "provider_failure";
        },
      );
      assert.equal(captured.execution.toolCalls, 1);
      assert.equal(await readFile(path.join(f.workspace, "billing-effect.txt"), "utf8"), "once\n");
      assert.equal(f.provider.requests.length, 2);
      assert.equal(recoveries, 0);
      assert.equal(failures.length, 1);
      await assert.rejects(recovery.admit({ signal: t.signal }), { category: "provider_failure" });
      await assert.rejects(driver.execute("Must not start another delivery"), {
        category: "provider_failure",
      });
      assert.equal(driver.events.filter(({ type }) => type === "auto_retry_start").length, 0);
      await driver.terminate();
      assert.equal(driver.closed, true);
      assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
      assert.deepEqual(f.provider.errors, []);
    },
  );

for (const failure of [
  { kind: "authentication", status: 401, error: "fixture-access-denied" },
  { kind: "quota", status: 429, error: "GoUsageLimitError" },
])
  test(
    `idle unsolicited native ${failure.kind} failure stops admission before another delivery`,
    options(ideRuntime),
    async (t) => {
      const recovery = createProviderRecovery({ cooldownMs: 25 });
      const failures = [];
      let recoveryCalls = 0;
      const f = await fixture(
        t,
        ideRuntime,
        idleBackgroundResponses(failure, 1),
        "pi-agent-ide-codemode",
        {
          onRecovery: () => {
            recoveryCalls++;
            throw Error("Unexpected controller recovery");
          },
          onProviderFailure: (error) => {
            failures.push(error);
            recovery.stop(error);
          },
        },
      );
      const { driver, initial } = await f.start("idle-refusal");
      const prompt = JSON.stringify({ value: "idle-original" });
      await driver.execute(prompt, { completion: "turn", signal: t.signal });
      const failed = waitForTrace(t, path.join(f.root, "idle-refusal.jsonl"), driver, (events) =>
        events.some(({ type }) => type === "provider_terminal_failure"),
      );
      await writeFile(path.join(f.workspace, "release-background"), "release\n");
      await failed;
      assert.equal(failures.length, 1);
      assert.equal(failures[0].category, "provider_failure");
      assert.equal(recoveryCalls, 0);
      await assert.rejects(recovery.admit({ signal: t.signal }), { category: "provider_failure" });
      await assert.rejects(
        driver.execute(JSON.stringify({ value: "must-not-start" }), { completion: "turn" }),
        { category: "provider_failure" },
      );
      assert.equal(f.provider.requests.length, 4);
      assert.equal(driver.events.filter(({ type }) => type === "auto_retry_start").length, 0);
      assert.deepEqual(nativeUserMessages(driver), [prompt]);
      assert.equal(
        await readFile(path.join(f.workspace, "original-once.txt"), "utf8"),
        "original\n",
      );
      assert.equal(
        await readFile(path.join(f.workspace, "background-once.txt"), "utf8"),
        "background\n",
      );
      await driver.terminate();
      assert.equal(driver.closed, true);
      assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
      assert.deepEqual(f.provider.errors, []);
    },
  );

test(
  "idle unsolicited native recovery can be terminated without waiting for its callback",
  options(ideRuntime),
  async (t) => {
    let recoveryRequest;
    const f = await fixture(
      t,
      ideRuntime,
      idleBackgroundResponses({ status: 429, error: "Rate limit exceeded" }),
      "pi-agent-ide-codemode",
      {
        onRecovery: (request) => {
          recoveryRequest = request;
          return new Promise(() => {});
        },
      },
    );
    const { driver, initial } = await f.start("idle-termination");
    const prompt = JSON.stringify({ value: "idle-original" });
    await driver.execute(prompt, { completion: "turn", signal: t.signal });
    const held = waitForTrace(t, path.join(f.root, "idle-termination.jsonl"), driver, (events) =>
      events.some(
        (event) => event.type === "baseline_observation" && event.event === "recovery_wait",
      ),
    );
    await writeFile(path.join(f.workspace, "release-background"), "release\n");
    await held;
    assert.ok(recoveryRequest);
    assert.equal(recoveryRequest.signal.aborted, false);
    assert.deepEqual(nativeUserMessages(driver), [prompt]);
    assert.equal(f.provider.requests.length, 7);
    await driver.terminate();
    assert.equal(recoveryRequest.signal.aborted, true);
    assert.equal(driver.closed, true);
    assert.deepEqual(await liveNamespaceProcesses(initial.process), []);
    assert.equal(f.provider.requests.length, 7);
    assert.equal(await readFile(path.join(f.workspace, "original-once.txt"), "utf8"), "original\n");
    assert.equal(
      await readFile(path.join(f.workspace, "background-once.txt"), "utf8"),
      "background\n",
    );
    assert.deepEqual(f.provider.errors, []);
  },
);

for (const { kind, status, error } of [
  { kind: "authentication", status: 401, error: "fixture-access-denied" },
  { kind: "quota", status: 429, error: "GoUsageLimitError" },
  { kind: "billing", status: 429, error: "insufficient_quota" },
])
  test(
    `turn completion reports provider failure without a retry (${kind})`,
    options(ideRuntime),
    async (t) => {
      const f = await fixture(t, ideRuntime, () => ({ error, status }), "pi-agent-ide-codemode");
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
    },
  );
