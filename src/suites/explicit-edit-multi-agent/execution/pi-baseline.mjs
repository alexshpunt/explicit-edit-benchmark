import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { ExecutionFailure } from "./request-chain.mjs";

/** Sum finalized native Pi usage. Missing observations remain unknown, not zero. */
export function finalizedUsage(events) {
  const usages = events.flatMap((event) => {
    if (event.type === "message_end" && event.message?.role === "assistant")
      return [event.message.usage?.totalTokens === 0 ? undefined : event.message.usage];
    if (event.type === "compaction_end" && event.result) return [event.result.usage];
    return [];
  });
  if (!usages.length || usages.every((usage) => !usage)) return null;
  const sum = (get) =>
    usages.every((usage) => Number.isFinite(get(usage)))
      ? usages.reduce((total, usage) => total + get(usage), 0)
      : null;
  return {
    input: sum((u) => u?.input),
    output: sum((u) => u?.output),
    cacheRead: sum((u) => u?.cacheRead),
    cacheWrite: sum((u) => u?.cacheWrite),
    totalTokens: sum((u) => u?.totalTokens),
    cost: sum((u) => u?.cost?.total),
  };
}

/** Start exactly one isolated Pi process. Only declared runtime and authentication files are mounted.
 * Call close in finally. Cancellation kills the PID namespace before returning.
 */
