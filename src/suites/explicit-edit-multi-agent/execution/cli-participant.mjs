import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { finalizedUsage } from "./pi-baseline.mjs";
import { OversizedRpcRecord, readPiRpcLines } from "./pi-rpc-lines.mjs";
import { ExecutionFailure } from "./request-chain.mjs";
import { isTerminalProviderError } from "./provider-recovery.mjs";
import { killProcesses, participantTree, readProcessTable } from "./shared-sandbox.mjs";

const TRANSIENT = new Set(["message_update", "tool_stream_update", "tool_execution_update"]);

/** One non-interactive agent CLI process per delivery, in a participant sandbox.
 * `sandboxArgs` are the Bubblewrap arguments up to the command; `command(prompt)`
 * returns the command inside the sandbox. `normalize(record)` turns one parsed stdout
 * record into Pi-shaped events (`message_end`, `tool_execution_*`, `agent_end`), so
 * usage and telemetry are counted as for native Pi; the identity function keeps a
 * stream that already has that shape. With `nativeFile`, raw stdout lines are kept too.
 * A participant runs one delivery, as the mixed probe's per-delivery lifecycle does.
 */
export function cliParticipant({
  name,
  version,
  config,
  sandboxArgs,
  command,
  normalize = (record) => [record],
  finish = () => [],
  sharedSandbox,
  eventsFile,
  nativeFile,
  onProviderFailure,
}) {
  const events = [];
  let child;
  let exited = Promise.resolve();
  let sharedPid;
  let used = false;
  let closed = false;
  const trace = (event) => {
    if (!TRANSIENT.has(event.type)) events.push(event);
    if (eventsFile) appendFileSync(eventsFile, JSON.stringify(event) + "\n", { mode: 0o600 });
  };
  const ownProcesses = () =>
    sharedPid === undefined ? [] : participantTree(readProcessTable(), sharedPid);
  const kill = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // The agent's own processes would outlive Bubblewrap in the team's PID namespace.
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
      assert.ok(!used, `A ${name} participant runs one delivery`);
      assert.ok(!closed, `${name} participant is closed`);
      used = true;
      const args = [...sandboxArgs, ...command(prompt)];
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
          if (nativeFile) appendFileSync(nativeFile, line + "\n", { mode: 0o600 });
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            trace({ type: "stdout", text: line.slice(0, 4096) });
            return;
          }
          for (const event of normalize(record)) {
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
        outcome.error ??= new DOMException(`${name} cancelled`, "AbortError");
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
        for (const event of finish({ code, signal: exitSignal })) trace(event);
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
            `${name} exited (${code ?? exitSignal}) without finishing: ${stderr.slice(-2000)}`,
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
