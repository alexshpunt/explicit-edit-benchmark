import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeAdapter } from "../../scripts/prepare-benchmark.mjs";
import { inspectHarnessOutput, recoveryAdapter } from "../../scripts/harness-runtime.mjs";
import { tempDirectory } from "../helpers/temp.mjs";
import { parseRunOptions } from "../../scripts/benchmark-run.mjs";
import { resolveExecutionPlan } from "../../scripts/execution-plan.mjs";
import { declaredToolNames, missingProfileTools } from "../../scripts/pi-codemode-profile.mjs";

const profileTools = [
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
  "select",
  "undo",
];

await test("the Codemode IDE profile keeps standalone tools and resumes the same configuration", async () => {
  const root = await tempDirectory("codemode-profile");
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist/ide.mjs"), "export default function () {}\n");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "pi-agent-ide",
      version: "0.8.1",
      pi: { extensions: ["./dist/ide.mjs"] },
    }),
  );
  const input = {
    command: "/usr/bin/pi",
    model: "provider/model-example",
    thinking: "low",
    version: "1.1.0",
    idePackage: root,
  };
  const old = makeAdapter({ ...input, harness: "pi-agent-ide" });
  const adapter = makeAdapter({ ...input, harness: "pi-agent-ide-codemode" });
  assert.equal(adapter.kind, "pi-agent-ide-codemode");
  assert.ok(adapter.args.includes("builtin:codemode"));
  assert.equal(adapter.args[adapter.args.indexOf("--tools") + 1], "+codemode");
  assert.equal(JSON.parse(adapter.stateFiles["pi/settings.json"]).codemode.mode, "on");
  assert.equal(adapter.env.SHELL, "/bin/bash");
  assert.ok(!old.args.includes("builtin:codemode"));
  assert.equal(old.stateFiles, undefined);
  assert.equal(
    (await readFile(adapter.seedFiles["runner/pi-codemode-profile.mjs"], "utf8")).length > 0,
    true,
  );
  const resumed = recoveryAdapter(adapter, true);
  assert.deepEqual(resumed.args, ["--continue", ...adapter.args]);
  assert.deepEqual(resumed.stateFiles, {});
  assert.deepEqual(resumed.seedFiles, {});
});

