import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { inspectTimelineFile, metricsFromTimeline } from "../../examples/bb/timeline.mjs";
import { resolveBenchmarkProfiles } from "../../scripts/benchmark-config.mjs";
import { tempDirectory } from "../helpers/temp.mjs";

// Shapes recorded from a real bb 0.43.1 thread timeline.
const timeline = [
  { type: "turn/started", data: { providerThreadId: "thr_1" } },
  {
    type: "item/completed",
    data: {
      item: { type: "reasoning", id: "i1", content: ["Inspecting the file"] },
    },
  },
  {
    type: "item/completed",
    data: { item: { type: "fileRead", id: "i2", path: "hello.txt", status: "completed" } },
  },
  {
    type: "item/completed",
    data: {
      item: {
        type: "fileChange",
        id: "i3",
        changes: [{ path: "checkout.md", kind: "add" }],
        status: "completed",
      },
    },
  },
  {
    type: "item/completed",
    data: { item: { type: "toolCall", id: "i4", tool: "insert", status: "completed" } },
  },
  { type: "item/completed", data: { item: { type: "agentMessage", id: "i5", text: "Done." } } },
  {
    type: "thread/tokenUsage/updated",
    data: {
      tokenUsage: {
        total: { totalTokens: 20362, inputTokens: 390, cachedInputTokens: 19968, outputTokens: 4 },
      },
    },
  },
  { type: "turn/completed", data: { status: "completed" } },
];

await test("a bb timeline turns into rounds, calls, and observed tokens", () => {
  const metrics = metricsFromTimeline(timeline);
  assert.equal(metrics.modelRounds, 1);
  assert.equal(metrics.toolCalls, 3);
  assert.deepEqual(
    metrics.calls.map((call) => call.item.type),
    ["read", "edit", "insert"],
  );
  assert.deepEqual(metrics.errors, []);
  assert.equal(metrics.eventCount, timeline.length);
  assert.equal(metrics.modelRounds, 1);
  assert.equal(metrics.inputTokens, 390);
  assert.equal(metrics.outputTokens, 4);
  assert.equal(metrics.cacheReadTokens, 19968);
  assert.equal(metrics.cacheWriteTokens, 0);
  // The parts have to add up to the total bb reported.
  assert.equal(
    metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens,
    metrics.totalTokens,
  );
  assert.equal(metrics.totalTokens, 20362);
});

await test("facts bb does not report stay null instead of zero", () => {
  const metrics = metricsFromTimeline([]);
  assert.equal(metrics.costUsd, null);
  assert.equal(metrics.failedToolCalls, null);
  assert.equal(metrics.invalidToolCalls, null);
  assert.equal(metrics.inputTokens, null);
  assert.equal(metrics.toolCalls, 0);
});

await test("a conversation item is not counted as a tool call", () => {
  const metrics = metricsFromTimeline([
    { type: "item/completed", data: { item: { type: "agentMessage", id: "x", text: "Done." } } },
    { type: "item/completed", data: { item: { type: "toolCall", id: "y", tool: "apply" } } },
  ]);
  assert.deepEqual(
    metrics.calls.map((call) => call.item.type),
    ["apply"],
  );
});

await test("a tool call without a tool name fails instead of being named something", () => {
  assert.throws(
    () => metricsFromTimeline([{ type: "item/completed", data: { item: { type: "toolCall" } } }]),
    /without a tool name/,
  );
});

await test("an item type the mapping does not know fails the run instead of under-counting", () => {
  assert.throws(
    () => metricsFromTimeline([{ type: "item/completed", data: { item: { type: "mystery" } } }]),
    /unknown item type "mystery"/,
  );
});

await test("a failed turn is an observed error", () => {
  const metrics = metricsFromTimeline([{ type: "turn/completed", data: { status: "failed" } }]);
  assert.equal(metrics.errors.length, 1);
});

await test("the parser reads the JSONL file the benchmark hands to inspectOutput", async () => {
  const root = await tempDirectory("bb-timeline");
  const file = path.join(root, "stdout.jsonl");
  await writeFile(file, timeline.map((event) => JSON.stringify(event)).join("\n") + "\nnot json\n");
  const metrics = await inspectTimelineFile(file);
  assert.equal(metrics.toolCalls, 3);
  assert.equal(metrics.totalTokens, 20362);
});

await test("the bb example publishes a complete identity with separate versions", async () => {
  process.env.BB_APP = "/opt/bb/node_modules/bb-app";
  process.env.BB_PROVIDER = "pi";
  process.env.BB_VERSION = "0.43.1";
  process.env.BB_AGENT_VERSION = "0.85.1";
  delete process.env.BB_AGENT_AUTH;
  process.env.BB_AGENT_MODELS = "/etc/bb-example/models.json";
  process.env.BB_NODE_RUNTIME = "/opt/node";
  process.env.BB_SERVER_URL = "http://127.0.0.1:3000";
  process.env.BB_MODEL = "agent-proxy/gpt-5.6-luna";
  process.env.BB_MODEL_PROVIDER = "agent-proxy";
  process.env.BB_TRANSPORT = "agent-proxy-responses";
  const config = (await import("../../examples/bb/benchmark.config.mjs")).default;
  const profiles = await resolveBenchmarkProfiles(config);
  assert.deepEqual(Object.keys(profiles), ["gpt-bb"]);
  const profile = Object.values(profiles)[0];
  assert.equal(profile.harnessFamily, "bb");
  assert.equal(profile.harnessVersion, "0.43.1");
  assert.equal(profile.agentFamily, "pi");
  assert.equal(profile.agentVersion, "0.85.1");
  assert.equal(profile.harnessId, "bb");
  assert.equal(profile.ready, false);
  assert.equal(profile.adapterVersion, "shared-server-1");
  assert.equal(profile.configurationId, "bb/pi/agent-proxy/shared-server");
  assert.deepEqual(profile.configurationLabels, [
    "harness/bb",
    "provider/pi",
    "route/agent-proxy",
    "server/shared",
  ]);
  assert.deepEqual(profile.configuration.runtimeFlags, [
    "thinking=low",
    "environment-provider=project-checkout",
    "server=shared",
  ]);
  assert.deepEqual(profile.readOnly, ["/opt/bb/node_modules", "/opt/node"]);
  assert.deepEqual(profile.args, ["/state/bb/driver.mjs"]);
  assert.deepEqual(profile.driver, {
    command: process.execPath,
    args: ["/state/bb/driver.mjs"],
    persistent: true,
  });
  assert.deepEqual(profile.versionArgs, ["/opt/bb/node_modules/bb-app/dist/bb.js", "--version"]);
  assert.equal(
    profile.seedFiles["bb/driver.mjs"],
    fileURLToPath(new URL("../../examples/bb/driver.mjs", import.meta.url)),
  );
  assert.equal(profile.seedFiles["home/.pi/agent/auth.json"], undefined);
  assert.equal(profile.seedFiles["home/.pi/agent/models.json"], "/etc/bb-example/models.json");
  assert.equal(profile.provider, "agent-proxy");
  assert.equal(profile.transport, "agent-proxy-responses");
  assert.equal(profile.env.BB_SERVER_URL, "http://127.0.0.1:3000");
  assert.equal(profile.env.PATH, "/opt/node/bin:/usr/local/bin:/usr/bin:/bin");
  // Recovery has to continue the same bb thread, because bb cannot restart on a killed state.
  assert.equal(typeof profile.continueSession, "function");
  // The persistent driver continues the thread, so recovery keeps the same adapter.
  assert.equal(profile.continueSession(profile), profile);
});
