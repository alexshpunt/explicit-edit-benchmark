import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, open, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForProcessBoundaryExit } from "./process-boundary.mjs";

/** One sandbox for a whole team: every agent of a run joins the same user and PID
 * namespaces and sees the same /tmp, so agents can see and reach each other's
 * processes, and a language server one agent's tools start serves every agent.
 * Each agent keeps only its own Pi state directory.
 */
export const SHARED_SANDBOX_POLICY = "one-sandbox-per-team-v1";

/** Pi Agent IDE starts one shared language-server host per configuration, detached
 * from the session that needed it first, so that it outlives that session.
 */
export const SHARED_SERVER_MARKER = "shared-server-host.mjs";

const JOIN = fileURLToPath(new URL("./shared-sandbox-join.py", import.meta.url));

/** Start the team sandbox: an idle process that holds its namespaces. Agents join
 * it through joinCommand. stop kills every process in it and waits until the
 * namespace is empty.
 */
export async function startSharedSandbox(directory, { signal } = {}) {
  signal?.throwIfAborted();
  const root = path.resolve(directory);
  await mkdir(root, { mode: 0o700 });
  const tmp = path.join(root, "tmp");
  await mkdir(tmp, { mode: 0o700 });
  const anchor = spawn(
    "bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--new-session",
      "--die-with-parent",
      "--clearenv",
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
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--info-fd",
      "3",
      "/usr/bin/sleep",
      "infinity",
    ],
    { detached: true, stdio: ["ignore", "ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } },
  );
  let stderr = "";
  anchor.stderr.on("data", (bytes) => (stderr += bytes));
  const closed = new Promise((resolve) => anchor.once("close", resolve));
  const init = await new Promise((resolve, reject) => {
    let information = "";
    anchor.stdio[3].on("data", (bytes) => (information += bytes));
    anchor.stdio[3].once("end", () => {
      try {
        const pid = JSON.parse(information)["child-pid"];
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        resolve(pid);
      } catch {
        reject(new Error(`The shared sandbox did not start: ${stderr.trim()}`));
      }
    });
    anchor.once("error", reject);
  });
  // Holding the namespace open keeps its identity stable until stop has waited.
  const handle = await open(`/proc/${init}/ns/pid`, "r");
  const namespace = await readlink(`/proc/self/fd/${handle.fd}`);
  let stopped;
  return {
    policy: SHARED_SANDBOX_POLICY,
    init,
    tmp,
    /** The command that runs Bubblewrap with these arguments inside the sandbox. */
    joinCommand: (bwrapArguments) => ["python3", [JOIN, String(init), ...bwrapArguments]],
    stop() {
      stopped ??= (async () => {
        try {
          process.kill(-anchor.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        await closed;
        try {
          await waitForProcessBoundaryExit(namespace);
        } finally {
          await handle.close();
        }
      })();
      return stopped;
    },
  };
}

/** The process table from /proc. Processes that exit while it is read are skipped. */
export function readProcessTable() {
  const table = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const command = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ");
      table.push({ pid: Number(name), ppid: Number(fields[1]), start: fields[19], command });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return table;
}

/** An agent's processes: its Pi process and everything it started, except a
 * shared language-server host and that host's own processes, which serve the
 * whole team and stay until the sandbox stops.
 */
export function participantTree(table, root) {
  const children = new Map();
  for (const entry of table) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry);
  }
  const found = [];
  const pending = table.filter((entry) => entry.pid === root);
  while (pending.length) {
    const entry = pending.pop();
    if (entry.command.includes(SHARED_SERVER_MARKER)) continue;
    found.push({ pid: entry.pid, start: entry.start });
    pending.push(...(children.get(entry.pid) ?? []));
  }
  return found;
}

/** Kill the listed processes that still run; a reused PID has another start time. */
export function killProcesses(processes) {
  const current = new Map(readProcessTable().map((entry) => [entry.pid, entry.start]));
  for (const { pid, start } of processes) {
    if (current.get(pid) !== start) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
