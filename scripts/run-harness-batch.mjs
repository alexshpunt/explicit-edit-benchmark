#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { explicitEditTasks } from "../src/suites/explicit-edit/fixtures.ts";
import { explicitEditContract } from "../src/suites/explicit-edit/version.ts";
import { writeFiles, compareExplicitFiles } from "../src/suites/explicit-edit/files.ts";
import {
  closeHarness,
  runHarness,
  inspectHarnessOutput,
  recoveryAdapter,
} from "./harness-runtime.mjs";
import { recoverWithOracle } from "./oracle-recovery.mjs";
import { cp } from "node:fs/promises";
import { retryBudget, nextRetry, retrySummary } from "./retry-failures.mjs";
import { selectedTasks } from "./focused-selection.mjs";
import { loadBenchmarkProfiles } from "./benchmark-config.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: npm run bench:run -- --config FILE [--harnesses LIST] [--task ID | --task-manifest FILE] [--smoke] [--oracle-recoveries N | --retry-failures N] [--concurrency N] [--timeout-seconds N] [--results DIR] [--run-id ID]. Model and thinking are explicit in the adapter config.",
  );
  process.exit(0);
}
const option = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i < 0 ? fallback : args[i + 1];
};
const retryFailures = retryBudget(option("retry-failures", "0"));
const oracleRecoveries = retryBudget(option("oracle-recoveries", "0"));
if (oracleRecoveries && retryFailures)
  throw Error("Choose fresh retries or oracle recovery, not both");
const configFile = option("config");
if (!configFile) throw Error("--config is required");
const configSource = await readFile(configFile, "utf8");
const config = { harnesses: await loadBenchmarkProfiles(configFile) };
const names = option("harnesses", Object.keys(config.harnesses).join(",")).split(",");
const concurrency = Number(option("concurrency", "4"));
const timeoutMs = Number(option("timeout-seconds", "120")) * 1000;
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  !(timeoutMs > 0 && Number.isFinite(timeoutMs))
)
  throw Error("Invalid concurrency or timeout");
if (
  new Set(names).size !== names.length ||
  names.some((n) => !/^[a-z0-9-]+$/.test(n) || !config.harnesses[n])
)
  throw Error("Invalid harness selection");
const smoke = args.includes("--smoke");
for (const name of names) {
  const a = config.harnesses[name];
  if (!a.model || !a.thinking)
    throw Error(`${name}: explicit model and thinking settings are required`);
  if (!smoke && !a.ready && process.env.EXPLICIT_EDIT_SMOKE_PASSED !== "1")
    throw Error(`${name}: complete model/auth smoke before full run`);
  const version = execFileSync(a.command, a.versionArgs ?? ["--version"], {
    encoding: "utf8",
  }).trim();
  if (version !== a.version) throw Error(`${name}: binary version changed: ${version}`);
}
if (option("task") && option("task-manifest"))
  throw Error("Use --task or --task-manifest, not both");
const selectionText = option("task-manifest")
  ? await readFile(option("task-manifest"), "utf8")
  : null;
const tasks = selectionText
  ? selectedTasks(explicitEditTasks(), JSON.parse(selectionText))
  : explicitEditTasks().filter((t) => !option("task") || t.id === option("task"));
if (!tasks.length) throw Error("No tasks selected");
if (smoke && !option("task")) throw Error("Smoke requires one --task");
const root = path.resolve(
  option("results", "results"),
  option("run-id", new Date().toISOString().replaceAll(":", "-")),
);
await mkdir(path.dirname(root), { recursive: true });
await mkdir(root);
if (selectionText) await writeFile(path.join(root, "focused-selection.json"), selectionText);
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");
/** Identity fields that must survive from the loaded profile into the recorded run. */
const IDENTITY_FIELDS = [
  "harnessId",
  "harnessFamily",
  "harnessVersion",
  "agentFamily",
  "agentVersion",
  "modelFamily",
  "modelVersion",
  "adapterVersion",
  "configurationId",
  "configuration",
  "configurationLabels",
];
/** Stop when recording an adapter would change its published identity. */
function assertRecordedIdentity(name, source, recorded) {
  for (const field of IDENTITY_FIELDS)
    if (JSON.stringify(source[field] ?? null) !== JSON.stringify(recorded[field] ?? null))
      throw Error(
        `${name}: recorded ${field} ${JSON.stringify(recorded[field] ?? null)} differs from the loaded profile ${JSON.stringify(source[field] ?? null)}`,
      );
}