await test("the Codemode profile retains Pi tool calls, rounds and usage metrics", async () => {
  const root = await tempDirectory("codemode-metrics");
  const output = path.join(root, "stdout.jsonl");
  await writeFile(
    output,
    [
      { type: "tool_execution_start", toolName: "codemode" },
      { type: "tool_execution_start", toolName: "read", parentToolCallId: "call" },
      { type: "tool_execution_end", result: { isError: false } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  await writeFile(
    path.join(root, "codemode-profile.json"),
    JSON.stringify({ phase: "model", tools: profileTools }),
  );
  const metrics = await inspectHarnessOutput("pi-agent-ide-codemode", output);
  assert.equal(metrics.toolCalls, 2);
  assert.equal(metrics.modelRounds, 1);
  assert.equal(metrics.totalTokens, 12);
  assert.deepEqual(metrics.errors, []);
});

await test("missing or incomplete model-facing loadout evidence fails the Codemode profile", async () => {
  const root = await tempDirectory("codemode-evidence");
  const output = path.join(root, "stdout.jsonl");
  const report = path.join(root, "codemode-profile.json");
  await writeFile(output, "");

  const unobserved = await inspectHarnessOutput("pi-agent-ide-codemode", output);
  assert.equal(unobserved.errors.length, 1);
  assert.equal(unobserved.errors[0].type, "profile_error");

  for (const evidence of [
    "not JSON",
    JSON.stringify({ phase: "active", tools: profileTools }),
    JSON.stringify({ phase: "model", tools: ["codemode"], missing: [] }),
    JSON.stringify({ phase: "model", tools: profileTools.filter((name) => name !== "codemode") }),
  ]) {
    await writeFile(report, evidence);
    const metrics = await inspectHarnessOutput("pi-agent-ide-codemode", output);
    assert.equal(metrics.errors.length, 1, evidence);
    assert.equal(metrics.errors[0].type, "profile_error", evidence);
  }

  const oldProfile = await inspectHarnessOutput("pi-agent-ide", output);
  assert.deepEqual(oldProfile.errors, []);
});

await test("model tool declarations replay additions and removals without trusting user content", () => {
  const messages = [
    { role: "system", toolsAdded: profileTools.map((name) => ({ name })) },
    { role: "system", toolsRemoved: [{ name: "read" }, { name: "delete" }] },
    { role: "user", toolsAdded: [{ name: "delete" }] },
    { role: "assistant", toolsRemoved: [{ name: "codemode" }] },
    { role: "system", toolsAdded: [{ name: "read" }, { name: "read" }] },
  ];
  const original = structuredClone(messages);
  const names = declaredToolNames(messages);
  assert.deepEqual(names, profileTools.filter((name) => name !== "delete").sort());
  assert.deepEqual(missingProfileTools(names), ["delete"]);
  assert.deepEqual(messages, original);
});

await test("Codemode-only declarations do not satisfy the standalone-tool profile", () => {
  const names = declaredToolNames([
    { role: "system", toolsAdded: profileTools.map((name) => ({ name })) },
    {
      role: "system",
      toolsRemoved: profileTools.filter((name) => name !== "codemode").map((name) => ({ name })),
    },
  ]);
  assert.deepEqual(names, ["codemode"]);
  assert.deepEqual(
    missingProfileTools(names),
    profileTools.filter((name) => name !== "codemode"),
  );
  assert.deepEqual(missingProfileTools(profileTools), []);
});

await test("the official Codemode command requires an IDE version and keeps its selected family", () => {
  const args = [
    "--official",
    "--harness",
    "pi-agent-ide-codemode",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--agent-version",
    "1.1.0",
  ];
  assert.throws(() => parseRunOptions(args), /exact installed --harness-version/);
  const options = parseRunOptions([...args, "--harness-version", "0.8.1"]);
  assert.equal(options.harness, "pi-agent-ide-codemode");
  assert.equal(options["harness-version"], "0.8.1");
});

await test("official plans keep old and Codemode IDE families distinct while installing the same packages", async () => {
  const input = {
    adapter: "pi-agent-ide",
    agentVersion: "1.1.0",
    harnessVersion: "0.8.1",
    provider: "openai-codex",
    model: "openai-codex/gpt-5.6-luna",
    reasoning: "low",
  };
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const name = decodeURIComponent(segments[0]);
    const version = segments[1];
    return {
      ok: true,
      json: async () => ({
        name,
        version,
        dependencies: {},
        dist: {
          integrity: "sha512-example",
          tarball: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
        },
      }),
    };
  };
  const old = await resolveExecutionPlan(input, { fetch });
  const codemode = await resolveExecutionPlan(
    { ...input, adapter: "pi-agent-ide-codemode" },
    { fetch },
  );
  assert.equal(old.harnessFamily, "pi-agent-ide");
  assert.equal(codemode.harnessFamily, "pi-agent-ide-codemode");
  assert.equal(codemode.adapter, "pi-agent-ide-codemode");
  assert.notEqual(codemode.planHash, old.planHash);
  assert.deepEqual(codemode.packages, old.packages);
  assert.deepEqual(
    codemode.packages.map(({ role, name, version }) => ({ role, name, version })),
    [
      { role: "agent", name: "@earendil-works/pi-coding-agent", version: "1.1.0" },
      { role: "extension", name: "pi-agent-ide", version: "0.8.1" },
    ],
  );
  assert.ok(requested.every((url) => !url.includes("pi-agent-ide-codemode")));
});

await test("official Codemode plans reject missing and mutable IDE versions before package lookup", async () => {
  const input = {
    adapter: "pi-agent-ide-codemode",
    agentVersion: "1.1.0",
    provider: "openai-codex",
    model: "openai-codex/gpt-5.6-luna",
    reasoning: "low",
  };
  const fetch = async () => {
    assert.fail("invalid versions must fail before package lookup");
  };
  await assert.rejects(resolveExecutionPlan(input, { fetch }), /expected fields/);
  for (const harnessVersion of ["latest", "^0.8.1", "file:../pi-agent-ide"]) {
    await assert.rejects(
      resolveExecutionPlan({ ...input, harnessVersion }, { fetch }),
      /exact semantic version/,
    );
  }
});
