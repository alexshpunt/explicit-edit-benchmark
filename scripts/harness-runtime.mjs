import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, realpathSync } from "node:fs";
import { cp, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import readline from "node:readline";

const persistentHarnesses = new Map();

function addReadOnlyMount(args, mount, createdDirectories) {
  const absolute = path.resolve(mount);
  if (!absolute.startsWith("/usr/") && !absolute.startsWith("/etc/")) {
    const missingParents = [];
    for (let parent = path.dirname(absolute); parent !== "/"; parent = path.dirname(parent))
      missingParents.push(parent);
    for (const parent of missingParents.reverse()) {
      if (createdDirectories.has(parent)) continue;
      args.push("--dir", parent);
      createdDirectories.add(parent);
    }
  }
  args.push("--ro-bind", absolute, absolute);
}

/** Run a CLI in an allowlisted filesystem and retain output even after a timeout.
 * The trusted adapter config owns command, runtime mounts and credential seeds.
 * Fixtures and verifier files are never mounted into the child except for workspace inputs.
 */
/** Keep the isolated harness state and resume its only session for oracle recovery. */
export function recoveryAdapter(adapter, continuation) {
  if (continuation && typeof adapter.continueSession === "function") {
    const resumed = adapter.continueSession(adapter);
    return { ...resumed, seedFiles: {}, stateFiles: {} };
  }
  let args = adapter.args.filter((value) => !["--ephemeral", "--no-session"].includes(value));
  if (continuation) {
    if (adapter.kind === "codex-cli-default") args = ["exec", "resume", "--last", ...args.slice(1)];
    else if (
      [
        "opencode-default",
        "oh-my-pi-default",
        "github-copilot-cli-default",
        "pi-default",
        "baseline-agent",
        "pi-agent-ide",
        "pi-aft",
      ].includes(adapter.kind)
    )
      args = ["--continue", ...args];
    else if (!["dsh-standard", "dsh-code"].includes(adapter.kind))
      throw Error(`No session continuation contract for ${adapter.kind}`);
    if (adapter.kind === "opencode-default") args = ["run", "--continue", ...adapter.args.slice(1)];
  }
  return { ...adapter, args, ...(continuation ? { seedFiles: {}, stateFiles: {} } : {}) };
}
async function copyStateArtifacts(adapter, state, artifacts) {
  for (const [relativeSource, relativeDestination] of Object.entries(
    adapter.stateArtifacts ?? {},
  )) {
    const source = path.resolve(state, relativeSource);
    const destination = path.resolve(artifacts, relativeDestination);
    if (!source.startsWith(path.resolve(state) + path.sep))
      throw Error("Invalid state artifact source");
    if (!destination.startsWith(path.resolve(artifacts) + path.sep))
      throw Error("Invalid state artifact destination");
    try {
      await cp(source, destination, { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function runPersistentHarness(adapter, { state, artifacts, prompt, timeoutMs, args, env }) {
  const key = path.resolve(state);
  let process = persistentHarnesses.get(key);
  if (!process) {
    const child = spawn("/usr/bin/bwrap", args, {
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    process = {
      child,
      current: null,
      closing: false,
      closed: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
    };
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const current = process.current;
      if (!current) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {}
      if (event?.type === "eval/turn-complete") {
        current.reason = event.reason;
        current.resolve();
      } else {
        current.output.write(line + "\n");
      }
    });
    child.stderr.on("data", (chunk) => process.current?.errors.write(chunk));
    process.closed.then(({ code, signal }) => {
      if (!process.closing) {
        process.current?.reject(
          new Error(`Persistent harness exited before turn completion (${code ?? signal})`),
        );
      }
    });
    child.stdin.on("error", () => {});
    persistentHarnesses.set(key, process);
  }
  if (process.current) throw Error("Persistent harness already has an active turn");
  const output = createWriteStream(path.join(artifacts, "stdout.jsonl"));
  const errors = createWriteStream(path.join(artifacts, "stderr.log"));
  const started = performance.now();
  let timedOut = false;
  const turn = new Promise((resolve, reject) => {
    process.current = { resolve, reject, output, errors, reason: undefined };
  });
  process.child.stdin.write(`${JSON.stringify({ prompt })}\n`);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.child.pid) globalThis.process.kill(-process.child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([turn, timeout]);
  } finally {
    clearTimeout(timer);
    output.end();
    errors.end();
    await Promise.all([finished(output), finished(errors)]);
  }
  const reason = process.current?.reason;
  process.current = null;
  await copyStateArtifacts(adapter, state, artifacts);
  return {
    exitCode: reason?.kind === "completed" ? 0 : 1,
    signal: null,
    timedOut,
    processSeconds: (performance.now() - started) / 1000,
  };
}

/** Close one persistent adapter after its trial and flush its durable state. */
export async function closeHarness(state) {
  const key = path.resolve(state);
  const process = persistentHarnesses.get(key);
  if (!process) return;
  persistentHarnesses.delete(key);
  process.closing = true;
  process.child.stdin.end();
  const timer = setTimeout(() => {
    if (process.child.pid) globalThis.process.kill(-process.child.pid, "SIGKILL");
  }, 10000);
  try {
    await process.closed;
  } finally {
    clearTimeout(timer);
  }
}

export async function runHarness(adapter, { workspace, state, artifacts, prompt, timeoutMs }) {
  await mkdir(state, { recursive: true });
  await mkdir(path.join(state, "home"), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  for (const [relative, source] of Object.entries(adapter.seedFiles ?? {})) {
    const dest = path.resolve(state, relative);
    if (!dest.startsWith(path.resolve(state) + path.sep)) throw Error("Invalid seed destination");
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(source, dest);
  }
  for (const [relative, content] of Object.entries(adapter.stateFiles ?? {})) {
    const dest = path.resolve(state, relative);
    if (!dest.startsWith(path.resolve(state) + path.sep)) throw Error("Invalid state destination");
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  const interpolate = (value) =>
    value
      .replaceAll("{workspace}", "/workspace")
      .replaceAll("{state}", "/state")
      .replaceAll("{prompt}", prompt);
  const args = [
    "--die-with-parent",
    "--unshare-user",
    ...(execFileSync("/usr/bin/bwrap", ["--help"], { encoding: "utf8" }).includes(
      "--disable-userns",
    )
      ? ["--disable-userns"]
      : []),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/etc",
    "/etc",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
  ];
  const createdDirectories = new Set();
  for (const mount of adapter.readOnly ?? []) addReadOnlyMount(args, mount, createdDirectories);

  const resolver = realpathSync("/etc/resolv.conf");
  if (resolver !== "/etc/resolv.conf") args.push("--ro-bind", resolver, resolver);
  args.push(
    "--bind",
    path.resolve(workspace),
    "/workspace",
    "--bind",
    path.resolve(state),
    "/state",
    "--chdir",
    "/workspace",
    "--",
    adapter.command,
    ...adapter.args.map(interpolate),
  );
  const environment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/state/home",
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "true",
    ...Object.fromEntries(Object.entries(adapter.env ?? {}).map(([k, v]) => [k, interpolate(v)])),
  };
  const command = adapter.driver?.command ?? adapter.command;
  const commandArgs = adapter.driver?.args ?? adapter.args;
  args.splice(
    args.indexOf("--") + 1,
    1 + adapter.args.length,
    command,
    ...commandArgs.map(interpolate),
  );
  if (adapter.driver?.persistent)
    return runPersistentHarness(adapter, {
      state,
      artifacts,
      prompt,
      timeoutMs,
      args,
      env: environment,
    });
  const output = createWriteStream(path.join(artifacts, "stdout.jsonl"));
  const errors = createWriteStream(path.join(artifacts, "stderr.log"));
  const started = performance.now();
  let timedOut = false;
  const child = spawn("/usr/bin/bwrap", args, {
    env: environment,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.pipe(output);
  child.stderr.pipe(errors);
  child.stdin.on("error", () => {});
  child.stdin.end(adapter.promptStdin ? prompt : undefined);
  const terminate = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  let exitCode, signal;
  try {
    [exitCode, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, sig) => resolve([code, sig]));
    });
  } finally {
    clearTimeout(timer);
    if (child.pid) terminate();
  }
  await Promise.all([finished(output), finished(errors)]);
  await copyStateArtifacts(adapter, state, artifacts);
  return { exitCode, signal, timedOut, processSeconds: (performance.now() - started) / 1000 };
}

function sumUsage(records, fields) {
  if (!records.length) return null;
  return records.reduce(
    (sum, record) => {
      for (const field of fields) sum[field] += Number(record[field] ?? 0);
      return sum;
    },
    Object.fromEntries(fields.map((field) => [field, 0])),
  );
}

/** Normalize only observable events; absent metrics stay null rather than zero. */
export async function inspectHarnessOutput(kind, file) {
  if (typeof kind === "object" && typeof kind.inspectOutput === "function")
    return kind.inspectOutput(file);
  if (typeof kind === "object") kind = kind.kind;
  const events = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  let calls = null,
    rounds = null;
  const errors = [];
  if (kind === "codex-cli-default") {
    calls = events.filter(
      (e) =>
        e.type === "item.completed" &&
        ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(e.item?.type),
    );
    rounds = null; // A Codex turn can contain several model requests.
    errors.push(...events.filter((e) => e.type === "error" || e.type === "turn.failed"));
  } else if (kind === "opencode-default") {
    calls = events.filter((e) => e.type === "tool_use");
    rounds = events.filter((e) => e.type === "step_finish").length;
    errors.push(...events.filter((e) => e.type === "error"));
  } else if (
    ["oh-my-pi-default", "pi-default", "baseline-agent", "pi-agent-ide", "pi-aft"].includes(kind)
  ) {
    calls = events.filter((e) => e.type === "tool_execution_start");
    rounds = events.filter(
      (e) => e.type === "message_end" && e.message?.role === "assistant",
    ).length;
    errors.push(
      ...events.filter((e) => e.type === "message_end" && e.message?.stopReason === "error"),
    );
  } else if (["dsh-standard", "dsh-code"].includes(kind)) {
    calls = events.filter((e) => e.type === "tool/call");
    rounds = events.filter((e) => e.type === "assistant/message").length;
    errors.push(
      ...events.filter((e) => e.type === "turn/end" && e.data?.reason?.kind !== "completed"),
    );
  } else if (kind === "github-copilot-cli-default") {
    calls = events.filter((e) => e.type === "tool.execution_start");
    rounds = events.filter((e) => e.type === "assistant.turn_start").length;
    errors.push(...events.filter((e) => e.type === "session.error"));
  }
  let usage = null;
  let costUsd = null;
  let failedToolCalls = null;
  let invalidToolCalls = null;
  if (
    ["oh-my-pi-default", "pi-default", "baseline-agent", "pi-agent-ide", "pi-aft"].includes(kind)
  ) {
    const assistantEnds = events.filter(
      (event) => event.type === "message_end" && event.message?.role === "assistant",
    );
    usage = sumUsage(assistantEnds.map((event) => event.message?.usage).filter(Boolean), [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
    ]);
    const costs = assistantEnds
      .map((event) => event.message?.usage?.cost?.total)
      .filter((value) => typeof value === "number");
    if (costs.length) costUsd = costs.reduce((sum, value) => sum + value, 0);
    const toolEnds = events.filter((event) => event.type === "tool_execution_end");
    failedToolCalls = toolEnds.length
      ? toolEnds.filter((event) => event.result?.isError === true).length
      : null;
    invalidToolCalls = null;
  } else if (kind === "codex-cli-default") {
    const completed = events.filter((event) => event.type === "turn.completed" && event.usage);
    const native = sumUsage(
      completed.map((event) => event.usage),
      ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"],
    );
    if (native) {
      const cacheRead = native.cached_input_tokens;
      const cacheWrite = native.cache_write_input_tokens;
      const input = native.input_tokens - cacheRead - cacheWrite;
      if (input >= 0)
        usage = {
          input,
          output: native.output_tokens,
          cacheRead,
          cacheWrite,
          totalTokens: native.input_tokens + native.output_tokens,
        };
    }
    const completedTools = events.filter(
      (event) => event.type === "item.completed" && calls?.includes(event),
    );
    failedToolCalls = completedTools.length
      ? completedTools.filter(
          (event) =>
            event.item?.status === "failed" ||
            (typeof event.item?.exit_code === "number" && event.item.exit_code !== 0),
        ).length
      : null;
    invalidToolCalls = null;
  }
  return {
    toolCalls: calls?.length ?? null,
    modelRounds: rounds,
    errors,
    calls,
    eventCount: events.length,
    costUsd,
    inputTokens: usage?.input ?? null,
    outputTokens: usage?.output ?? null,
    cacheReadTokens: usage?.cacheRead ?? null,
    cacheWriteTokens: usage?.cacheWrite ?? null,
    totalTokens: usage?.totalTokens ?? null,
    failedToolCalls,
    invalidToolCalls,
    // Built-in adapters currently expose no documented machine-readable provider cause.
    providerFailure: null,
  };
}
