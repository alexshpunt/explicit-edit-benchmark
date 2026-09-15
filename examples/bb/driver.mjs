import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import readline from "node:readline";
import path from "node:path";

/**
 * Drive bb for one benchmark trial, and keep the thread alive across attempts.
 *
 * bb is not one CLI call: it needs a server and a machine daemon, and it edits the workspace
 * through a thread. So this file is a persistent driver. The benchmark starts it once per trial
 * and writes one JSON line per turn:
 *
 *   {"prompt": "..."}
 *
 * For each turn it writes the harness events to stdout as JSON lines and ends the turn with
 *
 *   {"type": "eval/turn-complete", "reason": {"kind": "completed"}}
 *
 * The first turn starts the server, enrolls the daemon, registers the workspace as a project,
 * and spawns a thread with bb's `project-checkout` environment, so the agent edits the mounted
 * workspace in place. Later turns send the prompt to that same thread and print only the events
 * that turn added. That is what lets an oracle recovery continue the session instead of losing it.
 *
 * Environment:
 *
 *   BB_APP          installed bb-app package directory (required)
 *   BB_DATA_DIR     bb state directory, default /state/bb
 *   BB_SERVER_URL   server address; by default a free port, because parallel trials share one network
 *   BB_WORKSPACE    workspace the agent edits, default /workspace
 *   BB_PROVIDER     provider bb runs, default pi
 *   BB_MODEL        model id passed to the provider (required)
 *   BB_REASONING    reasoning level, default low
 *   BB_WAIT_SECONDS how long one turn may run, default 600
 */

const bbApp = process.env.BB_APP;
const dataDirectory = process.env.BB_DATA_DIR ?? "/state/bb";
const configuredServerUrl = process.env.BB_SERVER_URL;
const workspace = process.env.BB_WORKSPACE ?? "/workspace";
const provider = process.env.BB_PROVIDER ?? "pi";
const model = process.env.BB_MODEL;
const reasoning = process.env.BB_REASONING ?? "low";
const waitSeconds = Number(process.env.BB_WAIT_SECONDS ?? "600");

if (!bbApp) throw Error("BB_APP must point at an installed bb-app package");
if (!model) throw Error("BB_MODEL must name the model bb passes to the provider");

const started = performance.now();
/** Progress goes to stderr with elapsed seconds, because a slow step must be visible. */
const note = (message) =>
  process.stderr.write(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${message}\n`);
const describe = (error) => (error instanceof Error ? error.message : String(error));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverUrl = configuredServerUrl;
let daemonPort;
let environment = { ...process.env };
let machineId;
let threadId;
let lastSequence = 0;

/** Run the bb CLI and fail loudly, because a silent failure would look like an empty run. */
function bb(args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(bbApp, "dist/bb.js"), ...args], {
    encoding: "utf8",
    env: environment,
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  const output = (result.stdout ?? "").trim();
  if (result.status !== 0)
    throw Error(`bb ${args.join(" ")} failed: ${(result.stderr || output).trim()}`);
  return output;
}

const bbJson = (args) => JSON.parse(bb([...args, "--json"]));

/**
 * Ask the kernel for free ports. Sandboxes share the host network, so trials must not share
 * ports, and the ports are held at once because two separate requests can return the same one.
 */
async function freePorts(count) {
  const listeners = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise((resolve, reject) => {
          const listener = createServer();
          listener.once("error", reject);
          listener.listen(0, "127.0.0.1", () => resolve(listener));
        }),
    ),
  );
  const ports = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  return ports;
}

/** Start a bb service. The sandbox owns its lifetime, not this driver. */
function startService(script, args = []) {
  spawn(process.execPath, [path.join(bbApp, "dist", script), ...args], {
    env: environment,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();
}

async function waitFor(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = check();
      if (value) return value;
    } catch (error) {
      // Keep the step name, so a failure says what the driver was waiting for.
      if (Date.now() > deadline)
        throw Error(`${label}: ${describe(error)}`, {
          cause: error,
        });
    }
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
    await sleep(1000);
  }
}

const machines = () => bbJson(["machine", "list"]);
const connectedMachine = () =>
  machineId
    ? machines().find((entry) => entry.id === machineId && entry.status === "connected")
    : null;

/** Start or reuse the server, then enroll one daemon that belongs to this sandbox trial. */
async function startInfrastructure() {
  if (machineId && connectedMachine()) return;

  if (!serverUrl) {
    const [serverPort, freshDaemonPort] = await freePorts(2);
    serverUrl = `http://127.0.0.1:${serverPort}`;
    daemonPort = freshDaemonPort;
    note(`bb: starting server on ${serverUrl}, daemon on ${daemonPort}`);
    environment = {
      ...environment,
      BB_DATA_DIR: dataDirectory,
      BB_SERVER_URL: serverUrl,
      BB_HOST_DAEMON_PORT: String(daemonPort),
    };
    startService("bb-server.js", [
      "--data-dir",
      dataDirectory,
      "--server-port",
      String(serverPort),
    ]);
    // `status` answers without a server, so probe with a command that cannot.
    await waitFor(
      `the bb server (its log is ${path.join(dataDirectory, "logs", "server-stdio.log")})`,
      () => machines(),
      180_000,
    );
  } else {
    [daemonPort] = await freePorts(1);
    environment = {
      ...environment,
      BB_DATA_DIR: dataDirectory,
      BB_SERVER_URL: serverUrl,
      BB_HOST_DAEMON_PORT: String(daemonPort),
    };
    await waitFor(`the shared bb server at ${serverUrl}`, () => machines(), 180_000);
    note(`bb: reusing server ${serverUrl}, daemon on ${daemonPort}`);
  }

  const existingMachineIds = new Set(machines().map((entry) => entry.id));
  note("bb: enrolling this trial's machine");
  startService("bb-host-daemon.js", [
    "join",
    "--server-url",
    serverUrl,
    "--host-daemon-port",
    String(daemonPort),
  ]);
  const machine = await waitFor(
    "this trial's connected machine",
    () =>
      machines().find((entry) => entry.status === "connected" && !existingMachineIds.has(entry.id)),
    180_000,
  );
  machineId = machine.id;
}