export async function startBaseline(
  workspace,
  stateDirectory,
  config,
  { eventsFile, signal } = {},
) {
  signal?.throwIfAborted();
  const keys = new Set(["runtime", "model", "thinking", "authFile", "modelsFile", "envFile"]);
  assert.ok(
    Object.keys(config).every((key) => keys.has(key)),
    "Unknown Baseline configuration key",
  );
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
  const runtime = await realpath(config.runtime);
  const packageFile = path.join(
    runtime,
    "node_modules/@earendil-works/pi-coding-agent/package.json",
  );
  const version = JSON.parse(await readFile(packageFile, "utf8")).version;
  const state = path.resolve(stateDirectory);
  await mkdir(state, { mode: 0o700 });
  await mkdir(path.join(state, "pi"));
  await mkdir(path.join(state, "home"));
  for (const [key, name] of [
    ["authFile", "auth.json"],
    ["modelsFile", "models.json"],
  ]) {
    if (config[key]) await copyFile(config[key], path.join(state, "pi", name));
  }
  const observer = path.join(state, "observer");
  await mkdir(observer);
  await copyFile(
    fileURLToPath(new URL("pi-baseline-observer.mjs", import.meta.url)),
    path.join(observer, "baseline.mjs"),
  );
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/state/home",
    "--setenv",
    "PI_CODING_AGENT_DIR",
    "/state/pi",
    "--setenv",
    "PI_OFFLINE",
    "1",
    "--setenv",
    "PI_TELEMETRY",
    "0",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--symlink",
    "usr/bin",
    "/bin",
    "--ro-bind",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind",
    await realpath("/etc/resolv.conf"),
    "/etc/resolv.conf",
    "--ro-bind",
    "/etc/ssl/certs",
    "/etc/ssl/certs",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    runtime,
    "/runtime",
    "--bind",
    state,
    "/state",
    "--ro-bind",
    observer,
    "/state/observer",
    "--ro-bind",
    observer,
    "/observer",
    "--bind",
    path.resolve(workspace),
    "/workspace",
    "--chdir",
    "/workspace",
  ];
  if (config.envFile) {
    const env = JSON.parse(await readFile(config.envFile, "utf8"));
    for (const [key, value] of Object.entries(env)) {
      assert.ok(
        /^[A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key) &&
          typeof value === "string",
        "Only explicit provider credentials are allowed in envFile",
      );
      args.push("--setenv", key, value);
    }
  }
  args.push(
    "/usr/bin/node",
    "/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "--mode",
    "rpc",
    "--model",
    config.model,
    "--thinking",
    config.thinking,
    "--tools",
    "bash",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--offline",
    "--extension",
    "/observer/baseline.mjs",
    "--session-dir",
    "/state/pi/sessions",
  );
  signal?.throwIfAborted();
  const child = spawn("bwrap", args, {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const events = [];
  const pending = new Map();
  const observers = new Set();
  let contexts = 0;
  const waitForObservation = (matches) =>
    new Promise((resolve, reject) => {
      if (observation && matches(observation)) {
        resolve();
        return;
      }
      if (terminal) {
        reject(terminal);
        return;
      }
      const entry = {
        matches,
        resolve: () => {
          clearTimeout(timer);
          observers.delete(entry);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          observers.delete(entry);
          reject(error);
        },
      };
      const timer = setTimeout(
        () => entry.reject(new ExecutionFailure("driver_exit", "Baseline telemetry timed out")),
        15000,
      );
      observers.add(entry);
    });
  let sequence = 0;
  let terminal;
  let stopped = false;
  let closing = false;
  let active;
  let observation;
  let expected;
  let stderr = "";
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      stopped = true;
      resolve({ code, signal });
    }),
  );
  const trace = (event) => {
    if (!["message_update", "tool_execution_update"].includes(event.type)) events.push(event);
    if (eventsFile) appendFileSync(eventsFile, JSON.stringify(event) + "\n");
  };
  const fail = (error) => {
    terminal ??= error;
    for (const value of pending.values()) value.reject(terminal);
    pending.clear();
    for (const value of observers) value.reject(terminal);
    active?.reject(terminal);
  };
  const observe = (record) => {
    trace({ type: "baseline_observation", ...record });
    if (
      !record.sessionId ||
      !record.lifetime ||
      !Number.isInteger(record.agentPid) ||
      JSON.stringify(record.tools) !== '["bash"]' ||
      record.systemEmpty === false
    )
      throw new ExecutionFailure(
        "driver_exit",
        "Baseline process, tools or effective system prompt changed",
      );
    const identity = {
      sessionId: record.sessionId,
      lifetime: record.lifetime,
      agentPid: record.agentPid,
    };
    expected ??= identity;
    assert.deepEqual(identity, expected, "Actual Baseline lifetime changed");
    observation = record;
    if (record.event === "context") contexts++;
    for (const entry of observers) if (entry.matches(record)) entry.resolve();
  };
  const record = (event) => {
    trace(event);
    if (event.type === "response") {
      const request = pending.get(event.id);
      if (!request) return;
      pending.delete(event.id);
      if (event.success) request.resolve(event.data);
      else request.reject(new ExecutionFailure("driver_exit", event.error));
    } else if (event.type === "extension_error") {
      fail(new ExecutionFailure("driver_exit", event.error ?? "Baseline extension failed"));
    } else if (event.type === "agent_settled") active?.resolve();
  };
  const readLines = (stream, consume) => {
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    stream.on("data", (chunk) => {
      try {
        buffered += decoder.write(chunk);
        if (buffered.length > 32 * 1024 * 1024) throw Error("RPC record exceeds evidence limit");
        let end;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (line) consume(line);
        }
      } catch (error) {
        fail(new ExecutionFailure("driver_exit", error.message));
      }
    });
    stream.on("end", () => {
      buffered += decoder.end();
      if (buffered) {
        try {
          consume(buffered);
        } catch (error) {
          fail(error);
        }
      }
    });
  };
  readLines(child.stdout, (line) => record(JSON.parse(line)));
  readLines(child.stderr, (line) => {
    if (line.startsWith("RENDERER_BASELINE ")) observe(JSON.parse(line.slice(18)));
    else {
      stderr = (stderr + line + "\n").slice(-65536);
      trace({ type: "stderr", text: line });
    }
  });
  child.on("error", (error) => fail(new ExecutionFailure("driver_exit", error.message)));
  child.stdin.on("error", (error) => fail(new ExecutionFailure("driver_exit", error.message)));
  child.on("close", (code, signal) => {
    if (!closing)
      fail(new ExecutionFailure("driver_exit", `Pi exited (${code ?? signal}): ${stderr}`));
  });
  const command = (type, fields = {}) =>
    new Promise((resolve, reject) => {
      if (terminal || stopped) {
        reject(terminal ?? new ExecutionFailure("driver_exit", "Pi is closed"));
        return;
      }
      const id = `renderer-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ExecutionFailure("driver_exit", `RPC ${type} response timed out`));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    });
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const close = async () => {
    if (stopped) return;
    closing = true;
    child.stdin.end();
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          kill();
          resolve();
        }, 2000);
      }),
    ]);
    clearTimeout(timer);
    await exited;
    fail(new ExecutionFailure("driver_exit", "Pi closed"));
  };
  const abortStartup = () => {
    fail(signal.reason);
    kill();
  };
  signal?.addEventListener("abort", abortStartup, { once: true });
  if (signal?.aborted) abortStartup();
  try {
    const initial = await command("get_state");
    await waitForObservation(() => true);
    assert.equal(initial.sessionId, expected.sessionId);
    assert.equal(`${initial.model.provider}/${initial.model.id}`, config.model);
    assert.equal(initial.thinkingLevel, config.thinking);
    return {
      version,
      get closed() {
        return stopped;
      },
      events,
      close,
      async execute(prompt, { signal } = {}) {
        if (active) throw Error("Overlapping Baseline requests are forbidden");
        if (terminal || stopped)
          throw terminal ?? new ExecutionFailure("driver_exit", "Pi is closed");
        const begin = events.length;
        const previousContexts = contexts;
        const started = performance.now();
        let resolve;
        let reject;
        const settled = new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
        // Attach immediately: a process can fail before the acceptance response arrives.
        settled.catch(() => {});
        active = { resolve, reject };
        const abort = () => {
          fail(new DOMException("Baseline cancelled", "AbortError"));
          kill();
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const result = () => {
          const current = events.slice(begin);
          return {
            ...expected,
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
          const accepted = await command("prompt", { message: prompt });
          assert.equal(
            accepted.disposition,
            "started",
            "Request was queued or consumed instead of run",
          );
          await settled;
          const current = events.slice(begin);
          const failed = current.findLast(
            (e) => e.type === "message_end" && e.message?.role === "assistant",
          );
          if (failed && ["error", "aborted"].includes(failed.message.stopReason))
            throw new ExecutionFailure(
              "provider_failure",
              failed.message.errorMessage ?? failed.message.stopReason,
            );
          await waitForObservation(
            (record) => record.event === "context" && contexts > previousContexts,
          );
          assert.ok(
            observation.systemEmpty,
            "No observed model call under the empty system prompt",
          );
          const stateNow = await command("get_state");
          assert.equal(stateNow.sessionId, expected.sessionId, "Session changed");
          assert.equal(stateNow.isStreaming, false);
          return { ...result(), messageCount: stateNow.messageCount };
        } catch (error) {
          error.execution = result();
          if (signal?.aborted) {
            await exited;
            const aborted = new DOMException("Baseline cancelled", "AbortError");
            aborted.execution = error.execution;
            throw aborted;
          }
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          active = undefined;
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortStartup);
  }
}
