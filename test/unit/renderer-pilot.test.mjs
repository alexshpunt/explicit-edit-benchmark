import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { selectedTasks } from "../../scripts/focused-selection.mjs";

const execFile = promisify(execFileCallback);
const cli = path.resolve("scripts/multi-agent/experiments/pilot.mjs");
const run = (args, options = {}) => execFile(process.execPath, [cli, ...args], options);

await test("the pilot refuses implicit live calls and unsupported harnesses before creating a trial", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/pilot-gates-"));
  try {
    const output = path.join(root, "untouched");
    await assert.rejects(run(["live", "missing", output, "missing-config"]), (error) => {
      assert.match(error.stderr, /explicit.*allow-model-calls/i);
      return true;
    });
    const config = path.join(root, "config.json");
    await writeFile(config, JSON.stringify({ harness: "codex-cli-default" }));
    await assert.rejects(run(["ready", "--live", config]), (error) => {
      assert.match(error.stderr, /unsupported.*harness/i);
      return true;
    });
    await writeFile(
      config,
      JSON.stringify({
        harness: "baseline-agent",
        runtime: root,
        model: "fixture/test",
        thinking: "off",
      }),
    );
    await assert.rejects(run(["ready", "--live", config]), (error) => {
      assert.match(error.stderr, /Pi runtime/i);
      return true;
    });
    await writeFile(config, JSON.stringify({ harness: "baseline-agent" }));
    await assert.rejects(run(["verify", "missing", output, config]), (error) => {
      assert.match(error.stderr, /scripted/i);
      return true;
    });
    await assert.rejects(access(output), { code: "ENOENT" });
    const help = await run(["--help"]);
    assert.match(help.stdout, /experimental/i);
    assert.match(help.stdout, /11/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("readiness fails on a missing compiler and experimental artifacts cannot enter V1 selection or export", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/pilot-boundaries-"));
  try {
    await assert.rejects(run(["ready"], { env: { PATH: root } }), (error) => {
      assert.match(error.stderr, /Clang 18/i);
      return true;
    });
    const pilot = { version: "renderer-pilot-v1", status: "pass", steps: 11 };
    assert.throws(() => selectedTasks([], pilot), /Invalid selection manifest/);
    assert.throws(
      () =>
        selectedTasks([], {
          version: 1,
          included: [{ id: "step-01", fixtureSha256: "0".repeat(64) }],
        }),
      /Unknown, duplicate or changed task/,
    );
    await writeFile(
      path.join(root, "summary.json"),
      JSON.stringify({ version: "renderer-chain-summary-v1", passedPrefix: 11 }),
    );
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(pilot));
    await assert.rejects(
      execFile(process.execPath, ["--import", "tsx", "scripts/export-oracle-benchmark.mjs", root]),
    );
    await assert.rejects(access(path.join(root, "public")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
