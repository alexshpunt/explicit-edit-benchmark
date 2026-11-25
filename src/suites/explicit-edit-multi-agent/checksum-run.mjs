import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chunkModelDrivers } from "./execution/chunk-model-drivers.mjs";
import { runAgentQueue } from "./execution/fresh-agent-queue.mjs";
import { restoringSourceIdentity } from "./execution/restoring-identity.mjs";
import {
  CHECKSUM_PROJECT_VERSION,
  generateChecksumProject,
} from "./generation/checksum-project.mjs";

/** Isolated runs of a generated checksum project: every task goes to a new agent in
 * its own copy of the start project, as in the original suite. A task passes when
 * its main.cpp equals the task's reference byte for byte; the build and the printed
 * answer are recorded beside it.
 */
export const CHECKSUM_RUN_VERSION = "multi-agent-checksum-isolated-v1";
export const CHECKSUM_DELIVERY_DEADLINE_MS = 300_000;
const execFileAsync = promisify(execFile);

/** Build one main.cpp and run it; the result records what it printed. */
export async function buildAndRun(directory, source, signal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "main.cpp"),
    binary = path.join(directory, "program");
  await writeFile(file, source);
  try {
    await execFileAsync("clang++", ["-std=c++17", file, "-o", binary], { signal });
  } catch (error) {
    return { built: false, output: null, error: String(error.stderr ?? error.message) };
  }
  try {
    const { stdout } = await execFileAsync(binary, [], { signal, timeout: 10_000 });
    return { built: true, output: stdout.trim() };
  } catch (error) {
    return { built: true, output: null, error: String(error.message) };
  }
}

/** Spend model credit on one isolated run of every task of the seed's project. */
export async function runChecksumIsolated(
  seed,
  outputPath,
  config,
  { agents = 5, options = {}, signal } = {},
) {
  assert.ok(Number.isSafeInteger(agents) && agents >= 1);
  const source = await restoringSourceIdentity();
  assert.equal(source.sourceClean, true, "Checksum runs require clean committed source");
  const project = generateChecksumProject(seed, options);
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const identity = {
    version: CHECKSUM_RUN_VERSION,
    project: CHECKSUM_PROJECT_VERSION,
    seed,
    counts: project.counts,
    source,
    harness: config.harness ?? "baseline-agent",
    model: config.model,
    thinking: config.thinking ?? null,
    agents,
    deadlineSeconds: CHECKSUM_DELIVERY_DEADLINE_MS / 1000,
  };
  await writeFile(path.join(output, "start-main.cpp"), project.start);
  await writeFile(path.join(output, "expected-main.cpp"), project.expected);

  const pools = new Map();
  const rows = new Map();
  const started = Date.now();
  const { results } = await runAgentQueue(project.tasks, {
    lifecycle: "per-delivery",
    maxAgents: agents,
    signal,
    async createDriver(task, session, context) {
      const directory = path.join(output, "tasks", task.id);
      const workspace = path.join(directory, "workspace");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await writeFile(path.join(workspace, "main.cpp"), project.start);
      const drivers = chunkModelDrivers(directory, workspace, config, "");
      pools.set(task.id, { drivers, workspace, directory });
      return drivers.createDriver(null, session, context);
    },
    async execute(driver, task, { signal: abort, session }) {
      const { drivers } = pools.get(task.id);
      const row = { id: task.id, kind: task.kind, session, started: new Date().toISOString() };
      rows.set(task.id, row);
      const outcome = await drivers.execute(driver, task.prompt, {
        signal: abort,
        session,
        timeoutMs: CHECKSUM_DELIVERY_DEADLINE_MS,
      });
      row.status = outcome.status;
      row.ended = new Date().toISOString();
      return outcome;
    },
    async onClosed(driver, task) {
      rows.get(task.id).usage = pools.get(task.id).drivers.usage(driver);
    },
  });
  for (const { drivers } of pools.values()) await drivers.cleanup();
  const minutes = (Date.now() - started) / 60000;

  const tasks = [];
  for (const [index, task] of project.tasks.entries()) {
    const { workspace, directory } = pools.get(task.id);
    const main = await readFile(path.join(workspace, "main.cpp"), "utf8").catch(() => null);
    const files = (await readdir(workspace)).sort();
    const run =
      main === null ? null : await buildAndRun(path.join(directory, "build"), main, signal);
    tasks.push({
      ...rows.get(task.id),
      status: results[index]?.status ?? rows.get(task.id)?.status ?? "not-run",
      exact: main === task.result,
      built: run?.built ?? false,
      answer: run?.output ?? null,
      expectedAnswer: task.answer,
      extraFiles: files.filter((file) => file !== "main.cpp"),
    });
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  for (const row of tasks)
    for (const key of Object.keys(usage)) usage[key] += row.usage?.[key] ?? 0;
  const passed = tasks.filter((row) => row.exact && row.extraFiles.length === 0).length;
  const summary = {
    version: CHECKSUM_RUN_VERSION,
    identity,
    minutes: Number(minutes.toFixed(2)),
    passed,
    total: tasks.length,
    byKind: Object.fromEntries(
      ["move", "rename", "expression"].map((kind) => {
        const own = tasks.filter((row) => row.kind === kind);
        return [kind, { passed: own.filter((row) => row.exact).length, total: own.length }];
      }),
    ),
    usage,
    tasks,
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}
