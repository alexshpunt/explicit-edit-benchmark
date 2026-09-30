import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { tempDirectory } from "../helpers/temp.mjs";
import {
  closeHarness,
  inspectHarnessOutput,
  recoveryAdapter,
  runHarness,
} from "../../scripts/harness-runtime.mjs";

await test("custom harnesses own event parsing and continuation", async () => {
  const adapter = {
    kind: "custom",
    args: ["run"],
    inspectOutput: (file) => ({
      calls: [{ file }],
      toolCalls: 1,
      modelRounds: 1,
      errors: [],
    }),
    continueSession: (current) => ({ ...current, args: ["resume"] }),
    seedFiles: { "home/auth": "/private/auth" },
    stateFiles: { "home/config": "config" },
  };
  const metrics = await inspectHarnessOutput(adapter, "/tmp/events.jsonl");
  assert.equal(metrics.toolCalls, 1);
  assert.deepEqual(metrics.calls, [{ file: "/tmp/events.jsonl" }]);
  const resumed = recoveryAdapter(adapter, true);
  assert.deepEqual(resumed.args, ["resume"]);
  assert.deepEqual(resumed.seedFiles, {});
  assert.deepEqual(resumed.stateFiles, {});
});
await test("Pi and Codex metrics use finalized events without double-counting", async () => {
  const root = await tempDirectory("usage-metrics-test");
  const piOutput = path.join(root, "pi.jsonl");
  await writeFile(
    piOutput,
    [
      { type: "message_update", usage: { totalTokens: 999 } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 135,
            cost: { total: 0.01 },
          },
        },
      },
      { type: "tool_execution_end", result: { isError: true } },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  assert.deepEqual(await inspectHarnessOutput("pi-agent-ide", piOutput), {
    toolCalls: 0,
    modelRounds: 1,
    errors: [],
    calls: [],
    eventCount: 3,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    totalTokens: 135,
    failedToolCalls: 1,
    invalidToolCalls: null,
    providerFailure: null,
  });

  assert.deepEqual(
    await inspectHarnessOutput("pi-aft", piOutput),
    await inspectHarnessOutput("pi-agent-ide", piOutput),
  );
  const codexOutput = path.join(root, "codex.jsonl");
  await writeFile(
    codexOutput,
    [
      {
        type: "item.completed",
        item: { type: "command_execution", status: "completed", exit_code: 1 },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          cache_write_input_tokens: 10,
          output_tokens: 20,
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  const codex = await inspectHarnessOutput("codex-cli-default", codexOutput);
  assert.deepEqual(
    {
      inputTokens: codex.inputTokens,
      outputTokens: codex.outputTokens,
      cacheReadTokens: codex.cacheReadTokens,
      cacheWriteTokens: codex.cacheWriteTokens,
      totalTokens: codex.totalTokens,
      failedToolCalls: codex.failedToolCalls,
      costUsd: codex.costUsd,
    },
    {
      inputTokens: 30,
      outputTokens: 20,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      totalTokens: 120,
      failedToolCalls: 1,
      costUsd: null,
    },
  );
});
await test("DeepSeek Harness metrics come from its SDK session events", async () => {
  const root = await tempDirectory("dsh-metrics-test");
  const output = path.join(root, "stdout.jsonl");
  await writeFile(
    output,
    [
      JSON.stringify({ type: "turn/start" }),
      JSON.stringify({ type: "tool/call" }),
      JSON.stringify({ type: "assistant/message" }),
      JSON.stringify({ type: "turn/end", data: { reason: { kind: "completed" } } }),
    ].join("\n"),
  );
  const metrics = await inspectHarnessOutput("dsh-standard", output);
  assert.equal(metrics.modelRounds, 1);
  assert.equal(metrics.toolCalls, 1);
  assert.deepEqual(metrics.errors, []);
});

await test("Copilot rounds follow its streamed turn boundaries", async () => {
  const root = await tempDirectory("copilot-metrics-test");
  const output = path.join(root, "stdout.jsonl");
  await writeFile(
    output,
    [
      JSON.stringify({ type: "assistant.turn_start" }),
      JSON.stringify({ type: "tool.execution_start" }),
      JSON.stringify({ type: "assistant.turn_start" }),
    ].join("\n"),
  );
  const metrics = await inspectHarnessOutput("github-copilot-cli-default", output);
  assert.equal(metrics.modelRounds, 2);
  assert.equal(metrics.toolCalls, 1);
});

await test("persistent drivers keep one process across recovery rounds", async () => {
  const root = await tempDirectory("persistent-harness-test");
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  await mkdir(workspace);
  const adapter = {
    command: "/usr/bin/true",
    args: [],
    readOnly: [path.dirname(process.execPath)],
    driver: {
      command: process.execPath,
      persistent: true,
      args: [
        "-e",
        "const r=require('readline').createInterface({input:process.stdin});r.on('line',l=>{const {prompt}=JSON.parse(l);console.log(JSON.stringify({type:'assistant/message',data:{prompt}}));console.log(JSON.stringify({type:'eval/turn-complete',reason:{kind:'completed'}}))})",
      ],
    },
  };
  const first = await runHarness(adapter, {
    workspace,
    state,
    artifacts: path.join(root, "round-1"),
    prompt: "first",
    timeoutMs: 5000,
  });
  const second = await runHarness(adapter, {
    workspace,
    state,
    artifacts: path.join(root, "round-2"),
    prompt: "second",
    timeoutMs: 5000,
  });
  await closeHarness(state);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.match(await readFile(path.join(root, "round-1/stdout.jsonl"), "utf8"), /first/);
  assert.match(await readFile(path.join(root, "round-2/stdout.jsonl"), "utf8"), /second/);
});

await test("CLI sandbox isolates verifier and host secrets, keeps partial timeout output and runs the next trial", async () => {
  const root = await tempDirectory("harness-test");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const secret = path.join(root, "expected.txt");
  await writeFile(secret, "not available");
  const common = { workspace, prompt: "", timeoutMs: 5000 };
  const result = await runHarness(
    {
      command: process.execPath,
      readOnly: [path.dirname(process.execPath)],
      args: [
        "-e",
        `const fs=require('fs');if(fs.existsSync(${JSON.stringify(secret)})||fs.existsSync(${JSON.stringify(path.join(os.homedir(), ".pi/agent/auth.json"))}))process.exit(2);fs.writeFileSync('result.txt','OK');fs.mkdirSync('/state/transcript');fs.writeFileSync('/state/transcript/session.jsonl','trajectory');console.log('isolated')`,
      ],
      stateArtifacts: { transcript: "session" },
    },
    { ...common, state: path.join(root, "state1"), artifacts: path.join(root, "artifacts1") },
  );
  assert.equal(
    result.exitCode,
    0,
    await readFile(path.join(root, "artifacts1/stderr.log"), "utf8"),
  );
  assert.equal(await readFile(path.join(workspace, "result.txt"), "utf8"), "OK");
  assert.equal(
    await readFile(path.join(root, "artifacts1/session/session.jsonl"), "utf8"),
    "trajectory",
  );
  const timeout = await runHarness(
    {
      command: process.execPath,
      readOnly: [path.dirname(process.execPath)],
      args: ["-e", "console.log('partial');setInterval(()=>{},1000)"],
    },
    {
      ...common,
      timeoutMs: 500,
      state: path.join(root, "state2"),
      artifacts: path.join(root, "artifacts2"),
    },
  );
  assert.equal(timeout.timedOut, true);
  assert.match(await readFile(path.join(root, "artifacts2/stdout.jsonl"), "utf8"), /partial/);
  const next = await runHarness(
    { command: "/usr/bin/true", args: [] },
    { ...common, state: path.join(root, "state3"), artifacts: path.join(root, "artifacts3") },
  );
  assert.equal(next.exitCode, 0);
});
