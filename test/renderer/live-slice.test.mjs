import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { liveSlice } from "../../scripts/multi-agent/experiments/live-run.mjs";
import { rebuildReport } from "../../scripts/multi-agent/experiments/chain-report.mjs";
import {
  readTree,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const preparation = process.env.RENDERER_PILOT_PREPARATION;
const initial = preparation
  ? path.resolve(preparation, "slice/workspace")
  : process.env.RENDERER_INITIAL_SOURCE;
const workloadPath = preparation
  ? path.resolve(preparation, "slice/trusted/workload.json")
  : process.env.RENDERER_WORKLOAD;
const output = process.env.RENDERER_LIVE_OUTPUT;
assert.ok(
  initial && workloadPath && output && process.env.RENDERER_PI_RUNTIME,
  "Set explicit renderer input, workload, new evidence directory and Pi runtime",
);

const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

test(
  "one real Pi bash-only session passes the unchanged eleven-step slice and trusted grader",
  { timeout: 1200000 },
  async (t) => {
    const root = path.resolve(output);
    await mkdir(root);
    const solverDirectory = fileURLToPath(
      new URL("../../src/suites/explicit-edit-multi-agent/", import.meta.url),
    );
    const sources = await Promise.all(
      ["reference/scripted-worker.mjs", "cpp/cpp-tokens.mjs"].map(async (name) => [
        name,
        Buffer.from(await readFile(path.join(solverDirectory, name))).toString("base64"),
      ]),
    );
    const workload = JSON.parse(await readFile(workloadPath, "utf8"));
    const delivered = [];
    const provider = await providerFixture(root, (body) => {
      assert.deepEqual(
        body.tools.map((tool) => tool.function.name),
        ["bash"],
      );
      assert.ok(!body.messages.some((message) => message.role === "system" && message.content));
      if (body.messages.at(-1).role === "tool") return {};
      const current = body.messages.findLast((message) => message.role === "user").content;
      const prompt =
        typeof current === "string" ? current : current.map((part) => part.text ?? "").join("");
      assert.equal(prompt, workload.steps[delivered.length].prompt);
      for (const previous of delivered)
        assert.ok(JSON.stringify(body.messages).includes(JSON.stringify(previous).slice(1, -1)));
      assert.doesNotMatch(prompt, /yocto/i);
      delivered.push(prompt);
      // Ordinary bash edits from only the current request. No inverse records or expected state are used.
      const command =
        "mkdir -p /tmp/fixture-solver/reference /tmp/fixture-solver/cpp; " +
        sources
          .map(
            ([name, source]) =>
              `printf %s ${quote(source)} | base64 -d > /tmp/fixture-solver/${name}`,
          )
          .join("; ") +
        `; printf %s ${quote(prompt)} | node /tmp/fixture-solver/reference/scripted-worker.mjs /workspace`;
      return { command };
    });
    t.after(() => provider.close());
    let report;
    if (preparation) {
      const config = path.join(root, "live-config.json");
      await writeFile(config, JSON.stringify({ harness: "baseline-agent", ...provider.config }));
      const cli = fileURLToPath(
        new URL("../../scripts/multi-agent/experiments/pilot.mjs", import.meta.url),
      );
      const execFile = promisify(execFileCallback);
      const ready = await execFile(process.execPath, [cli, "ready", preparation, "--live", config]);
      assert.match(ready.stdout, /zero model calls/);
      assert.equal(provider.requests.length, 0);
      const result = await execFile(
        process.execPath,
        [cli, "live", preparation, path.join(root, "run"), config, "--allow-model-calls"],
        { timeout: 1200000, maxBuffer: 4 * 1024 * 1024 },
      );
      console.log(result.stdout.trim());
      report = JSON.parse(await readFile(path.join(root, "run/report.json"), "utf8"));
      assert.equal(report.experiment.version, "renderer-pilot-v1");
    } else {
      report = await liveSlice(initial, workloadPath, path.join(root, "run"), provider.config);
    }
    await writeFile(
      path.join(root, "provider-requests.json"),
      JSON.stringify(provider.requests, null, 2) + "\n",
    );
    assert.equal(report.status, "pass");
    assert.equal(report.livePi, true);
    assert.equal(report.agentClosed, true);
    assert.equal(report.passedPrefix, 11);
    assert.equal(report.attempts.length, 11);
    assert.equal(delivered.length, 11);
    for (const key of ["lifetime", "agentPid", "sessionId"])
      assert.equal(new Set(report.attempts.map((attempt) => attempt.execution[key])).size, 1);
    const cachedSummary = JSON.parse(await readFile(path.join(root, "run/summary.json"), "utf8"));
    await writeFile(path.join(root, "run/report.json"), "damaged cached view");
    const rebuilt = await rebuildReport(path.join(root, "run"));
    assert.deepEqual(rebuilt.report, report);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, "run/report.json"), "utf8")),
      report,
    );
    assert.deepEqual(rebuilt.summary, cachedSummary);
    assert.equal(rebuilt.summary.counts.initialPass, 11);
    assert.equal(rebuilt.summary.continuity, "stable");
    assert.equal(rebuilt.summary.usage.totalTokens.total, 660);
    for (const attempt of report.attempts)
      assert.equal(
        treeIdentity(await readTree(path.join(root, "run/sources", attempt.after))),
        attempt.after,
      );
    assert.equal(report.usage.totalTokens, 660);
    assert.equal(report.usage.input, 440);
    assert.equal(report.usage.output, 220);
    assert.ok(
      report.attempts.every(
        (attempt) =>
          attempt.grade.status === "pass" &&
          attempt.execution.toolCalls === 1 &&
          attempt.execution.failedToolCalls === 0 &&
          attempt.graderMs > 0 &&
          attempt.execution.agentMs > 0,
      ),
    );
    console.log(
      `VERIFIED LIVE BASELINE: ${report.passedPrefix}/11, one real Pi ${report.runtimeVersion} lifetime/session, two repeated scenes after every step`,
    );
  },
);
