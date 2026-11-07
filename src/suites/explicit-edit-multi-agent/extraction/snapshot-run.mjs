import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chunkModelDrivers } from "../execution/chunk-model-drivers.mjs";
import { runAgentQueue } from "../execution/fresh-agent-queue.mjs";
import { restoringSourceIdentity } from "../execution/restoring-identity.mjs";
import { ASSEMBLY_AGENTS, measureMain, sampleTreeMemory } from "./assembly-run.mjs";
import { cleanupAssemblyMarkers } from "./assembly-case.mjs";
import { loadGeneralPrompt } from "./chunk-run.mjs";
import { HARD_POOL_VERSION, prepareHardPool } from "./hard-pool.mjs";
import { MIXED_PROBE_VERSION, isolatedPrompt, prepareMixedProbe } from "./mixed-probe.mjs";

export const SNAPSHOT_RUN_VERSION = "renderer-snapshot-run-v2";
/** Ten minutes per task: a timeout should mean a stuck agent, not a careful one. */
export const SNAPSHOT_DELIVERY_DEADLINE_MS = 600_000;
export const SNAPSHOT_POOLS = Object.freeze({
  mixed: prepareMixedProbe,
  hard: prepareHardPool,
});
const ORDERS = 6;

const hash = (data) => createHash("sha256").update(data).digest("hex");
/** Blank lines and spaces at the end of a line are not compared. */
const normal = (text) =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
export const sameText = (left, right) => normal(left) === normal(right);
const kindOf = (entry) => entry.kind ?? (entry.task === "move" ? "move" : entry.rename.kind);

/** A deterministic order of the queue for the proof: a seeded shuffle. */
function shuffled(items, seed) {
  const order = [...items];
  let state = seed;
  for (let index = order.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other], order[index]];
  }
  return order;
}

async function snapshotIdentity(pool, probe, general, harness, agents) {
  const source = await restoringSourceIdentity();
  assert.equal(source.sourceClean, true, "Snapshot runs require clean committed source");
  return {
    version: SNAPSHOT_RUN_VERSION,
    pool,
    probe: pool === "hard" ? HARD_POOL_VERSION : MIXED_PROBE_VERSION,
    source,
    planSha256: probe.setup.manifest.planSha256,
    counts: probe.counts,
    identities: probe.identities,
    generalSha256: hash(general),
    deadlineSeconds: SNAPSHOT_DELIVERY_DEADLINE_MS / 1000,
    lifecycle: "persistent",
    agents,
    harness,
  };
}

/** Run the queue with persistent agents, each in its own copy of main.cpp. Before
 * a task, the copy receives the reference snapshot of every task finished so far;
 * afterwards it must equal that snapshot plus the task. The shared state then takes
 * the task's reference result, whatever the agent did.
 */
export async function runSnapshotQueue({ probe, output, pool, agents, signal }) {
  const done = new Set();
  const rows = [],
    sessions = [];
  const {
    results,
    maxLive,
    agents: started,
  } = await runAgentQueue(probe.queue, {
    lifecycle: "persistent",
    maxAgents: agents,
    signal,
    createDriver: (_item, session, context) => pool.createDriver(session, context),
    async execute(driver, entry, context) {
      const base = new Set(done);
      const baseText = probe.snapshot(base);
      const expected = probe.snapshot(new Set([...base, entry.id]));
      const file = path.join(driver.workspace, "main.cpp");
      await writeFile(file, baseText);
      const row = {
        id: entry.id,
        kind: kindOf(entry),
        session: context.session,
        base: [...base].sort(),
        started: new Date().toISOString(),
      };
      rows.push(row);
      let outcome;
      try {
        outcome = await pool.execute(driver, isolatedPrompt(entry), {
          ...context,
          entry,
          expected,
        });
        row.status = outcome.status;
        const result = await readFile(file, "utf8");
        row.passed = outcome.status === "settled" && sameText(result, expected);
        // A failed result is kept: the copy is overwritten by the agent's next task.
        if (!row.passed) {
          await mkdir(path.join(output, "failed"), { recursive: true, mode: 0o700 });
          await writeFile(path.join(output, "failed", `${entry.id}.cpp`), result);
          await writeFile(path.join(output, "failed", `${entry.id}.expected.cpp`), expected);
        }
      } catch (error) {
        row.status = "error";
        row.passed = false;
        row.error = { name: error?.name, message: error?.message };
        throw error;
      } finally {
        row.ended = new Date().toISOString();
        // The reference result joins the shared state atomically, pass or fail.
        done.add(entry.id);
        await writeFile(path.join(output, "deliveries.json"), JSON.stringify(rows, null, 2) + "\n");
      }
      return outcome;
    },
    async onClosed(driver, _item, result, deliveries) {
      sessions.push({ session: result.session, deliveries, usage: pool.usage(driver) });
    },
  });
  await pool.cleanup();
  return { rows, sessions, maxLive, agents: started, results };
}

