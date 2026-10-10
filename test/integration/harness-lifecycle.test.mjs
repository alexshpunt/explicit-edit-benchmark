import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tempDirectory } from "../helpers/temp.mjs";
import { closeHarness, runHarness, inspectHarnessOutput } from "../../scripts/harness-runtime.mjs";
import { harnessParticipant } from "../../scripts/harness-participant.mjs";

async function fixture(t, script, persistent) {
  const root = await tempDirectory("harness-lifecycle-");
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  await mkdir(workspace);
  t.after(async () => {
    await closeHarness(state);
    await rm(root, { recursive: true, force: true });
  });
  const command = { command: process.execPath, args: ["-e", script] };
  return {
    workspace,
    state,
    artifact: (name) => path.join(root, name),
    adapter: persistent
      ? {
          kind: "custom",
          command: "/usr/bin/true",
          args: [],
          driver: { ...command, persistent: true },
        }
      : { kind: "custom", ...command, promptStdin: true },
  };
}

async function waitForStarted(workspace) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await access(path.join(workspace, "started"));
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw Error("The actual isolated harness did not start");
}

await test(
  "an untimed persistent harness completes later turns in the same process and workspace",
  { timeout: 5000 },
  async (t) => {
    const context = await fixture(
      t,
      `
const fs = require("node:fs");
const input = require("node:readline").createInterface({input: process.stdin});
let turn = 0;
input.on("line", async line => {
  const { prompt } = JSON.parse(line);
  await new Promise(resolve => setTimeout(resolve, 80));
  turn++;
  fs.appendFileSync("/workspace/edits", prompt + "\\n");
  console.log(JSON.stringify({type: "observation", turn, pid: process.pid}));
  console.log(JSON.stringify({type: "eval/turn-complete", reason: {kind: "completed"}}));
});`,
      true,
    );
    const outputs = [];
    for (const prompt of ["first", "second"]) {
      const artifacts = context.artifact(prompt);
      const result = await runHarness(context.adapter, {
        workspace: context.workspace,
        state: context.state,
        artifacts,
        prompt,
        timeoutMs: null,
      }).catch(async (cause) => {
        throw Error(await readFile(path.join(artifacts, "stderr.log"), "utf8"), { cause });
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      outputs.push(
        JSON.parse((await readFile(path.join(artifacts, "stdout.jsonl"), "utf8")).trim()),
      );
    }
    assert.deepEqual(
      outputs.map((item) => item.turn),
      [1, 2],
    );
    assert.equal(outputs[0].pid, outputs[1].pid);
    assert.equal(await readFile(path.join(context.workspace, "edits"), "utf8"), "first\nsecond\n");
  },
);

await test(
  "a one-shot adapter also honors the absence of a delivery deadline",
  { timeout: 5000 },
  async (t) => {
    const context = await fixture(
      t,
      `
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => setTimeout(() => fs.writeFileSync("/workspace/edited", "done"), 80));`,
      false,
    );
    const result = await runHarness(context.adapter, {
      workspace: context.workspace,
      state: context.state,
      artifacts: context.artifact("delivery"),
      prompt: "edit",
      timeoutMs: null,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(await readFile(path.join(context.workspace, "edited"), "utf8"), "done");
  },
);

await test(
  "a persistent delivery timeout retains output and closes the process before returning",
  { timeout: 5000 },
  async (t) => {
    const context = await fixture(
      t,
      `
require("node:readline").createInterface({input: process.stdin}).on("line", () => {
  console.log("partial");
  setTimeout(() => require("node:fs").writeFileSync("/workspace/late-edit", "bad"), 500);
});`,
      true,
    );
    const result = await runHarness(context.adapter, {
      workspace: context.workspace,
      state: context.state,
      artifacts: context.artifact("timeout"),
      prompt: "start",
      timeoutMs: 200,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 1);
    assert.match(
      await readFile(path.join(context.artifact("timeout"), "stdout.jsonl"), "utf8"),
      /partial/,
    );
    await delay(550);
    await assert.rejects(access(path.join(context.workspace, "late-edit")), { code: "ENOENT" });
  },
);

await test("a pre-cancelled delivery does not seed state or launch a process", async (t) => {
  const context = await fixture(
    t,
    'require("node:fs").writeFileSync("/workspace/started", "bad")',
    false,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runHarness(context.adapter, {
      workspace: context.workspace,
      state: context.state,
      artifacts: context.artifact("pre-cancelled"),
      prompt: "start",
      timeoutMs: null,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  await assert.rejects(access(context.state), { code: "ENOENT" });
  await assert.rejects(access(path.join(context.workspace, "started")), { code: "ENOENT" });
});
for (const persistent of [false, true]) {
  await test(
    `cancelling a ${persistent ? "persistent" : "one-shot"} delivery waits for its namespace to close and prevents late writes`,
    { timeout: 5000 },
    async (t) => {
      const start = `
const fs = require("node:fs");
function start() {
  fs.writeFileSync("/workspace/started", "yes");
  setTimeout(() => {
    fs.writeFileSync("/workspace/late-edit", "bad");
    ${persistent ? 'console.log(JSON.stringify({type: "eval/turn-complete", reason: {kind: "completed"}}));' : ""}
  }, 500);
}`;
      const script =
        start +
        (persistent
          ? 'require("node:readline").createInterface({input:process.stdin}).on("line", start);'
          : 'process.stdin.resume(); process.stdin.on("end", start);');
      const context = await fixture(t, script, persistent);
      const controller = new AbortController();
      const delivery = runHarness(context.adapter, {
        workspace: context.workspace,
        state: context.state,
        artifacts: context.artifact("cancelled"),
        prompt: "start",
        timeoutMs: 3000,
        signal: controller.signal,
      });
      // Attach rejection handling before aborting the real process.
      const rejected = assert.rejects(delivery, (error) => error.name === "AbortError");
      await waitForStarted(context.workspace);
      controller.abort();
      await rejected;
      await delay(550);
      await assert.rejects(access(path.join(context.workspace, "late-edit")), { code: "ENOENT" });
      await access(path.join(context.artifact("cancelled"), "stdout.jsonl"));
    },
  );
}

for (const persistent of [false, true]) {
  await test(
    `a cancelled ${persistent ? "persistent" : "one-shot"} participant keeps finalized native usage and tool evidence`,
    { timeout: 5000 },
    async (t) => {
      const start = `
const fs = require("node:fs");
function start() {
  console.log(JSON.stringify({type:"tool_execution_start", toolName:"bash", args:{command:"private-command-marker"}}));
  console.log(JSON.stringify({type:"message_end", message:{role:"assistant", usage:{input:8, output:2, cacheRead:4, cacheWrite:0, totalTokens:14, cost:{total:0.25}}}}));
  fs.writeFileSync("/workspace/started", "yes");
  setTimeout(() => fs.writeFileSync("/workspace/late-edit", "bad"), 500);
}`;
      const script =
        start +
        (persistent
          ? 'require("node:readline").createInterface({input:process.stdin}).on("line", start);'
          : 'process.stdin.resume(); process.stdin.on("end", start);');
      const context = await fixture(t, script, persistent);
      context.adapter.inspectOutput = (file) => inspectHarnessOutput("pi-default", file);
      const artifacts = context.artifact("participant");
      const participant = harnessParticipant(context.adapter, {
        workspace: context.workspace,
        state: context.state,
        artifacts,
      });
      t.after(() => participant.close());
      const controller = new AbortController();
      const delivery = participant.execute("start", {
        signal: controller.signal,
        round: "round-001",
        attempt: 1,
      });
      const rejected = assert.rejects(delivery, (error) => {
        assert.equal(error.name, "AbortError");
        assert.equal(error.receipt.totalTokens, 14);
        assert.equal(error.receipt.costUsd, 0.25);
        assert.equal(error.receipt.toolCalls, 1);
        assert.equal(error.receipt.timedOut, false);
        assert.ok(error.receipt.processSeconds > 0);
        assert.notEqual(error.receipt.exitCode, 0);
        return true;
      });
      await waitForStarted(context.workspace);
      controller.abort();
      await rejected;
      const directory = path.join(artifacts, "round-001-attempt-1");
      const receipt = JSON.parse(await readFile(path.join(directory, "execution.json"), "utf8"));
      assert.equal(receipt.totalTokens, 14);
      assert.ok(!JSON.stringify(receipt).includes("private-command-marker"));
      assert.equal(
        JSON.parse(await readFile(path.join(directory, "tool-calls.json"), "utf8")).length,
        1,
      );
      await delay(550);
      await assert.rejects(access(path.join(context.workspace, "late-edit")), { code: "ENOENT" });
    },
  );
}

await test(
  "participants sharing an abort signal keep distinct native receipts",
  { timeout: 5000 },
  async (t) => {
    const controller = new AbortController();
    const contexts = [];
    const outcomes = [];
    for (const tokens of [14, 28]) {
      const context = await fixture(
        t,
        `
require("node:readline").createInterface({input:process.stdin}).on("line", () => {
  console.log(JSON.stringify({type:"message_end", message:{role:"assistant", usage:{input:${tokens}, output:0, cacheRead:0, cacheWrite:0, totalTokens:${tokens}, cost:{total:0.25}}}}));
  require("node:fs").writeFileSync("/workspace/started", "yes");
});`,
        true,
      );
      contexts.push(context);
      context.adapter.inspectOutput = (file) => inspectHarnessOutput("pi-default", file);
      const participant = harnessParticipant(context.adapter, {
        workspace: context.workspace,
        state: context.state,
        artifacts: context.artifact("participant"),
      });
      t.after(() => participant.close());
      outcomes.push(
        participant
          .execute("start", { signal: controller.signal, round: "round-001", attempt: 1 })
          .then(
            () => assert.fail("Cancelled participant resolved"),
            (error) => error,
          ),
      );
    }
    await Promise.all(contexts.map((context) => waitForStarted(context.workspace)));
    controller.abort();
    const errors = await Promise.all(outcomes);
    assert.notEqual(errors[0], errors[1]);
    assert.deepEqual(
      errors.map((error) => error.receipt.totalTokens),
      [14, 28],
    );
    for (const error of errors) assert.equal(error.cause, controller.signal.reason);
    assert.equal(controller.signal.reason.receipt, undefined);
  },
);