const safeAdapters = Object.fromEntries(
  names.map((n) => {
    const a = config.harnesses[n];
    return [
      n,
      {
        profileId: a.profileId ?? n,
        modelId: a.modelId ?? null,
        harnessId: a.harnessId,
        version: a.version,
        // The agent CLI version and the harness version are separate facts and may differ.
        harnessVersion: a.harnessVersion ?? null,
        model: a.model,
        thinking: a.thinking,
        kind: a.kind,
        transport: a.transport ?? null,
        sourceCommit: a.sourceCommit ?? null,
        ready: a.ready,
        evidence: a.evidence ?? null,
        agentFamily: a.agentFamily,
        agentVersion: a.agentVersion,
        modelFamily: a.modelFamily,
        modelVersion: a.modelVersion,
        provider: a.provider ?? null,
        harnessFamily: a.harnessFamily,
        adapterVersion: a.adapterVersion,
        configurationId: a.configurationId,
        configuration: a.configuration,
        configurationLabels: a.configurationLabels,
      },
    ];
  }),
);
for (const name of names) assertRecordedIdentity(name, config.harnesses[name], safeAdapters[name]);

const schedule = tasks.flatMap((t, i) =>
  (i % 2 ? [...names].reverse() : names).map((n) => ({
    taskId: t.id,
    profile: n,
    attempt: 1,
    id: `${t.id}__r01__${n}`,
    fixtureSha256: t.fixtureSha256,
    category: t.category,
  })),
);
/** Correctness lives in one module. Its hash is what makes "the same rules" checkable. */
const verifierSha256 = createHash("sha256")
  .update(await readFile(new URL("../src/suites/explicit-edit/files.ts", import.meta.url)))
  .digest("hex");