/**
 * bb lists a machine as connected a moment before the host answers, so a spawn right after
 * enrollment can fail. Wait for the host instead of writing that off as a task failure.
 */
async function withConnectedHost(operation) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      const message = describe(error);
      if (!/Host is not connected|Cannot reach local host daemon/.test(message)) throw error;
      if (Date.now() > deadline) throw error;
      note(`bb: the host is not ready yet: ${message}`);
      await sleep(3000);
    }
  }
}

/** Print the thread timeline, and remember how far it was printed. */
function printTimeline() {
  const timeline = bbJson(
    lastSequence === 0
      ? ["thread", "log", threadId, "--all"]
      : ["thread", "log", threadId, "--all", "--after-seq", String(lastSequence)],
  );
  for (const event of timeline) process.stdout.write(`${JSON.stringify(event)}\n`);
  const sequences = timeline.map((event) => Number(event.seq)).filter(Number.isFinite);
  if (sequences.length) lastSequence = Math.max(...sequences);
  note(`bb: printed ${timeline.length} timeline events`);
}

/** A failing turn still deserves its evidence, but a broken server must not hide the failure. */
function printTimelineSafely() {
  try {
    if (threadId) printTimeline();
  } catch (error) {
    note(`bb: could not read the timeline: ${describe(error)}`);
  }
}

/** Run one turn, and return a failure message when bb did not finish it cleanly. */
async function runTurn(prompt) {
  await startInfrastructure();
  if (!threadId) {
    note(`bb: registering ${workspace} as a project`);
    const projectId = await withConnectedHost(
      () =>
        bbJson([
          "project",
          "create",
          "--name",
          `explicit-edit-${process.pid}`,
          "--root",
          workspace,
          "--machine",
          machineId,
        ]).id,
    );
    note(`bb: spawning a ${provider} thread on ${model}`);
    threadId = await withConnectedHost(
      () =>
        bbJson([
          "thread",
          "spawn",
          "--project",
          projectId,
          "--environment-provider",
          "project-checkout",
          "--prompt",
          prompt,
          "--provider",
          provider,
          "--model",
          model,
          "--reasoning-level",
          reasoning,
          "--permission-mode",
          "full",
        ]).id,
    );
  } else {
    note(`bb: continuing ${threadId}`);
    bb(["thread", "tell", threadId, prompt]);
  }

  note(`bb: waiting for ${threadId} to finish`);
  try {
    bb(["thread", "wait", threadId, "--status", "idle", "--timeout", String(waitSeconds)]);
  } catch (error) {
    const failure = describe(error);
    note(`bb: the thread did not reach idle: ${failure}`);
    // The timeline is the evidence, so print it even when the thread failed.
    printTimeline();
    return failure;
  }
  printTimeline();
  return null;
}

const turns = readline.createInterface({ input: process.stdin });
for await (const line of turns) {
  if (!line.trim()) continue;
  let prompt;
  try {
    prompt = JSON.parse(line).prompt;
  } catch {
    note("bb: ignoring a stdin line that is not a JSON turn request");
    continue;
  }
  let failure;
  try {
    failure = await runTurn(prompt);
  } catch (error) {
    failure = describe(error);
    note(`bb: the turn failed: ${failure}`);
    printTimelineSafely();
  }
  const reason = failure ? { kind: "failed", detail: failure } : { kind: "completed" };
  process.stdout.write(`${JSON.stringify({ type: "eval/turn-complete", reason })}\n`);
}
