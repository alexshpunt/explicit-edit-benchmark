import assert from "node:assert/strict";
import { readFile, readdir, readlink } from "node:fs/promises";

const failure = (message, category) => Object.assign(new Error(message), { category });
const gone = (error) => ["ENOENT", "ESRCH"].includes(error.code);
async function record(pid) {
  const [status, stat, namespace] = await Promise.all([
    readFile(`/proc/${pid}/status`, "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
    readlink(`/proc/${pid}/ns/pid`),
  ]);
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const nested = /^NSpid:\s*(.*)$/m.exec(status);
  assert.ok(nested, "Missing participant PID namespace metadata");
  return {
    pid,
    namespace,
    inside: Number(nested[1].trim().split(/\s+/).at(-1)),
    state: fields[0],
    start: fields[19],
  };
}

/** Inspect every thread's descendants, including detached/reparented tool work.
 * The caller supplies Bubblewrap's namespace-init host PID and Pi's observed
 * in-namespace agent PID. No shell, inference, polling deadline or signal is used.
 * Unknown live descendants cannot be hidden by a settled RPC/tool response.
 */
export async function assertProcessBoundary(rootPid, agentPid, expected) {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, "Missing participant namespace root");
  assert.ok(Number.isSafeInteger(agentPid) && agentPid > 0, "Missing participant process identity");
  let root;
  try {
    root = await record(rootPid);
  } catch (error) {
    if (gone(error)) throw failure("Participant namespace exited", "driver_exit");
    throw error;
  }
  const pending = [rootPid],
    seen = new Set(),
    records = [];
  while (pending.length) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    let current;
    try {
      current = pid === rootPid ? root : await record(pid);
    } catch (error) {
      if (gone(error)) continue;
      throw error;
    }
    if (["Z", "X"].includes(current.state)) continue;
    records.push(current);
    try {
      for (const thread of await readdir(`/proc/${pid}/task`)) {
        try {
          const children = await readFile(`/proc/${pid}/task/${thread}/children`, "utf8");
          pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
        } catch (error) {
          if (!gone(error)) throw error;
        }
      }
    } catch (error) {
      if (!gone(error)) throw error;
    }
  }
  const agents = records.filter(
    (item) => item.namespace === root.namespace && item.inside === agentPid,
  );
  if (agents.length !== 1) throw failure("Participant process identity changed", "driver_exit");
  const agent = agents[0];
  const observed = {
    rootPid,
    rootStart: root.start,
    namespace: root.namespace,
    agentHostPid: agent.pid,
    agentStart: agent.start,
    agentPid,
  };
  if (expected && JSON.stringify(observed) !== JSON.stringify(expected))
    throw failure("Participant process lifetime changed", "driver_exit");
  if (
    records.some((item) => item.pid !== agent.pid && !(item.pid === rootPid && item.inside === 1))
  )
    throw failure("Participant has undrained tool subprocesses", "infrastructure");
  const final = await record(rootPid);
  if (final.start !== root.start || final.namespace !== root.namespace)
    throw failure("Participant namespace lifetime changed", "driver_exit");
  return observed;
}