await json(path.join(root, "manifest.json"), {
  contract: explicitEditContract,
  focusedSelectionSha256: selectionText
    ? createHash("sha256").update(selectionText).digest("hex")
    : null,
  attempts: 1,
  retryFailures,
  oracleRecoveries,
  concurrency,
  timeoutMs,
  harnesses: safeAdapters,
  configSha256: createHash("sha256").update(configSource).digest("hex"),
  verifierSha256,
  tasks: tasks.map((t) => ({ id: t.id, fixtureSha256: t.fixtureSha256 })),
  timingNote: "Concurrent run; historical Pi references used different versions and load.",
});
await json(path.join(root, "schedule.json"), schedule);
const results = [];
const running = new Map();
let next = 0;
let checkpoint = Promise.resolve();
/** Live view of the queue, including what is executing right now. */
const progressSnapshot = () => ({
  completed: results.length,
  total: schedule.length,
  running: [...running.values()].map((item) => ({
    ...item,
    seconds: Math.round((performance.now() - item.startedAt) / 1000),
  })),
  results: [...results],
});
const writeProgress = () => {
  const snapshot = progressSnapshot();
  checkpoint = checkpoint.then(() => json(path.join(root, "progress.json"), snapshot));
  return checkpoint;
};
// Trial state lives in the system temp folder, so a run leaves the checkout untouched. The
// directory belongs to this run alone: two runs at once must not delete each other's state.
const stateRoot = await mkdtemp(path.join(os.tmpdir(), "explicit-edit-harness-state-"));
async function lane() {
  while (next < schedule.length) {
    const item = schedule[next++],
      task = tasks.find((t) => t.id === item.taskId),
      dir = path.join(root, "trials", item.id);
    const started = performance.now();
    await mkdir(dir, { recursive: true });
    const state = await mkdtemp(path.join(stateRoot, "trial-"));
    let result = { ...item, passed: false, reward: 0 };
    running.set(item.id, {
      id: item.id,
      taskId: item.taskId,
      profile: item.profile,
      attempt: item.attempt,
      startedAt: performance.now(),
    });
    console.log(`START ${item.id} (${running.size} running)`);
    await writeProgress();
    try {
      const workspace = path.join(dir, "workspace");
      await writeFiles(workspace, task.input);
      await writeFile(path.join(dir, "prompt.txt"), task.prompt);
      if (oracleRecoveries) {
        const recovery = await recoverWithOracle({
          recoveries: oracleRecoveries,
          run: async ({ attempt, feedback }) => {
            const round = path.join(dir, "rounds", String(attempt));
            await mkdir(round, { recursive: true });
            const prompt = feedback ?? task.prompt;
            await writeFile(path.join(round, "prompt.txt"), prompt);
            const execution = await runHarness(
              recoveryAdapter(config.harnesses[item.profile], attempt > 0),
              {
                workspace,
                state,
                artifacts: path.join(round, "agent"),
                prompt,
                timeoutMs,
              },
            );
            const metrics = await inspectHarnessOutput(
              config.harnesses[item.profile],
              path.join(round, "agent/stdout.jsonl"),
            );
            await json(path.join(round, "tool-calls.json"), metrics.calls);
            return {
              ...execution,
              toolCalls: metrics.toolCalls,
              modelRounds: metrics.modelRounds,
              errors: metrics.errors,
              costUsd: metrics.costUsd ?? null,
              inputTokens: metrics.inputTokens ?? null,
              outputTokens: metrics.outputTokens ?? null,
              cacheReadTokens: metrics.cacheReadTokens ?? null,
              cacheWriteTokens: metrics.cacheWriteTokens ?? null,
              totalTokens: metrics.totalTokens ?? null,
              failedToolCalls: metrics.failedToolCalls ?? null,
              invalidToolCalls: metrics.invalidToolCalls ?? null,
            };
          },
          verify: () => compareExplicitFiles(workspace, task.expected),
          record: async (roundResult) => {
            const round = path.join(dir, "rounds", String(roundResult.attempt));
            await cp(workspace, path.join(round, "workspace"), {
              recursive: true,
              verbatimSymlinks: true,
            });
            await json(path.join(round, "result.json"), roundResult);
          },
        });
        result = {
          ...result,
          passed: recovery.eventuallyPassed,
          reward: recovery.eventuallyPassed ? 1 : 0,
          recovery,
        };
      } else {
        const processResult = await runHarness(config.harnesses[item.profile], {
          workspace,
          state,
          artifacts: path.join(dir, "agent"),
          prompt: task.prompt,
          timeoutMs,
        });
        const metrics = await inspectHarnessOutput(
          config.harnesses[item.profile],
          path.join(dir, "agent/stdout.jsonl"),
        );
        await json(path.join(dir, "tool-calls.json"), metrics.calls);
        const comparison = await compareExplicitFiles(workspace, task.expected);
        await json(path.join(dir, "comparison.json"), comparison);
        const passed =
          processResult.exitCode === 0 &&
          !processResult.timedOut &&
          metrics.errors.length === 0 &&
          comparison.exactMatch;
        result = {
          ...result,
          ...processResult,
          passed,
          reward: passed ? 1 : 0,
          toolCalls: metrics.toolCalls,
          modelRounds: metrics.modelRounds,
          eventCount: metrics.eventCount,
          costUsd: metrics.costUsd ?? null,
          inputTokens: metrics.inputTokens ?? null,
          outputTokens: metrics.outputTokens ?? null,
          cacheReadTokens: metrics.cacheReadTokens ?? null,
          cacheWriteTokens: metrics.cacheWriteTokens ?? null,
          totalTokens: metrics.totalTokens ?? null,
          failedToolCalls: metrics.failedToolCalls ?? null,
          invalidToolCalls: metrics.invalidToolCalls ?? null,
          errors: metrics.errors,
        };
      }
    } catch (error) {
      result.error = String(error.stack ?? error);
    } finally {
      await closeHarness(state);
      await rm(state, { recursive: true, force: true });
    }
    result.seconds = (performance.now() - started) / 1000;
    await json(path.join(dir, "result.json"), result);
    results.push(result);
    running.delete(item.id);
    const retry = nextRetry(item, result, retryFailures);
    if (retry) schedule.push(retry);
    const scheduleSnapshot = [...schedule];
    checkpoint = checkpoint.then(() => json(path.join(root, "schedule.json"), scheduleSnapshot));
    await writeProgress();
    console.log(
      `DONE ${results.length}/${schedule.length} ${item.id} ${result.passed ? "PASS" : "FAIL"} ${result.seconds.toFixed(2)}s (${running.size} running)`,
    );
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, schedule.length) }, lane));
await rm(stateRoot, { recursive: true, force: true });
await json(path.join(root, "schedule.json"), schedule);
await json(path.join(root, "summary.json"), {
  ...(retryFailures > 0 ? { retries: retrySummary(results, retryFailures) } : {}),
  completed: results.length,
  total: schedule.length,
  profiles: Object.fromEntries(
    names.map((n) => {
      const r = results.filter((x) => x.profile === n);
      return [
        n,
        {
          trials: r.length,
          firstAttemptPassed: r.filter((x) =>
            x.recovery ? x.recovery.firstAttemptPassed : x.passed,
          ).length,
          recoveriesUsed: r.reduce((sum, x) => sum + (x.recovery?.recoveriesUsed ?? 0), 0),
          recoveryExhausted: r.filter((x) => x.recovery?.exhausted).length,
          passed: r.filter((x) => x.passed).length,
          timeouts: r.reduce(
            (sum, x) =>
              sum +
              (x.recovery
                ? x.recovery.attempts.filter((a) => a.execution.timedOut).length
                : Number(Boolean(x.timedOut))),
            0,
          ),
          meanSeconds: r.reduce((s, x) => s + x.seconds, 0) / r.length,
        },
      ];
    }),
  ),
  results,
});
console.log(`Run complete: ${root}`);
