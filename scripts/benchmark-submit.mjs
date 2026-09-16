#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { loadBenchmarkProfiles } from "./benchmark-config.mjs";
import {
  explicitEditBenchmarkId,
  explicitEditContract,
  explicitEditRunner,
  explicitEditVersion,
} from "../src/suites/explicit-edit/version.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const benchmark = path.join(root, "scripts", "benchmark.mjs");
const prepare = path.join(root, "scripts", "prepare-benchmark.mjs");
const repository = "alexshpunt/explicit-edit-benchmark";

const PRESET_FLAGS = [
  "--harness",
  "--profile-name",
  "--model",
  "--thinking",
  "--command",
  "--auth-file",
  "--model-file",
  "--provider-file",
  "--env-file",
  "--ide-package",
  "--harness-version",
  "--runtime",
];
const REPEATABLE_FLAGS = new Set(["--runtime"]);
const OPTIONS = new Set(["--concurrency", "--timeout-seconds", "--config", ...PRESET_FLAGS]);

export const usage = `Usage:
  npm run benchmark:submit -- --harness NAME --model MODEL --thinking LEVEL [--concurrency N] [--timeout-seconds N]
  npm run benchmark:submit -- --config FILE [--concurrency N] [--timeout-seconds N]

Ready adapters: pi-default, pi-agent-ide, codex-cli-default, opencode-default, oh-my-pi-default, github-copilot-cli-default, dsh-standard, dsh-code.

Run policy:
  --concurrency N       parallel trials, default 10
  --timeout-seconds N   per-attempt limit, default 120. A harness that starts a server or a
                        workspace of its own needs more, for example 900.

Adapter options:
  --profile-name NAME   matrix profile name
  --command FILE        agent CLI binary
  --auth-file FILE      credential file copied into the sandbox
  --model-file FILE     model catalog seed
  --provider-file FILE  provider and endpoint description
  --env-file FILE       local environment values
  --ide-package DIR     installed pi-agent-ide package
  --harness-version V   harness version (Pi Agent IDE)
  --runtime DIR         extra runtime mount, repeatable`;

/** Turn command arguments into one fixed comparable run policy and one prepared config. */
export function submitOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!OPTIONS.has(flag)) throw Error(`Unknown option: ${flag ?? "(missing)"}`);
    if (value === undefined) throw Error(`Missing value for ${flag}`);
    if (values.has(flag) && !REPEATABLE_FLAGS.has(flag)) throw Error(`Duplicate option: ${flag}`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  const single = (flag) => values.get(flag)?.[0];
  const concurrency = Number(single("--concurrency") ?? 10);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw Error("concurrency must be a positive integer");
  const timeoutSeconds = Number(single("--timeout-seconds") ?? 120);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)
    throw Error("timeout-seconds must be a positive integer");
  const policy = { concurrency, oracleRecoveries: 5, timeoutSeconds };
  const config = single("--config");
  if (config) {
    const conflicting = PRESET_FLAGS.filter((flag) => values.has(flag));
    if (conflicting.length) throw Error(`Use --config or ${conflicting.join(", ")}, not both`);
    return { ...policy, config, prepareArgs: [] };
  }
  const missing = ["--harness", "--model", "--thinking"].filter((flag) => !values.has(flag));
  if (missing.length) throw Error(`benchmark:submit requires ${missing.join(", ")}`);
  return {
    ...policy,
    config: null,
    prepareArgs: [...values]
      .filter(([flag]) => flag !== "--concurrency")
      .flatMap(([flag, list]) => list.flatMap((value) => [flag, value])),
  };
}

/** Print what each failed smoke trial reported, with anything credential-shaped removed. */
async function explainSmokeFailure(summary, smokeRunId) {
  for (const result of summary.results ?? []) {
    if (result.passed) continue;
    const stderr = await readFile(
      path.join(root, "results", smokeRunId, "trials", result.id, "agent", "stderr.log"),
      "utf8",
    ).catch(() => "");
    const reason = stderr
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    console.error(
      `${result.id} exited with ${result.exitCode ?? result.signal ?? "no status"}` +
        (reason ? `: ${redactCredentials(reason)}` : ""),
    );
  }
}

/** Harness logs stay local, and a token must never reach the terminal. */
function redactCredentials(text) {
  return text.replace(/[A-Za-z0-9_\-.]{24,}/g, "…");
}

