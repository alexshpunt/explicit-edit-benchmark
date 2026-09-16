#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildPublicDataset } from "./build-public-dataset.mjs";
import { buildNormalizedReport } from "./build-normalized-report.mjs";
import { loadBenchmarkProfiles } from "./benchmark-config.mjs";
import { assertNormalizedIdentity, exportNormalizedRun } from "./normalized-run.mjs";
import { validateNormalizedRun } from "./validate-normalized-run.mjs";
import { runBenchmark } from "./benchmark-run.mjs";
import {
  acceptHuggingFaceCandidate,
  submitHuggingFaceCandidate,
} from "./huggingface-contributions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

async function runScript(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(here, script), ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Error(`${script} exited with ${signal ?? code}`));
    });
  });
}

async function init(args) {
  const output = path.resolve(value(args, "--output") ?? "benchmark.config.ts");
  await mkdir(path.dirname(output), { recursive: true });
  const template = await readFile(path.join(here, "..", "examples", "benchmark.config.ts"), "utf8");
  await writeFile(output, template.replace('from "../scripts/', 'from "./scripts/'), {
    flag: "wx",
  });
  console.log(`Created ${output}`);
}

async function check(args) {
  const config = value(args, "--config") ?? args[0];
  if (!config) throw Error("benchmark check requires --config FILE");
  const profiles = await loadBenchmarkProfiles(config);
  for (const [id, profile] of Object.entries(profiles)) assertNormalizedIdentity(profile, id);
  console.log(
    JSON.stringify(
      Object.values(profiles).map(
        ({ profileId, modelId, harnessId, model, thinking, kind, ready }) => ({
          profileId,
          modelId,
          harnessId,
          model,
          thinking,
          kind,
          ready,
        }),
      ),
      null,
      2,
    ),
  );
}

async function exportRun(args) {
  const run = args[0];
  if (!run) throw Error("benchmark export requires RUN_DIRECTORY");
  const output = path.resolve(value(args, "--output") ?? path.join(run, "normalized"));
  const manifest = await exportNormalizedRun(run, output);
  await validateNormalizedRun(output);
  console.log(`Exported ${manifest.counts.trials} trials to ${output}`);
}

async function inspect(args) {
  const bundle = args[0];
  if (!bundle) throw Error("benchmark inspect requires NORMALIZED_DIRECTORY");
  console.log(JSON.stringify(await validateNormalizedRun(bundle), null, 2));
}

async function report(args) {
  const bundle = args[0];
  if (!bundle) throw Error("benchmark report requires NORMALIZED_DIRECTORY");
  const output = path.resolve(value(args, "--output") ?? path.join(bundle, "report"));
  const result = await buildNormalizedReport(bundle, output);
  console.log(`Built ${result.report}`);
}

async function dataset(args) {
  const output = value(args, "--output");
  const bundles = args.filter(
    (argument, index) => argument !== "--output" && args[index - 1] !== "--output",
  );
  if (!output || !bundles.length)
    throw Error("benchmark dataset requires --output DIRECTORY NORMALIZED_DIRECTORY [...]");
  const result = await buildPublicDataset(output, bundles);
  console.log(`Built dataset with ${result.runs.length} runs at ${path.resolve(output)}`);
}
async function submit(args) {
  const bundle = args[0];
  const repository = value(args, "--repository");
  const metadataFile = value(args, "--metadata");
  if (!bundle || !repository || !metadataFile)
    throw Error(
      "benchmark submit requires NORMALIZED_DIRECTORY --repository OWNER/DATASET --metadata FILE",
    );
  const result = await submitHuggingFaceCandidate({
    bundleDirectory: bundle,
    metadataFile,
    repository,
  });
  console.log(`Opened ${result.pullRequestUrl} for ${result.runId}`);
}

async function accept(args) {
  const repository = value(args, "--repository");
  const candidateRevision = value(args, "--candidate");
  const dryRun = args.includes("--dry-run");
  if (!repository || !candidateRevision)
    throw Error("benchmark accept requires --repository OWNER/DATASET --candidate PR_OR_REF");
  const workspaceDirectory = path.resolve(
    value(args, "--workspace") ?? path.join(".tmp", `hf-accept-${Date.now()}`),
  );
  try {
    const result = await acceptHuggingFaceCandidate({
      repository,
      candidateRevision,
      accessToken: process.env.HF_TOKEN,
      workspaceDirectory,
      dryRun,
    });
    console.log(
      result.commitOid
        ? `Accepted ${result.runId} in ${result.commitOid}`
        : `Validated ${result.runId}; dry run, nothing published`,
    );
  } finally {
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command || ["-h", "--help", "help"].includes(command)) {
  console.log(
    `Usage: npm run benchmark -- COMMAND\n\nCommands:\n  init [--output FILE]\n  check --config FILE\n  run (--official | --local) --harness ID --model ID [OPTIONS]\n  raw-run RUNNER_OPTIONS...\n  export RUN_DIRECTORY [--output DIRECTORY]\n  inspect NORMALIZED_DIRECTORY\n  report NORMALIZED_DIRECTORY [--output DIRECTORY]\n  dataset --output DIRECTORY NORMALIZED_DIRECTORY [...]\n  submit NORMALIZED_DIRECTORY --repository OWNER/DATASET --metadata FILE\n  accept --repository OWNER/DATASET --candidate PR_OR_REF [--workspace DIRECTORY] [--dry-run]`,
  );
} else if (command === "init") await init(args);
else if (command === "check") await check(args);
else if (command === "run") await runBenchmark(args);
else if (command === "raw-run") await runScript("run-harness-batch.mjs", args);
else if (command === "export") await exportRun(args);
else if (command === "inspect") await inspect(args);
else if (command === "report") await report(args);
else if (command === "dataset") await dataset(args);
else if (command === "submit") await submit(args);
else if (command === "accept") await accept(args);
else throw Error(`Unknown benchmark command: ${command}`);
