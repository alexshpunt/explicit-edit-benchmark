import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_IDE_RUNTIME;
const options = { skip: process.platform !== "linux" || !runtime, timeout: 60000 };
const requiredTools = [
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
];

function checkLoadout(requests) {
  assert.ok(requests.length > 0);
  for (const request of requests) {
    const names = new Set(request.tools.map((tool) => tool.function.name));
    for (const name of requiredTools) assert.ok(names.has(name), name);
    assert.ok(
      request.messages.some(
        (message) => ["system", "developer"].includes(message.role) && message.content?.length > 0,
      ),
    );
  }
}

async function namedToolProvider(root, respond) {
  return providerFixture(root, async (body, number) => {
    const toolCall = await respond(body, number);
    return toolCall ? { toolCall } : {};
  });
}

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

async function assertNamespaceClosed(identity) {
  assert.deepEqual(await liveNamespaceProcesses(identity), []);
}

async function fixture(t, respond, providerFactory = providerFixture) {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/pi-ide-codemode-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const provider = await providerFactory(root, respond);
  const participants = [];
  const close = async ({ driver, initial }) => {
    await driver.close();
    assert.equal(driver.closed, true);
    if (initial) await assertNamespaceClosed(initial.process);
  };
  t.after(async () => {
    const closed = await Promise.allSettled(participants.map(close));
    provider.close();
    await rm(root, { recursive: true, force: true });
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  });
  return {
    root,
    workspace,
    provider,
    close,
    async start(name) {
      const state = path.join(root, name);
      const driver = await startBaseline(
        workspace,
        state,
        {
          ...provider.config,
          runtime,
          harness: "pi-agent-ide-codemode",
        },
        { enforceProcessBoundary: true, eventsFile: path.join(root, `${name}.jsonl`) },
      );
      const participant = { driver, state, initial: undefined };
      participants.push(participant);
      participant.initial = await driver.assertIdle();
      assert.equal(participant.initial.messageCount, 0);
      assert.equal(participant.initial.model, "fixture/deterministic");
      assert.equal(participant.initial.thinking, "off");
      return participant;
    },
  };
}

function userPayload(message) {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  return JSON.parse(content);
}

function identity(receipt) {
  return [receipt.sessionId, receipt.lifetime, receipt.agentPid];
}

test(
  "real IDE combines Codemode edits and standalone tools while retaining correction context",
  options,
  async (t) => {
    const f = await fixture(
      t,
      (body, number) => {
        assert.ok(number <= 8);
        const phase = (number - 1) % 4;
        const previous = number <= 4 ? "before" : "first";
        const next = number <= 4 ? "first" : "corrected";
        if (phase === 0) {
          const schema = body.tools.find((tool) => tool.function.name === "codemode").function
            .parameters;
          assert.equal(schema.properties.code.type, "string");
          return {
            name: "codemode",
            arguments: {
              code: `
const previous = load("phase");
if (previous !== ${number <= 4 ? "undefined" : JSON.stringify("first")}) throw Error("Unexpected fixture state");
const source = await tools.read({ path: "/workspace/item.txt" });
const selected = await tools.search({ path: source, query: "stage=${previous}" });
if (!selected.hasMatches || !selected.complete) throw Error("Missing fixture edit selection");
text(await tools.replace({ path: selected.result, text: "stage=${next}" }));
store("phase", "${next}");
`,
            },
          };
        }
        if (phase === 1) return { name: "read", arguments: { path: "/workspace/item.txt" } };
        if (phase === 2)
          return {
            name: "bash",
            arguments: { command: "printf 'native-pty\\n' >> /workspace/pty.txt" },
          };
        return undefined;
      },
      namedToolProvider,
    );
    const source = "header\r\nstage=before\r\nunchanged: café 😀\r\n";
    await writeFile(path.join(f.workspace, "item.txt"), source);
    const participant = await f.start("composed");
    const { driver, state, initial } = participant;
    assert.equal(f.provider.requests.length, 0);
    for (const stage of ["first", "corrected"]) {
      const receipt = await driver.execute(JSON.stringify({ stage }));
      assert.deepEqual(identity(receipt), identity(initial));
      assert.equal(
        receipt.failedToolCalls,
        0,
        JSON.stringify(
          driver.events.filter((event) => event.type === "tool_execution_end" && event.isError),
        ),
      );
      assert.equal(
        await readFile(path.join(f.workspace, "item.txt"), "utf8"),
        source.replace("stage=before", `stage=${stage}`),
      );
      const calls = f.provider.requests.length;
      const idle = await driver.assertIdle();
      assert.deepEqual(idle.process, initial.process);
      assert.equal(idle.messageCount, receipt.messageCount);
      assert.equal(f.provider.requests.length, calls);
    }
    assert.equal(
      await readFile(path.join(f.workspace, "pty.txt"), "utf8"),
      "native-pty\nnative-pty\n",
    );
    const starts = driver.events.filter((event) => event.type === "tool_execution_start");
    const nested = starts.filter((event) => event.parentToolCallId);
    assert.deepEqual(
      nested.map((event) => event.toolName),
      ["read", "search", "replace", "read", "search", "replace"],
    );
    assert.deepEqual(
      starts.filter((event) => !event.parentToolCallId).map((event) => event.toolName),
      ["codemode", "read", "bash", "codemode", "read", "bash"],
    );
    const observations = driver.events.filter(
      (event) => event.type === "baseline_observation" && event.event === "context",
    );
    assert.ok(observations.length >= f.provider.requests.length);
    for (const observed of observations) {
      assert.equal(observed.systemEmpty, false);
      for (const name of requiredTools) {
        assert.ok(observed.tools.includes(name), name);
        assert.ok(observed.declaredTools.includes(name), name);
      }
    }
    const guard = JSON.parse(await readFile(path.join(state, "pi/codemode-profile.json"), "utf8"));
    assert.equal(guard.phase, "model");
    assert.deepEqual(guard.missing, []);
    for (const name of requiredTools) assert.ok(guard.tools.includes(name), name);
    checkLoadout(f.provider.requests);
    assert.deepEqual(f.provider.errors, []);
    await f.close(participant);
  },
);

