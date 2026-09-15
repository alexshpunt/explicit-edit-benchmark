import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { explicitEditContract } from "../../src/suites/explicit-edit/version.ts";
const exec = promisify(execFile);
import { explicitEditTasks } from "../../src/suites/explicit-edit/fixtures.ts";
import { tempDirectory } from "../helpers/temp.mjs";
await test("batch preserves a timed-out trial and runs the next task with the exact verifier", async () => {
  const root = await tempDirectory("harness-queue");
  const shared = {
    command: process.execPath,
    readOnly: [path.dirname(process.execPath)],
    version: process.version,
    harnessVersion: "9.9.9",
    harnessFamily: "test-family",
    configurationId: "test-family/minimal",
    configuration: {
      tools: ["native-edit"],
      extensions: [],
      rules: [],
      runtimeFlags: ["mode=test"],
      environment: [],
    },
    configurationLabels: ["harness/test-family"],
    model: "test-model-not-luna",
    thinking: "medium",
    ready: true,
    kind: "test",
  };
  const config = {
    harnesses: {
      timeout: { ...shared, args: ["-e", "console.log('partial');setInterval(()=>{},1000)"] },
      success: {
        ...shared,
        args: [
          "-e",
          "const fs=require('fs');let x=fs.readFileSync('cases.test.ts','utf8');fs.writeFileSync('cases.test.ts',x.replaceAll('legacyCheckout','stableCheckout'))",
        ],
      },
    },
  };
  const file = path.join(root, "config.json");
  await writeFile(file, JSON.stringify(config));
  const task = explicitEditTasks().find((task) => task.id === "replace-all-10-plain");
  const selection = JSON.stringify({
    version: 1,
    included: [{ id: task.id, fixtureSha256: task.fixtureSha256 }],
  });
  const selectionFile = path.join(root, "selection.json");
  await writeFile(selectionFile, selection);
  await exec(process.execPath, [
    "--import",
    "tsx",
    "scripts/run-harness-batch.mjs",
    "--config",
    file,
    "--task-manifest",
    selectionFile,
    "--retry-failures",
    "2",
    "--concurrency",
    "1",
    "--timeout-seconds",
    "0.5",
    "--results",
    root,
    "--run-id",
    "batch",
  ]);
  const summary = JSON.parse(await readFile(path.join(root, "batch/summary.json"), "utf8"));
  assert.equal(summary.completed, 4);
  assert.equal(await readFile(path.join(root, "batch/focused-selection.json"), "utf8"), selection);
  assert.ok(summary.results.every((row) => row.taskId === task.id));
  assert.equal(summary.retries.firstAttemptPassed, 1);
  assert.equal(summary.retries.eventuallyPassed, 1);
  assert.equal(summary.retries.chains.find((row) => row.profile === "timeout").exhausted, true);
  assert.equal(summary.results.filter((row) => row.profile === "success").length, 1);
  assert.deepEqual(
    summary.results.filter((row) => row.profile === "timeout").map((row) => row.attempt),
    [1, 2, 3],
  );
  assert.equal(summary.results[0].timedOut, true);
  assert.equal(summary.results[0].passed, false);
  const manifest = JSON.parse(await readFile(path.join(root, "batch", "manifest.json"), "utf8"));
  assert.equal(manifest.harnesses.success.version, process.version);
  // Published identity is the harness family, not the runtime kind.
  assert.equal(manifest.harnesses.success.harnessId, "test-family");
  assert.equal(manifest.harnesses.success.harnessVersion, "9.9.9");
  assert.equal(manifest.harnesses.timeout.harnessVersion, "9.9.9");
  assert.equal(manifest.harnesses.success.configurationId, "test-family/minimal");
  assert.deepEqual(manifest.harnesses.success.configuration, shared.configuration);
  assert.equal(manifest.contract, explicitEditContract);
  // The run records the rules it was judged by, not a commit that a rewrite can invalidate.
  assert.equal(manifest.evalCommit, undefined);
  assert.equal(
    manifest.verifierSha256,
    createHash("sha256")
      .update(await readFile(path.resolve("src/suites/explicit-edit/files.ts")))
      .digest("hex"),
  );
  assert.equal(summary.results[1].passed, true);
});
