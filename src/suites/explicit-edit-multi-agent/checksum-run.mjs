import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chunkModelDrivers } from "./execution/chunk-model-drivers.mjs";
import { runAgentQueue } from "./execution/fresh-agent-queue.mjs";
import { restoringSourceIdentity } from "./execution/restoring-identity.mjs";
import { startSharedSandbox } from "./execution/shared-sandbox.mjs";
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
export const CHECKSUM_SHARED_VERSION = "multi-agent-checksum-shared-v1";
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
      [...new Set(tasks.map((row) => row.kind))].map((kind) => {
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

/** The fact a shared-file agent needs: other agents edit the same file meanwhile. */
const SHARED_NOTICE =
  "Several agents are editing main.cpp at the same time. The file can change between the moment you read it and the moment you write it, and the risk of conflicting edits is high, so be as careful as possible with your edits.";

/** The prompt of a task in the shared file: the notice after the frame's opening. */
export function sharedPrompt(task) {
  const [opening, ...rest] = task.prompt.split("\n\n");
  return [opening, SHARED_NOTICE, ...rest].join("\n\n");
}

/** The paragraphs of a main.cpp: prototypes, each definition or slot, and main. */
const blocks = (text) => text.replace(/\n$/, "").split("\n\n");

/** Grade a shared main.cpp against the project's reference. A block passes when it
 * stands in the candidate exactly once, as a whole paragraph. A rename passes when
 * no old spelling remains and the new one appears as often as in the reference;
 * an expression when only its new text remains; a move when its definition stands
 * once, its slot is gone and at least one neighbour paragraph matches the reference.
 */
export function gradeSharedChecksum(project, candidate) {
  const wanted = blocks(project.expected),
    got = blocks(candidate);
  const count = (text, part) => text.split(part).length - 1;
  // Whole identifiers only: a name with extra letters is another name.
  const identifiers = (text, name) => text.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
  const paragraphs = new Map();
  for (const block of got) paragraphs.set(block, (paragraphs.get(block) ?? 0) + 1);
  const damaged = wanted.filter((block) => paragraphs.get(block) !== 1);
  const edits = project.tasks.flatMap((task) => task.parts ?? [task]);
  const checks = new Map();
  for (const task of edits) {
    let passed;
    if (task.kind === "rename")
      passed =
        count(candidate, task.name) === 0 &&
        identifiers(candidate, task.newName) === identifiers(project.expected, task.newName) &&
        count(candidate, task.newName) === count(project.expected, task.newName);
    else if (task.kind === "expression")
      passed = count(candidate, task.before) === 0 && count(candidate, task.after) === 1;
    else {
      const header = `long long ${task.name}(long long value) {`;
      const at = got.findIndex((block) => block.startsWith(header));
      const reference = wanted.findIndex((block) => block.startsWith(header));
      passed =
        at >= 0 &&
        paragraphs.get(got[at]) === 1 &&
        got[at] === wanted[reference] &&
        count(candidate, task.marker) === 0 &&
        (got[at - 1] === wanted[reference - 1] || got[at + 1] === wanted[reference + 1]);
    }
    checks.set(task.id, { id: task.id, kind: task.kind, passed });
  }
  // A composite task passes only when every one of its edits does.
  const tasks = project.tasks.map((task) => ({
    id: task.id,
    kind: task.kind,
    passed: (task.parts ?? [task]).every(({ id }) => checks.get(id).passed),
    failedEdits: (task.parts ?? [task])
      .filter(({ id }) => !checks.get(id).passed)
      .map(({ id }) => id),
  }));
  return {
    exact: candidate === project.expected,
    tasks,
    edits: [...checks.values()],
    passed: tasks.filter(({ passed }) => passed).length,
    // Paragraphs of the reference that are lost, changed or duplicated in the candidate.
    damaged: damaged.map((block) => block.split("\n")[0]),
    extra: got.filter((block) => !wanted.includes(block)).map((block) => block.split("\n")[0]),
  };
}

/** Spend model credit on one shared-file run: all agents start and warm up, then
 * wait at a barrier; each wave gives every agent one task at the same moment, and
 * the next wave starts when every agent of this one has finished. Agents persist
 * across waves; a timed-out agent is replaced before the next wave.
 */
export async function runChecksumShared(
  seed,
  outputPath,
  config,
  { agents, options = {}, sandbox = "separate", notice = true, signal } = {},
) {
  assert.ok(["separate", "shared"].includes(sandbox), `Unknown sandbox mode ${sandbox}`);
  const source = await restoringSourceIdentity();
  assert.equal(source.sourceClean, true, "Checksum runs require clean committed source");
  const project = generateChecksumProject(seed, options);
  const team = agents ?? project.tasks.length;
  assert.ok(Number.isSafeInteger(team) && team >= 1 && team <= project.tasks.length);
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const identity = {
    version: CHECKSUM_SHARED_VERSION,
    project: CHECKSUM_PROJECT_VERSION,
    seed,
    counts: project.counts,
    source,
    harness: config.harness ?? "baseline-agent",
    model: config.model,
    thinking: config.thinking ?? null,
    agents: team,
    sandbox,
    // Whether prompts say that other agents edit the same file.
    notice,
    deadlineSeconds: CHECKSUM_DELIVERY_DEADLINE_MS / 1000,
  };
  const workspace = path.join(output, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(path.join(workspace, "main.cpp"), project.start);
  await writeFile(path.join(output, "start-main.cpp"), project.start);
  await writeFile(path.join(output, "expected-main.cpp"), project.expected);

  /** @type {Promise<any> | undefined} */
  let teamSandbox;
  const sharedSandbox =
    sandbox === "shared"
      ? () => (teamSandbox ??= startSharedSandbox(path.join(output, "sandbox")))
      : undefined;
  const drivers = chunkModelDrivers(path.join(output, "agents"), workspace, config, "", {
    sharedSandbox,
  });
  /** @type {{ driver: any, session: number }[]} */
  const slots = Array.from({ length: team }, () => ({ driver: null, session: 0 }));
  const usage = [];
  let sessions = 0;
  const retire = async (slot) => {
    if (!slot.driver) return;
    if (slot.driver.closed !== true)
      await (slot.driver.terminate ?? slot.driver.close).call(slot.driver);
    usage.push(drivers.usage(slot.driver));
    slot.driver = null;
  };
  const rows = [];
  const waves = [];
  const started = Date.now();
  try {
    for (let first = 0; first < project.tasks.length; first += team) {
      const wave = project.tasks.slice(first, first + team);
      // Warm-up: every agent of the wave is started before any task is given.
      const warm = Date.now();
      await Promise.all(
        slots.slice(0, wave.length).map(async (slot) => {
          if (slot.driver && slot.driver.closed !== true) return;
          await retire(slot);
          // Take the number before waiting: other slots start their agents meanwhile.
          const session = ++sessions;
          slot.driver = await drivers.createDriver(null, session, { signal });
          slot.session = session;
        }),
      );
      const barrier = Date.now();
      const results = await Promise.all(
        wave.map(async (task, index) => {
          const slot = slots[index];
          const row = {
            id: task.id,
            kind: task.kind,
            wave: waves.length + 1,
            session: slot.session,
          };
          rows.push(row);
          const begin = Date.now();
          try {
            const outcome = await drivers.execute(
              slot.driver,
              notice ? sharedPrompt(task) : task.prompt,
              {
                signal,
                session: slot.session,
                timeoutMs: CHECKSUM_DELIVERY_DEADLINE_MS,
              },
            );
            row.status = outcome.status;
          } catch (error) {
            row.status = "error";
            row.error = String(error?.message ?? error);
          }
          row.seconds = Number(((Date.now() - begin) / 1000).toFixed(1));
          return row;
        }),
      );
      waves.push({
        tasks: wave.length,
        warmUpSeconds: Number(((barrier - warm) / 1000).toFixed(1)),
        seconds: Number(((Date.now() - barrier) / 1000).toFixed(1)),
        timedOut: results.filter((row) => row.status === "timed-out").length,
      });
      await writeFile(
        path.join(output, `after-wave-${waves.length}.cpp`),
        await readFile(path.join(workspace, "main.cpp"), "utf8"),
      );
    }
  } finally {
    for (const slot of slots) await retire(slot);
    await drivers.cleanup();
    if (teamSandbox) await (await teamSandbox).stop();
  }
  const minutes = (Date.now() - started) / 60000;
  const main = await readFile(path.join(workspace, "main.cpp"), "utf8");
  const files = (await readdir(workspace)).sort();
  const grade = gradeSharedChecksum(project, main);
  const run = await buildAndRun(path.join(output, "build"), main, signal);
  const total = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  for (const entry of usage) for (const key of Object.keys(total)) total[key] += entry?.[key] ?? 0;
  const byId = new Map(grade.tasks.map((task) => [task.id, task]));
  const summary = {
    version: CHECKSUM_SHARED_VERSION,
    identity,
    minutes: Number(minutes.toFixed(2)),
    exact: grade.exact,
    passed: grade.passed,
    total: project.tasks.length,
    // Single edits by kind; a composite task counts each of its edits here.
    byKind: Object.fromEntries(
      ["move", "rename", "expression"].map((kind) => {
        const own = grade.edits.filter((edit) => edit.kind === kind);
        return [kind, { passed: own.filter((edit) => edit.passed).length, total: own.length }];
      }),
    ),
    damaged: grade.damaged,
    extra: grade.extra,
    built: run.built,
    answer: run.output,
    expectedAnswer: project.answers.expected,
    extraFiles: files.filter((file) => file !== "main.cpp"),
    waves,
    usage: total,
    tasks: rows.map((row) => ({
      ...row,
      passed: byId.get(row.id).passed,
      failedEdits: byId.get(row.id).failedEdits,
    })),
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}