function tally(rows) {
  const kinds = {};
  for (const row of rows) {
    kinds[row.kind] ??= { passed: 0, total: 0 };
    kinds[row.kind].total++;
    if (row.passed) kinds[row.kind].passed++;
  }
  return {
    passed: rows.filter((row) => row.passed).length,
    total: rows.length,
    kinds,
    failed: rows.filter((row) => !row.passed).map((row) => row.id),
  };
}

/** Scripted participants: each writes exactly its task's expected file. */
function scriptedPool(output) {
  let active = 0,
    maxActive = 0;
  return {
    stats: () => ({ maxActive }),
    async createDriver(session) {
      const workspace = path.join(output, "agents", `session-${session}`, "workspace");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      return {
        workspace,
        closed: false,
        async terminate() {
          this.closed = true;
        },
      };
    },
    async execute(driver, prompt, { expected, index }) {
      assert.ok(prompt.length > 0);
      active++;
      maxActive = Math.max(active, maxActive);
      try {
        await sleep(index % 7 === 0 ? 5 : index % 3);
        await writeFile(path.join(driver.workspace, "main.cpp"), expected);
        return { status: "settled" };
      } finally {
        active--;
      }
    },
    usage: () => null,
    async cleanup() {},
  };
}

/** Model participants: one native Pi process per persistent agent and copy. */
function modelPool(output, config, general) {
  const pools = new Map();
  return {
    async createDriver(session, { signal }) {
      const root = path.join(output, "agents", `session-${session}`);
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const pool = chunkModelDrivers(root, workspace, config, general);
      const driver = await pool.createDriver(null, session, { signal });
      pools.set(driver, pool);
      driver.workspace = workspace;
      return driver;
    },
    execute: (driver, prompt, { signal, session }) =>
      pools.get(driver).execute(driver, prompt, {
        signal,
        session,
        timeoutMs: SNAPSHOT_DELIVERY_DEADLINE_MS,
      }),
    usage: (driver) => pools.get(driver)?.usage(driver) ?? null,
    async cleanup() {
      for (const pool of new Set(pools.values())) await pool.cleanup();
    },
  };
}

/** Model-free proof. In several finishing orders, every task changes its base only
 * where it should: a move takes its unit from one place to its placeholder, a
 * rename changes only lines with the old name. The final snapshot equals the
 * reference, which builds and renders the expected images, and scripted persistent
 * participants in their own copies pass every task.
 */
