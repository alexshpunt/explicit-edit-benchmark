import assert from "node:assert/strict";
import { access, copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { cliParticipant } from "./cli-participant.mjs";
import { participantSandboxArgs, writeSandboxAccounts } from "./participant-sandbox.mjs";

export const OMP_HARNESS = "oh-my-pi-default";
const PACKAGE = "node_modules/@oh-my-pi/pi-coding-agent";
const BUN = "node_modules/@oven/bun-linux-x64/bin/bun";

/** Whether a participant config selects Oh My Pi instead of native Pi. */
export const isOmpParticipant = (config) => config?.harness === OMP_HARNESS;

/** Resolve an Oh My Pi participant without starting a process or reading credentials.
 * The runtime holds `@oh-my-pi/pi-coding-agent` and `@oven/bun-linux-x64`; `authFile`
 * is an Oh My Pi `agent.db` with the provider's credentials.
 */
export async function resolveOmpParticipantProfile(config) {
  const keys = new Set(["runtime", "model", "thinking", "harness", "authFile"]);
  assert.ok(
    Object.keys(config).every((key) => keys.has(key)),
    "Unknown Oh My Pi participant configuration key",
  );
  assert.equal(config.harness, OMP_HARNESS);
  assert.ok(
    typeof config.runtime === "string" &&
      typeof config.model === "string" &&
      config.model.includes("/"),
    "Explicit runtime and provider/model are required",
  );
  assert.ok(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinking),
    "Explicit thinking level is required",
  );
  assert.equal(typeof config.authFile, "string", "Oh My Pi needs an agent.db authFile");
  const runtime = await realpath(config.runtime);
  const manifest = JSON.parse(await readFile(path.join(runtime, PACKAGE, "package.json"), "utf8"));
  await access(path.join(runtime, BUN));
  return { runtime, version: manifest.version };
}

/** Arguments of one non-interactive Oh My Pi delivery inside the sandbox. */
export function ompCommand(config, prompt) {
  return [
    `/runtime/${BUN}`,
    `/runtime/${PACKAGE}/dist/cli.js`,
    "--model",
    config.model,
    "--thinking",
    config.thinking,
    "--no-title",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--auto-approve",
    "--mode",
    "json",
    "-p",
    prompt,
  ];
}

/** One Oh My Pi participant in the same sandbox as native Pi participants. Each
 * delivery runs one `omp --mode json -p` process. Its events already have Pi's shape
 * (`message_end`, `tool_execution_*`) and go to eventsFile unchanged.
 */
export async function startOmpParticipant(
  workspace,
  stateDirectory,
  config,
  { eventsFile, signal, sharedSandbox, onProviderFailure } = {},
) {
  signal?.throwIfAborted();
  const { runtime, version } = await resolveOmpParticipantProfile(config);
  const state = path.resolve(stateDirectory);
  await mkdir(state, { mode: 0o700 });
  await mkdir(path.join(state, "omp"), { mode: 0o700 });
  await mkdir(path.join(state, "home"));
  await copyFile(config.authFile, path.join(state, "omp", "agent.db"));
  const accounts = await writeSandboxAccounts(state);
  const sandboxArgs = await participantSandboxArgs({
    sharedSandbox,
    accounts,
    runtime,
    state,
    workspace,
    environment: {
      PATH: "/runtime/node_modules/.bin:/usr/bin:/bin",
      PI_CODING_AGENT_DIR: "/state/omp",
      PI_TELEMETRY: "0",
      SHELL: "/bin/bash",
    },
  });
  return cliParticipant({
    name: "Oh My Pi",
    version,
    config,
    sandboxArgs,
    command: (prompt) => ompCommand(config, prompt),
    sharedSandbox,
    eventsFile,
    onProviderFailure,
  });
}
