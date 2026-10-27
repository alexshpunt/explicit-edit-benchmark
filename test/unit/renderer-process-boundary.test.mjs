import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import test from "node:test";
import { assertProcessBoundary } from "../../src/suites/explicit-edit-multi-agent/execution/process-boundary.mjs";

async function fixture(t) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {spawn} from 'node:child_process';
    process.stdout.write('ready\\n');
    process.stdin.on('data', () => {
      const child = spawn('/bin/sh', ['-c', 'sleep 30'], {detached:true,stdio:'ignore'});
      process.stdout.write(String(child.pid)+'\\n');
    });
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, "ready");
  let descendant;
  t.after(async () => {
    if (descendant) {
      try {
        process.kill(-descendant, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  });
  const status = await readFile(`/proc/${child.pid}/status`, "utf8");
  const agentPid = Number(/^NSpid:\s*(.*)$/m.exec(status)[1].trim().split(/\s+/).at(-1));
  return {
    child,
    agentPid,
    async background() {
      child.stdin.write("spawn\n");
      descendant = Number((await lines.next()).value);
      assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
      return descendant;
    },
  };
}

test("process-boundary inspection retains the exact living participant without spawning work", async (t) => {
  const { child, agentPid } = await fixture(t);
  const first = await assertProcessBoundary(child.pid, agentPid);
  assert.equal(first.agentHostPid, child.pid);
  const again = await assertProcessBoundary(child.pid, agentPid, first);
  assert.deepEqual(again, first);
  await assert.rejects(
    assertProcessBoundary(child.pid, agentPid, { ...first, agentStart: "different" }),
    (error) => error.category === "driver_exit",
  );
});

test("a detached tool descendant is an infrastructure boundary violation even after its shell returns", async (t) => {
  const f = await fixture(t);
  const initial = await assertProcessBoundary(f.child.pid, f.agentPid);
  await f.background();
  await assert.rejects(
    assertProcessBoundary(f.child.pid, f.agentPid, initial),
    (error) => error.category === "infrastructure",
  );
});