test(
  "fresh native IDE deliveries keep source changes without inheriting the previous conversation",
  options,
  async (t) => {
    const f = await fixture(t, (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const { value } = userPayload(body.messages.findLast((message) => message.role === "user"));
      return { command: `printf '%s\\n' '${value}' >> /workspace/edits.txt` };
    });
    const first = await f.start("original-one");
    const firstReceipt = await first.driver.execute(JSON.stringify({ value: "first-delivery" }));
    assert.equal(firstReceipt.failedToolCalls, 0);
    await f.close(first);
    const second = await f.start("original-two");
    assert.notEqual(second.initial.sessionId, first.initial.sessionId);
    assert.notEqual(second.initial.lifetime, first.initial.lifetime);
    assert.notEqual(second.initial.process.agentHostPid, first.initial.process.agentHostPid);
    assert.notEqual(second.initial.process.namespace, first.initial.process.namespace);
    const secondReceipt = await second.driver.execute(JSON.stringify({ value: "second-delivery" }));
    assert.equal(secondReceipt.failedToolCalls, 0);
    assert.deepEqual(identity(secondReceipt), identity(second.initial));
    assert.equal(
      await readFile(path.join(f.workspace, "edits.txt"), "utf8"),
      "first-delivery\nsecond-delivery\n",
    );
    const last = f.provider.requests.findLast((body) => body.messages.at(-1).role === "user");
    assert.deepEqual(last.messages.filter((message) => message.role === "user").map(userPayload), [
      { value: "second-delivery" },
    ]);
    checkLoadout(f.provider.requests);
    assert.deepEqual(f.provider.errors, []);
    await f.close(second);
  },
);

test(
  "native C++ IDE keeps its language service alive until the participant closes",
  options,
  async (t) => {
    const source = "#pragma once\ninline constexpr int answer = 1;\n";
    const updated = source.replace("answer = 1", "answer = 2");
    const f = await fixture(
      t,
      (_body, number) => {
        if (number === 1)
          return { name: "write", arguments: { path: "/workspace/item.h", content: updated } };
        if (number === 2)
          return { name: "read", arguments: { path: "/workspace/item.h", views: ["diagnostics"] } };
        assert.equal(number, 3);
        return undefined;
      },
      namedToolProvider,
    );
    await writeFile(path.join(f.workspace, "item.h"), source);
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
    const participant = await f.start("cpp-service");
    const { driver, initial } = participant;
    const receipt = await driver.execute("Apply the C++ header edit and inspect diagnostics.");
    assert.equal(receipt.failedToolCalls, 0);
    assert.equal(await readFile(path.join(f.workspace, "item.h"), "utf8"), updated);
    const calls = f.provider.requests.length;
    assert.equal(calls, 3);
    assert.deepEqual((await driver.assertIdle()).process, initial.process);
    assert.equal(f.provider.requests.length, calls);
    const processes = await liveNamespaceProcesses(initial.process);
    assert.ok(
      processes.some(
        (pid) => ![initial.process.rootPid, initial.process.agentHostPid].includes(pid),
      ),
    );
    checkLoadout(f.provider.requests);
    assert.deepEqual(f.provider.errors, []);
    await f.close(participant);
  },
);

test(
  "cancelling a native IDE Bash call closes its namespace and prevents delayed edits",
  options,
  async (t) => {
    const f = await fixture(t, (body) =>
      body.messages.at(-1).role === "tool"
        ? {}
        : {
            command: "printf ready > /workspace/started; sleep 2; printf late > /workspace/late",
          },
    );
    const participant = await f.start("cancelled");
    const { driver } = participant;
    const started = Promise.withResolvers();
    const watcher = watch(f.workspace, (_event, filename) => {
      if (filename === "started") started.resolve();
    });
    t.after(() => watcher.close());
    watcher.on("error", started.reject);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const executing = driver.execute("Run the pending edit", { signal: controller.signal });
    executing.catch(() => {});
    await Promise.race([
      started.promise,
      executing.then(() => assert.fail("Tool settled before cancellation")),
    ]);
    await assert.rejects(driver.assertIdle(), { category: "driver_exit" });
    controller.abort();
    await assert.rejects(executing, { name: "AbortError" });
    assert.equal(driver.closed, true);
    const calls = f.provider.requests.length;
    await assert.rejects(driver.execute("Must not restart"), { name: "AbortError" });
    assert.equal(f.provider.requests.length, calls);
    await f.close(participant);
    await delay(2100);
    await assert.rejects(readFile(path.join(f.workspace, "late")), { code: "ENOENT" });
    checkLoadout(f.provider.requests);
    assert.deepEqual(f.provider.errors, []);
  },
);