export async function verifySnapshotRun(
  casePath,
  outputPath,
  { pool: kind = "mixed", agents = ASSEMBLY_AGENTS, signal } = {},
) {
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  assert.ok(Object.hasOwn(SNAPSHOT_POOLS, kind), `Unknown task pool ${kind}`);
  const probe = await SNAPSHOT_POOLS[kind](casePath);
  const general = await loadGeneralPrompt();
  const identity = await snapshotIdentity(kind, probe, general, null, agents);
  const problems = [];
  for (let seed = 0; seed < ORDERS; seed++) {
    const order = seed === 0 ? probe.queue : shuffled(probe.queue, seed);
    const done = new Set();
    let base = probe.snapshot(done);
    for (const entry of order) {
      done.add(entry.id);
      const next = probe.snapshot(done);
      const before = base.split("\n"),
        after = next.split("\n");
      if (entry.task === "hard") {
        // A rename changes only lines that mention its symbol; a swap only reorders
        // text, possibly across the lines of a long call. The line count stays.
        const changed = before.filter((line, at) => line !== after[at]);
        const words = (lines) =>
          lines
            .join("\n")
            .split(/[^A-Za-z_0-9]+/)
            .filter(Boolean)
            .sort()
            .join(" ");
        const ok =
          before.length === after.length &&
          changed.length > 0 &&
          (entry.kind === "swap"
            ? words(changed) === words(after.filter((line, at) => line !== before[at]))
            : changed.every((line) => new RegExp(`\\b${entry.name}\\b`).test(line)));
        if (!ok) problems.push(`order ${seed}: ${entry.id}`);
      } else if (entry.task === "move") {
        const items = entry.items;
        const ok =
          items.every((item) => base.includes(item.marker) && !next.includes(item.marker)) &&
          next.length - base.length === -items.reduce((sum, item) => sum + item.marker.length, 0);
        if (!ok) problems.push(`order ${seed}: move ${entry.id}`);
      } else {
        const { name, newName } = entry.rename;
        const changed = before.filter((line, at) => line !== after[at]);
        const ok =
          before.length === after.length &&
          changed.length > 0 &&
          before.every(
            (line, at) =>
              line === after[at] ||
              (new RegExp(`\\b${name}\\b`).test(line) &&
                new RegExp(`\\b${newName}\\b`).test(after[at])),
          );
        if (!ok) problems.push(`order ${seed}: rename ${entry.id}`);
      }
      base = next;
    }
    const final = cleanupAssemblyMarkers({ "main.cpp": base }, probe.setup.markers).tree;
    if (final["main.cpp"] !== probe.expected["main.cpp"]) problems.push(`order ${seed}: final`);
  }
  const build = await measureMain(
    path.join(output, "reference"),
    probe.expected["main.cpp"],
    probe.setup.manifest.pixels,
    signal,
  );
  const pool = scriptedPool(output);
  const run = await runSnapshotQueue({ probe, output, pool, agents, signal });
  const checks = tally(run.rows);
  const summary = {
    version: SNAPSHOT_RUN_VERSION,
    identity,
    status:
      !problems.length &&
      build.buildPassed &&
      build.resultMatched &&
      checks.passed === checks.total &&
      checks.total === probe.queue.length &&
      pool.stats().maxActive === Math.min(agents, probe.queue.length)
        ? "pass"
        : "fail",
    orders: ORDERS,
    problems,
    tasks: checks,
    agents: run.agents,
    maxActive: pool.stats().maxActive,
    buildPassed: build.buildPassed,
    resultMatched: build.resultMatched,
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}

/** One observation with models. There is no recovery: each task gets one delivery. */
export async function runSnapshotModel(
  casePath,
  outputPath,
  config,
  { proofPath, pool: kind = "mixed", agents = ASSEMBLY_AGENTS, signal } = {},
) {
  assert.ok(Number.isInteger(agents) && agents >= 1 && agents <= ASSEMBLY_AGENTS);
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  assert.ok(Object.hasOwn(SNAPSHOT_POOLS, kind), `Unknown task pool ${kind}`);
  const probe = await SNAPSHOT_POOLS[kind](casePath);
  const general = await loadGeneralPrompt();
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  assert.equal(proof.status, "pass", "The reference proof did not pass");
  assert.deepEqual(
    proof.identity,
    await snapshotIdentity(kind, probe, general, null, agents),
    "The reference proof belongs to other source, tasks or agent count",
  );
  const identity = await snapshotIdentity(
    kind,
    probe,
    general,
    config.harness ?? "baseline-agent",
    agents,
  );
  const started = Date.now();
  const memory = sampleTreeMemory();
  const run = await runSnapshotQueue({
    probe,
    output,
    pool: modelPool(output, config, general),
    agents,
    signal,
  });
  // A provider that reports no usage leaves it unknown, not zero.
  const reported = run.sessions.filter(({ usage: session }) => session);
  const usage = reported.length ? { input: 0, output: 0, cacheRead: 0, cost: 0 } : null;
  for (const { usage: session } of reported)
    for (const key of Object.keys(usage)) usage[key] += session[key] ?? 0;
  if (usage) usage.sessions = `${reported.length}/${run.sessions.length}`;
  const summary = {
    version: SNAPSHOT_RUN_VERSION,
    identity,
    minutes: Number(((Date.now() - started) / 60000).toFixed(2)),
    agents: run.agents,
    maxLive: run.maxLive,
    timedOut: run.rows.filter((row) => row.status === "timed-out").length,
    tasks: tally(run.rows),
    usage,
    peakMemory: memory.stop(),
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}