/** Stop before the full run unless every selected profile passed its smoke task. */
export function assertSmokePassed(summary, profileIds) {
  const failed = profileIds.filter((id) => {
    const profile = summary.profiles?.[id];
    return !profile || profile.trials !== 1 || profile.passed !== 1;
  });
  if (failed.length) throw Error(`Smoke failed for: ${failed.join(", ")}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

function benchmarkCommand(args, options) {
  return run(process.execPath, ["--import", "tsx", benchmark, ...args], options);
}

function lines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Declare one harness per leaf harness id, which is what the ingestion validator matches. */
export function declaredHarnesses(profiles) {
  const harnesses = new Map();
  for (const profile of profiles) {
    if (harnesses.has(profile.harnessId)) continue;
    harnesses.set(profile.harnessId, {
      id: profile.harnessId,
      name: profile.harnessId,
      version: profile.harnessVersion,
      sourceHash: profile.configurationHash,
    });
  }
  return [...harnesses.values()];
}

/** Build the submission metadata the Hugging Face ingestion path expects for one normalized run. */
export async function submissionMetadata(normalized, runId) {
  const manifest = JSON.parse(await readFile(path.join(normalized, "manifest.json"), "utf8"));
  const profiles = lines(await readFile(path.join(normalized, "profiles.jsonl"), "utf8"));
  const trials = lines(await readFile(path.join(normalized, "trials.jsonl"), "utf8"));
  return {
    clientRunId: runId,
    purpose: "exploratory",
    definitions: {
      runner: { ...explicitEditRunner, version: explicitEditVersion },
      benchmark: {
        id: explicitEditBenchmarkId,
        version: explicitEditVersion,
        contract: explicitEditContract,
        kind: "official",
        hash: manifest.taskSetSha256,
      },
      taskSet: {
        hash: manifest.taskSetSha256,
        taskIds: [...new Set(trials.map((trial) => trial.taskId))].sort(),
      },
      harnesses: declaredHarnesses(profiles),
    },
  };
}

async function main(args) {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  const options = submitOptions(args);
  const workspace = options.config
    ? null
    : path.join(os.tmpdir(), `explicit-edit-submit-${Date.now()}`);
  const config = workspace
    ? path.join(workspace, "benchmark-config.json")
    : path.resolve(root, options.config);
  try {
    if (workspace) {
      await mkdir(workspace, { recursive: true });
      console.log("Preparing the selected agent configuration…");
      await run(process.execPath, [prepare, ...options.prepareArgs, "--output", config]);
    }
    const profiles = await loadBenchmarkProfiles(config);

    console.log("Checking Hugging Face login…");
    await run("hf", ["auth", "whoami"]);
    await benchmarkCommand(["check", "--config", config]);

    const runId = `explicit-edit-${new Date().toISOString().replaceAll(":", "-")}`;
    const smokeRunId = `${runId}-smoke`;
    console.log("Running an automatic smoke task for every selected profile…");
    await benchmarkCommand([
      "raw-run",
      "--config",
      config,
      "--smoke",
      "--task",
      "replace-all-10-plain",
      "--concurrency",
      String(options.concurrency),
      "--timeout-seconds",
      String(options.timeoutSeconds),
      "--run-id",
      smokeRunId,
    ]);
    const smokeSummary = JSON.parse(
      await readFile(path.join(root, "results", smokeRunId, "summary.json"), "utf8"),
    );
    try {
      assertSmokePassed(smokeSummary, Object.keys(profiles));
    } catch (error) {
      await explainSmokeFailure(smokeSummary, smokeRunId);
      throw error;
    }

    const runDirectory = path.join(root, "results", runId);
    console.log(`Running ${runId} with concurrency ${options.concurrency}…`);
    await benchmarkCommand(
      [
        "raw-run",
        "--config",
        config,
        "--oracle-recoveries",
        String(options.oracleRecoveries),
        "--concurrency",
        String(options.concurrency),
        "--timeout-seconds",
        String(options.timeoutSeconds),
        "--run-id",
        runId,
      ],
      { env: { ...process.env, EXPLICIT_EDIT_SMOKE_PASSED: "1" } },
    );

    const normalized = path.join(runDirectory, "normalized");
    await benchmarkCommand(["export", runDirectory]);
    await benchmarkCommand(["inspect", normalized]);
    const metadataFile = path.join(runDirectory, "submission-metadata.json");
    await writeFile(
      metadataFile,
      JSON.stringify(await submissionMetadata(normalized, runId), null, 2) + "\n",
    );
    await benchmarkCommand([
      "submit",
      normalized,
      "--repository",
      repository,
      "--metadata",
      metadataFile,
    ]);
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(`benchmark:submit: ${error.message}`);
    process.exitCode = 1;
  });
