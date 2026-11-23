import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { access, copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { finalizedUsage } from "./pi-baseline.mjs";
import { OversizedRpcRecord, readPiRpcLines } from "./pi-rpc-lines.mjs";
import { ExecutionFailure } from "./request-chain.mjs";
import { isTerminalProviderError } from "./provider-recovery.mjs";
import { participantSandboxArgs, writeSandboxAccounts } from "./participant-sandbox.mjs";
import { killProcesses, participantTree, readProcessTable } from "./shared-sandbox.mjs";

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
 * execute runs one `omp --mode json -p` process, so a participant serves the mixed
 * probe's per-delivery lifecycle: one prompt, then close. Events keep Oh My Pi's native
 * shape, which matches Pi's (`message_end`, `tool_execution_*`), and go to eventsFile.
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
  const base = await participantSandboxArgs({
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

  const events = [];
  let child;
  let exited = Promise.resolve();
  let sharedPid;
  let used = false;
  let closed = false;
  const trace = (event) => {
    if (!["message_update", "tool_stream_update", "tool_execution_update"].includes(event.type))
      events.push(event);
    if (eventsFile) appendFileSync(eventsFile, JSON.stringify(event) + "\n", { mode: 0o600 });
  };
  const ownProcesses = () =>
    sharedPid === undefined ? [] : participantTree(readProcessTable(), sharedPid);
  const kill = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Oh My Pi's own processes would outlive Bubblewrap in the team's PID namespace.
    if (sharedSandbox) killProcesses(ownProcesses());
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = async () => {
    const leftovers = sharedSandbox ? ownProcesses() : [];
    kill();
    await exited;
    if (sharedSandbox) killProcesses(leftovers);
    closed = true;
  };

  return {
    version,
    events,
    get closed() {
      return closed;
    },
    close: stop,
    terminate: stop,
    async execute(prompt, { signal: deliverySignal } = {}) {
      assert.ok(!used, "An Oh My Pi participant runs one delivery");
      assert.ok(!closed, "Oh My Pi participant is closed");
      used = true;
      const args = [...base, ...ompCommand(config, prompt)];
      if (sharedSandbox) args.unshift("--info-fd", "3");
      const [executable, executableArgs] = sharedSandbox
        ? sharedSandbox.joinCommand(args)
        : ["bwrap", args];
      const begin = events.length;
      const started = performance.now();
      let stderr = "";
      /** @type {{ error?: Error }} */
      const outcome = {};
      child = spawn(executable, executableArgs, {
        detached: true,
        stdio: sharedSandbox ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
      });
      if (sharedSandbox) {
        let information = "";
        child.stdio[3].on("data", (bytes) => (information += bytes));
        child.stdio[3].once("end", () => {
          const pid = JSON.parse(information || "{}")["child-pid"];
          if (Number.isSafeInteger(pid) && pid > 0) sharedPid = pid;
        });
      }
      exited = new Promise((resolve) =>
        child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal })),
      );
      const done = exited;
      child.once(
        "error",
        (error) => (outcome.error ??= new ExecutionFailure("driver_exit", error.message)),
      );
      readPiRpcLines(
        child.stdout,
        (line) => {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            trace({ type: "stdout", text: line.slice(0, 4096) });
            return;
          }
          trace(event);
          const message = event.type === "message_end" ? event.message : undefined;
          if (
            !outcome.error &&
            message?.role === "assistant" &&
            message.stopReason === "error" &&
            isTerminalProviderError(message.errorMessage)
          ) {
            outcome.error = new ExecutionFailure("provider_failure", message.errorMessage);
            trace({ type: "provider_terminal_failure", reason: message.errorMessage });
            onProviderFailure?.(outcome.error);
            kill();
          }
        },
        (diagnostic) => {
          trace({ type: "rpc_record_oversized", stream: "stdout", ...diagnostic });
          outcome.error ??= new OversizedRpcRecord("stdout", diagnostic.bytes);
          kill();
        },
      );
      readPiRpcLines(
        child.stderr,
        (line) => {
          stderr = (stderr + line + "\n").slice(-65536);
          trace({ type: "stderr", text: line });
        },
        () => {},
      );
      const abort = () => {
        outcome.error ??= new DOMException("Oh My Pi cancelled", "AbortError");
        kill();
      };
      deliverySignal?.addEventListener("abort", abort, { once: true });
      if (deliverySignal?.aborted) abort();
      const result = () => {
        const current = events.slice(begin);
        const session = current.find((event) => event.type === "session");
        return {
          sessionId: session?.id ?? null,
          agentPid: sharedPid ?? null,
          version,
          model: config.model,
          thinking: config.thinking,
          agentMs: performance.now() - started,
          usage: finalizedUsage(current),
          toolCalls: current.filter((e) => e.type === "tool_execution_start").length,
          failedToolCalls: current.filter((e) => e.type === "tool_execution_end" && e.isError)
            .length,
          lifecycle: current.filter((e) => /compaction|retry/.test(e.type)),
        };
      };
      try {
        const { code, signal: exitSignal } = await done;
        if (outcome.error) throw outcome.error;
        const current = events.slice(begin);
        const last = current.findLast(
          (e) => e.type === "message_end" && e.message?.role === "assistant",
        );
        if (last && ["error", "aborted"].includes(last.message.stopReason))
          throw new ExecutionFailure(
            "provider_failure",
            last.message.errorMessage ?? last.message.stopReason,
          );
        if (code !== 0 || !current.some((e) => e.type === "agent_end"))
          throw new ExecutionFailure(
            "driver_exit",
            `Oh My Pi exited (${code ?? exitSignal}) without finishing: ${stderr.slice(-2000)}`,
          );
        return result();
      } catch (error) {
        error.execution = result();
        throw error;
      } finally {
        deliverySignal?.removeEventListener("abort", abort);
        if (sharedSandbox) killProcesses(ownProcesses());
        closed = true;
      }
    },
  };
}
