import assert from "node:assert/strict";
import { access, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliParticipant } from "./cli-participant.mjs";
import { participantSandboxArgs, writeSandboxAccounts } from "./participant-sandbox.mjs";

export const OMP_HARNESS = "oh-my-pi-default";
/** Oh My Pi without a shell: the bash tool, Python eval and the debugger, which
 * launches any program, are off, and a guard extension refuses JavaScript eval
 * cells that reach a shell. */
export const OMP_NO_BASH_HARNESS = "oh-my-pi-no-bash";
const OMP_HARNESSES = new Set([OMP_HARNESS, OMP_NO_BASH_HARNESS]);
const PACKAGE = "node_modules/@oh-my-pi/pi-coding-agent";
const BUN = "node_modules/@oven/bun-linux-x64/bin/bun";
/** Settings overlay of the no-Bash harness. */
export const OMP_NO_BASH_SETTINGS =
  "bash:\n  enabled: false\neval:\n  py: false\ndebug:\n  enabled: false\n";

/** Whether a participant config selects Oh My Pi instead of native Pi. */
export const isOmpParticipant = (config) => OMP_HARNESSES.has(config?.harness);

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
  assert.ok(OMP_HARNESSES.has(config.harness), "Unsupported Oh My Pi harness");
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

/** Arguments of one non-interactive Oh My Pi delivery inside the sandbox. The
 * no-Bash harness adds its settings overlay and the shell guard extension, which
 * `--no-extensions` keeps because it is named explicitly. */
export function ompCommand(config, prompt) {
  const noBash = config.harness === OMP_NO_BASH_HARNESS;
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
    ...(noBash
      ? ["--config", "/state/omp/no-bash.yml", "--extension", "/observer/omp-no-shell-guard.mjs"]
      : []),
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
  const stateBinds = [];
  if (config.harness === OMP_NO_BASH_HARNESS) {
    await writeFile(path.join(state, "omp", "no-bash.yml"), OMP_NO_BASH_SETTINGS, { mode: 0o600 });
    const observer = path.join(state, "observer");
    await mkdir(observer);
    await copyFile(
      fileURLToPath(new URL("omp-no-shell-guard.mjs", import.meta.url)),
      path.join(observer, "omp-no-shell-guard.mjs"),
    );
    stateBinds.push("--ro-bind", observer, "/state/observer", "--ro-bind", observer, "/observer");
  }
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
    stateBinds,
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
