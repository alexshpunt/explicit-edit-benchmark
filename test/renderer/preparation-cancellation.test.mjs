import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareMultiAgent } from "../../src/suites/explicit-edit-multi-agent/prepare.mjs";
import { runMultiAgentBatch } from "../../scripts/run-multi-agent-batch.mjs";

const scratch = path.resolve(".tmp/preparation-cancellation");

async function ownedProcesses(markers) {
  const result = [];
  for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (!markers.some((marker) => command.includes(marker))) continue;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    if (stat)
      result.push({
        pid: Number(pid),
        group: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]),
      });
  }
  return result;
}

for (const common of [false, true]) {
  test(`${common ? "automatic common" : "public suite"} preparation refuses cancellation before creating output`, async () => {
    const output = path.join(scratch, `pre-cancelled-${common}-${process.pid}`);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      common
        ? runMultiAgentBatch({ root: output, signal: controller.signal })
        : prepareMultiAgent(output, { signal: controller.signal }),
      { name: "AbortError" },
    );
    await assert.rejects(access(output), { code: "ENOENT" });
  });
}

for (const cli of [false, true]) {
  test(
    `cancelling ${cli ? "the preparation CLI" : "automatic preparation"} closes nested reference namespaces before any model starts`,
    { timeout: 15000 },
    async (t) => {
      const root = path.join(scratch, `active-${cli}-${process.pid}`);
      await mkdir(root, { recursive: true });
      const bin = path.join(root, "bin");
      await mkdir(bin);
      const marker = path.join(root, "started");
      const late = path.join(root, "late-write");
      const compilerScript = path.join(root, "compiler.cjs");
      const childMarker = `${marker}.child`;
      const childScript = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(childMarker)}, "started");
setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "late"), 1500);
`;
      await writeFile(
        compilerScript,
        `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
spawn("/usr/bin/bwrap", ["--bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--new-session", "--die-with-parent", "--", process.execPath, "-e", ${JSON.stringify(childScript)}], { stdio: "inherit" });
const started = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(childMarker)})) return;
  fs.writeFileSync(${JSON.stringify(marker)}, "started");
  clearInterval(started);
}, 10);
setInterval(() => {}, 1000);
`,
      );
      await writeFile(
        path.join(bin, "clang++"),
        `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(compilerScript)}\n`,
        { mode: 0o700 },
      );
      const output = path.join(root, "output");
      const args = cli
        ? [
            fileURLToPath(new URL("../../scripts/multi-agent.mjs", import.meta.url)),
            "prepare",
            output,
          ]
        : [
            "--input-type=module",
            "-e",
            `
import { access, readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { runMultiAgentBatch } from ${JSON.stringify(new URL("../../scripts/run-multi-agent-batch.mjs", import.meta.url).href)};
const controller = new AbortController();
const pending = runMultiAgentBatch({ root: ${JSON.stringify(output)}, signal: controller.signal });
for (let attempt = 0; attempt < 500; attempt++) {
  try { await access(${JSON.stringify(marker)}); break; } catch { await delay(10); }
}
await readFile(${JSON.stringify(marker)});
controller.abort();
try { await pending; process.exitCode = 2; } catch (error) {
  if (error.name !== "AbortError") { console.error(error); process.exitCode = 3; }
}
// Check immediately at settlement, while this caller is still running.
for (const pid of (await readdir("/proc")).filter(name => /^\\d+$/.test(name))) {
  if (Number(pid) === process.pid) continue;
  const command = await readFile("/proc/" + pid + "/cmdline", "utf8").catch(() => "");
  if ([${JSON.stringify(compilerScript)}, ${JSON.stringify(childMarker)}].some(marker => command.includes(marker))) {
    console.error("Preparation settled before owned process " + pid + " closed");
    process.exitCode = 4;
  }
}
`,
          ];
      const child = spawn(process.execPath, args, {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      t.after(async () => {
        const groups = new Set(
          (await ownedProcesses([compilerScript, childMarker])).map((entry) => entry.group),
        );
        if (child.exitCode === null && child.signalCode === null) groups.add(child.pid);
        for (const group of groups) {
          try {
            process.kill(-group, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await rm(root, { recursive: true, force: true });
      });
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      if (cli) {
        for (let attempt = 0; attempt < 500; attempt++) {
          try {
            await access(marker);
            break;
          } catch {
            await delay(10);
          }
        }
        await readFile(marker);
        child.kill("SIGTERM");
      }
      assert.equal(await exited, cli ? 1 : 0, stderr);
      assert.deepEqual(await ownedProcesses([compilerScript, childMarker]), []);
      await delay(1800);
      await assert.rejects(access(late), { code: "ENOENT" });
      await assert.rejects(access(path.join(output, "reference-proof")), { code: "ENOENT" });
      await assert.rejects(access(path.join(output, "teams")), { code: "ENOENT" });
    },
  );
}
