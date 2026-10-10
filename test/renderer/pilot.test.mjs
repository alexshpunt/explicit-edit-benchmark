import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  readTree,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const execFile = promisify(execFileCallback);
const cli = path.resolve("scripts/multi-agent/experiments/pilot.mjs");
assert.ok(
  process.env.RENDERER_PILOT_OUTPUT,
  "Set a new RENDERER_PILOT_OUTPUT directory on the worker",
);
const root = path.resolve(process.env.RENDERER_PILOT_OUTPUT);
const command = (args) =>
  execFile(process.execPath, [cli, ...args], { timeout: 1800000, maxBuffer: 4 * 1024 * 1024 });
const load = async (file) => JSON.parse(await readFile(file, "utf8"));

async function executor(name, source) {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "reference"), { recursive: true });
  await mkdir(path.join(directory, "cpp"));
  await writeFile(path.join(directory, "reference/scripted-worker.mjs"), source);
  await copyFile(
    "src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs",
    path.join(directory, "cpp/cpp-tokens.mjs"),
  );
  const config = path.join(root, `${name}.json`);
  await writeFile(config, JSON.stringify({ harness: "scripted", executor: name }));
  return config;
}

async function interrupted(prepared, signal) {
  const name = signal === "SIGTERM" ? "cancelled" : "interrupted";
  const config = await executor(
    name,
    `import { writeFile } from "node:fs/promises";
for await (const chunk of process.stdin) { if (chunk.length) break; }
await writeFile("/workspace/started", "started");
setTimeout(async () => { await writeFile("/workspace/late-edit", "bad"); }, 2000);
`,
  );
  const output = path.join(root, `${name}-run`);
  const child = spawn(process.execPath, [cli, "verify", prepared, output, config], {
    stdio: "ignore",
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, sig) => resolve({ code, signal: sig }));
  });
  try {
    let started = false;
    for (let i = 0; i < 1800; i++) {
      try {
        await access(path.join(output, "workspace/started"));
        started = true;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(100);
    }
    assert.ok(started, "The real isolated worker must be running before interruption");
    child.kill(signal);
    const exit = await finished;
    if (signal === "SIGTERM") assert.equal(exit.code, 1);
    else assert.equal(exit.signal, "SIGKILL");
    await delay(2200);
    await assert.rejects(access(path.join(output, "workspace/late-edit")), { code: "ENOENT" });
    const rebuilt = await command(["report", output]);
    assert.match(rebuilt.stdout, new RegExp(name));
    const summary = await load(path.join(output, "summary.json"));
    assert.equal(summary.status, name);
    assert.equal(summary.passedPrefix, 0);
    assert.equal(summary.counts.attempts, 1);
    assert.equal(summary.counts.unattempted, 10);
    assert.equal(summary.usage.totalTokens.total, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await finished;
  }
}

await test(
  "fresh pilot commands verify all eleven requests, retained repair and block, cancellation and crash recovery without model access",
  { timeout: 3000000 },
  async () => {
    await mkdir(path.dirname(root), { recursive: true });
    await mkdir(root);
    const prepared = path.join(root, "prepared");
    const preparation = await command(["prepare", prepared]);
    console.log(preparation.stdout.trim());
    const manifest = await load(path.join(prepared, "pilot.json"));
    assert.equal(manifest.version, "renderer-pilot-v1");
    assert.equal(manifest.status, "pass");
    assert.equal(manifest.policy.attempts, 3);
    assert.equal(manifest.pixels.length, 2);
    for (const hash of [
      manifest.identity,
      manifest.sources.fixture,
      manifest.sources.grader,
      manifest.workload,
    ])
      assert.match(hash, /^[a-f0-9]{64}$/);
    const review = await readFile(path.join(prepared, "slice/review.md"), "utf8");
    assert.equal([...review.matchAll(/^## step-/gm)].length, 11);
    assert.doesNotMatch(review, /yocto/i);
    await assert.rejects(command(["prepare", prepared]));
    const ready = await command(["ready", prepared]);
    assert.match(ready.stdout, /zero model calls/);
    const workloadFile = path.join(prepared, "slice/trusted/workload.json");
    const workloadText = await readFile(workloadFile, "utf8");
    try {
      await writeFile(workloadFile, workloadText + " ");
      await assert.rejects(command(["ready", prepared]), (error) => {
        assert.match(error.stderr, /Workload changed/);
        return true;
      });
    } finally {
      await writeFile(workloadFile, workloadText);
    }
    const passed = path.join(root, "passed");
    const complete = await command(["verify", prepared, passed]);
    console.log(complete.stdout.trim());
    const report = await load(path.join(passed, "report.json"));
    assert.equal(report.status, "pass");
    assert.equal(report.passedPrefix, 11);
    assert.equal(report.livePi, false);
    assert.equal(report.experiment.identity, manifest.identity);
    assert.equal(report.attempts.length, 11);
    for (const attempt of report.attempts) {
      assert.deepEqual(attempt.grade.pixels, manifest.pixels);
      assert.equal(
        treeIdentity(await readTree(path.join(passed, "sources", attempt.after))),
        attempt.after,
      );
    }
    await writeFile(path.join(passed, "report.json"), "damaged cached report");
    const rebuilt = await command(["report", passed]);
    assert.match(rebuilt.stdout, /11\/11/);
    assert.deepEqual(await load(path.join(passed, "report.json")), report);
    const solver = await readFile(
      "src/suites/explicit-edit-multi-agent/reference/scripted-worker.mjs",
      "utf8",
    );
    const definitions = solver.slice(0, solver.indexOf("\nasync function main()"));
    assert.ok(definitions.length > 1000);
    const config = await executor(
      "repair-block",
      definitions +
        `
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
let count = 0;
try { count = Number(await readFile("/workspace/count", "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
count++;
const tree = {};
for (const name of await readdir("/workspace")) if (/\\.(cpp|h)$/.test(name)) tree[name] = await readFile("/workspace/" + name, "utf8");
if (count === 1 || count >= 4) {
  tree["main.cpp"] += "\\nno_such_type failed_" + count + ";\\n";
} else {
  if (count === 2) {
    if (!tree["main.cpp"].includes("no_such_type failed_1;")) throw Error("The failed edit was reset");
    if (!prompt.includes("Previous attempt failed [build]")) throw Error("Missing real compiler feedback");
    tree["main.cpp"] = tree["main.cpp"].replace("\\nno_such_type failed_1;\\n", "");
  }
  Object.assign(tree, applyRequest(tree, prompt.trim()));
}
for (const [name, source] of Object.entries(tree)) await writeFile("/workspace/" + name, source);
await writeFile("/workspace/count", String(count));
`,
    );
    const blocked = path.join(root, "blocked");
    await assert.rejects(command(["verify", prepared, blocked, config]), (error) => {
      console.log(error.stdout.trim());
      assert.match(error.stdout, /BLOCKED: 2\/11/);
      return true;
    });
    const failure = await load(path.join(blocked, "report.json"));
    assert.deepEqual(
      failure.attempts.map((attempt) => attempt.status),
      ["fail", "pass", "pass", "fail", "fail", "fail"],
    );
    for (let i = 1; i < failure.attempts.length; i++)
      assert.equal(failure.attempts[i].before, failure.attempts[i - 1].after);
    const final = await readTree(path.join(blocked, "workspace"));
    assert.match(final["main.cpp"], /failed_4;[\s\S]*failed_5;[\s\S]*failed_6;/);
    assert.doesNotMatch(final["main.cpp"], /failed_1;/);
    await command(["report", blocked]);
    const blockedSummary = await load(path.join(blocked, "summary.json"));
    assert.equal(blockedSummary.status, "blocked");
    assert.equal(blockedSummary.counts.repairedPass, 1);
    assert.equal(blockedSummary.counts.failedAttempts, 4);
    assert.equal(blockedSummary.counts.unattempted, 8);
    await interrupted(prepared, "SIGTERM");
    await interrupted(prepared, "SIGKILL");
    console.log(
      "VERIFIED PILOT COMMANDS: fresh preparation, 11/11, retained compiler repair, three-attempt block, cancellation and offline crash recovery; zero model calls",
    );
  },
);
