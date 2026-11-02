import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, open, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { ExecutionFailure } from "./request-chain.mjs";
import { assertProcessBoundary, waitForProcessBoundaryExit } from "./process-boundary.mjs";
import { resolvePiParticipantProfile } from "./pi-profile.mjs";
import { isTerminalProviderError } from "./provider-recovery.mjs";
import { missingProfileTools } from "../../../../scripts/pi-codemode-profile.mjs";
export { startPiParticipant as startBaseline };

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
export async function startPiParticipant(
  workspace,
  stateDirectory,
  config,
  {
    eventsFile,
    signal,
    enforceProcessBoundary = false,
    feedbackDirectory,
    onRecovery,
    onProviderFailure,
    disableAutoRetry = false,
  } = {},
) {
  signal?.throwIfAborted();
  const profile = await resolvePiParticipantProfile(config);
  const { runtime, version } = profile;
  assert.ok(onRecovery === undefined || typeof onRecovery === "function");
  assert.ok(onProviderFailure === undefined || typeof onProviderFailure === "function");
  if (onRecovery) {
    const [major, minor] = version.split(".").map(Number);
    assert.ok(
      major > 1 || (major === 1 && minor >= 4),
      "Provider recovery requires Pi 1.4 or newer",
    );
  }
  const state = path.resolve(stateDirectory);
  await mkdir(state, { mode: 0o700 });
  await mkdir(path.join(state, "pi"));
  await mkdir(path.join(state, "home"));
  const settings = disableAutoRetry
    ? { ...profile.settings, retry: { enabled: false, provider: { maxRetries: 0 } } }
    : profile.settings;
  if (settings)
    await writeFile(path.join(state, "pi/settings.json"), JSON.stringify(settings) + "\n", {
      mode: 0o600,
    });
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
  await copyFile(
    fileURLToPath(new URL("../../../../scripts/pi-codemode-profile.mjs", import.meta.url)),
    path.join(observer, "pi-codemode-profile.mjs"),
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
    // Resolve standard /usr/bin alternative symlinks without binding all of /etc.
    "--ro-bind-try",
    "/etc/alternatives",
    "/etc/alternatives",
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
  if (feedbackDirectory) args.push("--ro-bind", path.resolve(feedbackDirectory), "/feedback");
  if (onRecovery) args.push("--setenv", "RENDERER_PI_RECOVERY", "controller");
  args.push(
    "--setenv",
    "RENDERER_PI_HARNESS",
    profile.baseline ? "baseline-agent" : profile.harness.id,
  );
  if (!profile.baseline) args.push("--setenv", "SHELL", "/bin/bash");
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
    ...profile.toolArgs,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--offline",
    ...profile.extensionArgs,
    "--extension",
    "/observer/baseline.mjs",
    "--session-dir",
    "/state/pi/sessions",
  );
  signal?.throwIfAborted();
  if (enforceProcessBoundary) args.unshift("--info-fd", "3");
  const child = spawn("bwrap", args, {
    detached: true,
    stdio: enforceProcessBoundary ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const namespace = Promise.withResolvers();
  namespace.promise.catch(() => {});
  let processIdentity, namespaceHandle, namespaceLabel;
  if (enforceProcessBoundary) {
    let information = "";
    child.stdio[3].on("data", (bytes) => {
      information += bytes;
    });
    child.stdio[3].once("end", async () => {
      try {
        const pid = JSON.parse(information)["child-pid"];
        assert.ok(Number.isSafeInteger(pid) && pid > 0, "Missing Baseline namespace PID");
        namespaceHandle = await open(`/proc/${pid}/ns/pid`, "r");
        namespaceLabel = await readlink(`/proc/self/fd/${namespaceHandle.fd}`);
        namespace.resolve(pid);
      } catch (error) {
        namespace.reject(error);
      }
    });
    child.once("error", (error) => namespace.reject(error));
  }
  const events = [];
  const pending = new Map();
  const admissions = new Map();
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
  let boundaryClosed = !enforceProcessBoundary;
  let closing = false;
  let active;
  let observation;
  let expected;
  let stderr = "";
  const exited = new Promise((resolve, reject) =>
    child.once("close", (code, signal) => {
      stopped = true;
      (async () => {
        try {
          if (enforceProcessBoundary) {
            // Startup can fail before a namespace exists; the original failure is retained.
            await namespace.promise.catch(() => {});
            if (namespaceHandle) await waitForProcessBoundaryExit(namespaceLabel);
          }
        } finally {
          await namespaceHandle?.close();
        }
      })().then(() => {
        boundaryClosed = true;
        resolve({ code, signal });
      }, reject);
    }),
  );
  exited.catch(() => {});
  const trace = (event) => {
    if (!["message_update", "tool_execution_update"].includes(event.type)) events.push(event);
    if (eventsFile) appendFileSync(eventsFile, JSON.stringify(event) + "\n");
  };
  /** @type {{
   * recoveryController: AbortController,
   * recoveryNonces: Set<string>,
   * recoveryTask: Promise<void> | undefined,
   * recoveryLease: { complete: (success: boolean) => void } | undefined,
   * recoveryNonce: string | undefined,
   * }} */
  const recovery = {
    recoveryController: new AbortController(),
    recoveryNonces: new Set(),
    recoveryTask: undefined,
    recoveryLease: undefined,
    recoveryNonce: undefined,
  };
  let nativeBegin = 0;
  const fail = (error) => {
    terminal ??= error;
    for (const value of pending.values()) value.reject(terminal);
    pending.clear();
    for (const value of admissions.values()) value.reject(terminal);
    admissions.clear();
    recovery.recoveryController.abort(terminal);
    finishRecovery(recovery, false);
    for (const value of observers) value.reject(terminal);
    active?.reject(terminal);
  };
  const finishRecovery = (current, success) => {
    if (!current.recoveryLease) return;
    const lease = current.recoveryLease;
    current.recoveryLease = undefined;
    lease.complete(success);
    trace({ type: "provider_recovery_end", nonce: current.recoveryNonce, success });
  };
  const recover = (record) => {
    assert.ok(onRecovery, "Unexpected provider-recovery boundary");
    assert.match(record.nonce, /^[a-f0-9-]{36}$/);
    const current = recovery;
    assert.ok(!current.recoveryNonces.has(record.nonce), "Duplicate provider-recovery boundary");
    current.recoveryNonces.add(record.nonce);
    trace({ type: "provider_recovery_wait", nonce: record.nonce, reason: record.reason });
    const previous = current.recoveryTask ?? Promise.resolve();
    current.recoveryTask = previous
      .then(async () => {
        finishRecovery(current, false);
        const recoverySignal = current.recoveryController.signal;
        recoverySignal.throwIfAborted();
        const lease = await onRecovery({
          ...expected,
          nonce: record.nonce,
          reason: record.reason,
          signal: recoverySignal,
        });
        assert.equal(typeof lease?.complete, "function", "Missing provider-recovery lease");
        if (recoverySignal.aborted) {
          lease.complete(false);
          recoverySignal.throwIfAborted();
        }
        current.recoveryLease = lease;
        current.recoveryNonce = record.nonce;
        trace({ type: "provider_recovery_release", nonce: record.nonce });
        const accepted = await command("prompt", {
          message: `/renderer-recovery-release ${record.nonce}`,
        });
        assert.equal(accepted.disposition, "handled", "Recovery control became a model prompt");
      })
      .catch((error) => {
        // Keep each session's mutable receipt separate from a shared stop reason.
        const failure = new Error(error?.message ?? String(error), { cause: error });
        failure.category = error?.category ?? "infrastructure";
        fail(failure);
        throw failure;
      });
    current.recoveryTask.catch(() => {});
  };
  const observe = (record) => {
    trace({ type: "baseline_observation", ...record });
    if (
      !record.sessionId ||
      !record.lifetime ||
      !Number.isInteger(record.agentPid) ||
      !Array.isArray(record.tools) ||
      (profile.baseline
        ? JSON.stringify(record.tools) !== '["bash"]' || record.systemEmpty === false
        : missingProfileTools(record.tools).length > 0 ||
          (record.event === "context" &&
            (record.systemEmpty !== false ||
              !Array.isArray(record.declaredTools) ||
              missingProfileTools(record.declaredTools).length > 0)))
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
    if (record.event === "recovery_wait") recover(record);
    if (["admission_idle", "admission_error"].includes(record.event)) {
      admissions.get(record.nonce)?.resolve(record);
      admissions.delete(record.nonce);
    }
    if (record.event === "context") contexts++;
    for (const entry of observers) if (entry.matches(record)) entry.resolve();
  };
  const record = (event) => {
    trace(event);
    if (event.type === "response") {
      const request = pending.get(event.id);
      if (!request) return;
      pending.delete(event.id);
      if (
        request.type === "prompt" &&
        active &&
        event.success &&
        event.data?.disposition === "started"
      )
        active.started = true;
      if (event.success) request.resolve(event.data);
      else request.reject(new ExecutionFailure("driver_exit", event.error));
    } else if (event.type === "extension_error") {
      fail(new ExecutionFailure("driver_exit", event.error ?? "Baseline extension failed"));
    } else if (
      event.type === "message_end" &&
      !terminal &&
      event.message?.role === "assistant" &&
      event.message.stopReason === "error" &&
      isTerminalProviderError(event.message.errorMessage)
    ) {
      const error = new ExecutionFailure("provider_failure", event.message.errorMessage);
      trace({ type: "provider_terminal_failure", ...expected, reason: event.message.errorMessage });
      onProviderFailure?.(error);
      fail(error);
      // Do not let a misleading server_error wrapper start native retries or recovery.
      kill();
    } else if (event.type === "agent_start") {
      nativeBegin = events.length - 1;
    } else if (event.type === "agent_settled") {
      const failed = events
        .slice(nativeBegin)
        .findLast((entry) => entry.type === "message_end" && entry.message?.role === "assistant");
      if (!terminal && failed && ["error", "aborted"].includes(failed.message.stopReason)) {
        const error = new ExecutionFailure(
          "provider_failure",
          failed.message.errorMessage ?? failed.message.stopReason,
        );
        onProviderFailure?.(error);
        fail(error);
        return;
      }
      if (recovery.recoveryLease) {
        recovery.recoveryTask = (recovery.recoveryTask ?? Promise.resolve())
          .then(() => finishRecovery(recovery, true))
          .catch(fail);
      }
      if (active?.started) active.resolve();
    }
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
        type,
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
  const admitPrompt = async (message) => {
    for (;;) {
      try {
        return await command("prompt", { message });
      } catch (error) {
        // This native preflight rejects before appending a user message or starting a run.
        if (
          error.category !== "driver_exit" ||
          error.message !==
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
        )
          throw error;
        const nonce = randomUUID();
        trace({ type: "participant_admission_wait", nonce });
        const idle = Promise.withResolvers();
        admissions.set(nonce, idle);
        idle.promise.catch(() => {});
        try {
          const accepted = await command("prompt", {
            message: `/renderer-admission-idle ${nonce}`,
          });
          assert.equal(accepted.disposition, "handled", "Admission control became a model prompt");
          const observed = await idle.promise;
          if (observed.event === "admission_error")
            throw new ExecutionFailure("driver_exit", observed.message);
          if (terminal) throw terminal;
          trace({ type: "participant_admission_ready", nonce });
        } finally {
          admissions.delete(nonce);
        }
      }
    }
  };
  const kill = () => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const terminate = async () => {
    closing = true;
    kill();
    await exited;
    fail(new ExecutionFailure("driver_exit", "Pi terminated"));
  };
  const close = async () => {
    if (stopped) {
      await exited;
      return;
    }
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
  const idleState = async () => {
    if (terminal || stopped || child.exitCode !== null || child.signalCode !== null)
      throw terminal ?? new ExecutionFailure("driver_exit", "Pi is closed");
    const current = await command("get_state");
    if (
      current.sessionId !== expected.sessionId ||
      observation.lifetime !== expected.lifetime ||
      observation.agentPid !== expected.agentPid ||
      `${current.model?.provider}/${current.model?.id}` !== config.model ||
      current.thinkingLevel !== config.thinking ||
      current.isStreaming !== false ||
      current.isCompacting !== false ||
      current.pendingMessageCount !== 0
    ) {
      const error = new ExecutionFailure("driver_exit", "Baseline identity or idle state changed");
      fail(error);
      throw error;
    }
    if (enforceProcessBoundary)
      processIdentity = await assertProcessBoundary(
        await namespace.promise,
        observation.agentPid,
        processIdentity,
      );
    return current;
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
        return stopped && boundaryClosed;
      },
      events,
      close,
      /** Stop the owned process boundary without running graceful shutdown hooks. */
      terminate,
      /** Inspect the existing process with RPC only; never prompt or replace it. */
      async assertIdle() {
        if (active)
          throw new ExecutionFailure("driver_exit", "Baseline still has an active delivery");
        const current = await idleState();
        return {
          ...expected,
          version,
          model: config.model,
          thinking: config.thinking,
          messageCount: current.messageCount,
          ...(processIdentity ? { process: processIdentity } : {}),
        };
      },
      async execute(prompt, { signal, completion = "idle" } = {}) {
        if (active) throw Error("Overlapping Baseline requests are forbidden");
        if (terminal || stopped)
          throw terminal ?? new ExecutionFailure("driver_exit", "Pi is closed");
        assert.ok(["idle", "turn"].includes(completion), "Unsupported Pi completion mode");
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
        const current = {
          resolve,
          reject,
          completion,
          started: false,
        };
        active = current;
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
            lifecycle: current.filter((e) => /compaction|retry|recovery|admission/.test(e.type)),
          };
        };
        try {
          const accepted = await admitPrompt(prompt);
          assert.equal(
            accepted.disposition,
            "started",
            "Request was queued or consumed instead of run",
          );
          await settled;
          await recovery.recoveryTask;
          if (terminal) throw terminal;
          const turnEvents = events.slice(begin);
          const failed = turnEvents.findLast(
            (e) => e.type === "message_end" && e.message?.role === "assistant",
          );
          if (failed && ["error", "aborted"].includes(failed.message.stopReason)) {
            const error = new ExecutionFailure(
              "provider_failure",
              failed.message.errorMessage ?? failed.message.stopReason,
            );
            throw error;
          }
          await waitForObservation(
            (record) => record.event === "context" && contexts > previousContexts,
          );
          assert.ok(
            profile.baseline ? observation.systemEmpty : observation.systemEmpty === false,
            "No observed model call under the selected system profile",
          );
          // Native diagnostics may start another run after this settlement. A later
          // delivery waits for admission only if its preflight was actually rejected.
          if (completion === "turn") return result();
          const stateNow = await idleState();
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
