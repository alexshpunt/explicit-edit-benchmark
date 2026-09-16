import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const TEMPLATE = "alexshpunt/explicit-edit-benchmark-run-template";
const WORKFLOW = "official-run.yml";

function command(binary, args, { input, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    if (capture) child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(Error(`${binary} ${args[0] ?? ""} exited with ${signal ?? code}`));
    });
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Parse the public one-command run interface. */
export function parseRunOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      official: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      harness: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string", default: "low" },
      task: { type: "string", default: "replace-all-10-plain" },
      concurrency: { type: "string", default: "10" },
      "timeout-seconds": { type: "string" },
      "profile-name": { type: "string" },
      command: { type: "string" },
      "auth-file": { type: "string" },
      "model-file": { type: "string" },
      "provider-file": { type: "string" },
      "env-file": { type: "string" },
      "ide-package": { type: "string" },
      runtime: { type: "string", multiple: true },
      "caller-repository": { type: "string" },
      "agent-version": { type: "string", default: "0.85.1" },
      "harness-version": { type: "string", default: "" },
      "pi-auth-file": { type: "string" },
      "no-wait": { type: "boolean", default: false },
    },
  });
  if (values.official === values.local)
    throw Error("Choose exactly one run mode: --official or --local");
  if (!values.harness || !values.model) throw Error("Run requires --harness and --model");
  if (values.official && !["pi-default", "pi-agent-ide"].includes(values.harness))
    throw Error(`Official adapter is not registered: ${values.harness}`);
  const localOnly = [
    "timeout-seconds",
    "profile-name",
    "command",
    "auth-file",
    "model-file",
    "provider-file",
    "env-file",
    "ide-package",
    "runtime",
  ];
  if (values.official) {
    const unsupported = localOnly.find((option) => values[option] !== undefined);
    if (unsupported) throw Error(`Official mode does not accept --${unsupported}`);
  }
  return values;
}

/** Run and submit an ordinary unverified observation on this machine. */
export async function runLocal(values, execute = command) {
  const args = [
    "run",
    "benchmark:submit",
    "--",
    "--harness",
    values.harness,
    "--model",
    values.model,
    "--thinking",
    values.thinking,
    "--concurrency",
    values.concurrency,
  ];
  for (const option of [
    "timeout-seconds",
    "profile-name",
    "command",
    "auth-file",
    "model-file",
    "provider-file",
    "env-file",
    "ide-package",
  ]) {
    if (values[option] !== undefined) args.push(`--${option}`, values[option]);
  }
  for (const runtime of values.runtime ?? []) args.push("--runtime", runtime);
  await execute("npm", args);
}

async function configureSecret(repository, name, secret, execute) {
  await execute("gh", ["secret", "set", name, "--repo", repository], { input: secret });
}

/** Bootstrap a caller repository, dispatch an official run, and optionally wait for acceptance. */
export async function runOfficial(values, execute = command) {
  await execute("gh", ["auth", "status"]);
  const owner = await execute("gh", ["api", "user", "--jq", ".login"], { capture: true });
  const repository = values["caller-repository"] ?? `${owner}/explicit-edit-benchmark-run`;
  try {
    await execute("gh", ["repo", "view", repository, "--json", "name"], { capture: true });
  } catch {
    await execute("gh", ["repo", "create", repository, "--public", "--template", TEMPLATE]);
  }

  const authFile = path.resolve(
    values["pi-auth-file"] ?? path.join(os.homedir(), ".pi", "agent", "auth.json"),
  );
  if (!(await exists(authFile))) throw Error(`Pi credentials not found: ${authFile}`);
  const [piAuth, hfToken] = await Promise.all([
    readFile(authFile, "utf8"),
    execute("hf", ["auth", "token"], { capture: true }),
  ]);
  await configureSecret(repository, "PI_AUTH_JSON", piAuth, execute);
  await configureSecret(repository, "HF_TOKEN", hfToken, execute);

  const before = await execute(
    "gh",
    [
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      WORKFLOW,
      "--limit",
      "1",
      "--json",
      "databaseId",
      "--jq",
      ".[0].databaseId // 0",
    ],
    { capture: true },
  );
  await execute("gh", [
    "workflow",
    "run",
    WORKFLOW,
    "--repo",
    repository,
    "-f",
    `model=${values.model}`,
    "-f",
    `thinking=${values.thinking}`,
    "-f",
    `task=${values.task}`,
    "-f",
    `adapter=${values.harness}`,
    "-f",
    `agent_version=${values["agent-version"]}`,
    "-f",
    `harness_version=${values["harness-version"]}`,
  ]);

  let runId;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    runId = await execute(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        WORKFLOW,
        "--event",
        "workflow_dispatch",
        "--limit",
        "1",
        "--json",
        "databaseId",
        "--jq",
        ".[0].databaseId",
      ],
      { capture: true },
    );
    if (runId && runId !== before) break;
  }
  if (!runId || runId === before)
    throw Error("GitHub accepted the dispatch but no new run appeared");
  console.log(`Official run: https://github.com/${repository}/actions/runs/${runId}`);
  if (!values["no-wait"])
    await execute("gh", ["run", "watch", runId, "--repo", repository, "--exit-status"]);
  return { repository, runId };
}

export async function runBenchmark(args, execute = command) {
  const values = parseRunOptions(args);
  return values.official ? runOfficial(values, execute) : runLocal(values, execute);
}
