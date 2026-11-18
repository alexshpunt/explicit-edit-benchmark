import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hostMemorySummary,
  readHostMemory,
} from "../../src/suites/explicit-edit-multi-agent/extraction/mixed-host-memory.mjs";

test("host memory uses the worst sample and kernel OOM delta", () => {
  const sample = (available, swapFree, oom) =>
    readHostMemory(
      `MemAvailable: ${available} kB\nSwapTotal: 8192 kB\nSwapFree: ${swapFree} kB\n`,
      `oom_kill ${oom}\n`,
    );
  assert.deepEqual(
    hostMemorySummary([sample(8192, 7168, 10), sample(4096, 5120, 11), sample(6144, 8192, 12)]),
    { minAvailableMiB: 4, swapGrowthMiB: 2, oomKills: 2 },
  );
  assert.deepEqual(hostMemorySummary([sample(8192, 7168, 10), readHostMemory("", "")]), {
    minAvailableMiB: 8,
    swapGrowthMiB: 0,
    oomKills: null,
  });
  assert.deepEqual(hostMemorySummary([sample(8192, 7168, 10), sample(8192, 7168, 9)]), {
    minAvailableMiB: 8,
    swapGrowthMiB: 0,
    oomKills: null,
  });
});

const script = "scripts/module-extraction.mjs";
const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
const tool = (toolName, message) => ({
  type: "tool_execution_end",
  toolName,
  isError: !!message,
  result: { content: [{ type: "text", text: message }] },
});
const assistant = (type, usage) => ({ type, message: { role: "assistant", usage } });

test("re-score joins mixed deliveries to native Pi events and compares without changing saved runs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixed-telemetry-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "mixed"));
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify({
      deliveries: [
        { phase: "mixed", id: "a", session: 1, status: "settled" },
        { phase: "mixed", id: "b", session: 2, status: "timed-out" },
        { phase: "mixed", id: "c", session: 3, status: "error" },
      ],
    }),
  );
  const usage = { totalTokens: 100, input: 10, cacheRead: 85, output: 5 };
  await writeFile(
    path.join(root, "mixed/session-1-events.jsonl"),
    [
      assistant("message_update", usage),
      assistant("message_end", { totalTokens: 0 }),
      assistant("message_end", usage),
      {
        type: "tool_execution_start",
        toolName: "read",
        args: { path: ["docs:alpha", "main.cpp", "docs:beta"] },
      },
      tool("read"),
      tool("move", 'move blocked: start anchor "SEARCH#12" is stale.'),
      tool("codemode", "Script failed: Script error: Result target is stale"),
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  // The timeout still contributes observed activity; a torn terminal JSONL record does not.
  await writeFile(
    path.join(root, "mixed/session-2-events.jsonl"),
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "docs:alpha" },
    }) + '\n{"type":',
  );
  const original = JSON.stringify({
    identity: { agents: 10 },
    deliveries: 3,
    timedOut: 1,
    minutes: 1.4,
    checks: { all: { passed: 244, total: 246 } },
    peakMemory: { megabytes: 610, processes: 7 },
  });
  const summaryPath = path.join(root, "summary.json");
  await writeFile(summaryPath, original);
  const memory = path.join(root, "mem.tsv");
  await writeFile(
    memory,
    "time\tavailable_mb\tswap_used_mb\n00:00:00\t6000\t20\n00:00:02\t4000\t55\n00:00:04\t5000\t30\n",
  );
  const result = JSON.parse(run("mixed-rescore", root, "--memory-log", memory));
  assert.deepEqual(result.checks, JSON.parse(original).checks);
  assert.deepEqual(result.peakMemory, JSON.parse(original).peakMemory);
  assert.deepEqual(result.hostMemory, { minAvailableMiB: 4000, swapGrowthMiB: 35, oomKills: null });
  assert.equal(result.behavior.deliveriesWithEvents, 2);
  assert.deepEqual(result.behavior.totals, {
    turns: 1,
    toolCalls: 3,
    toolErrors: 2,
    guideReads: 2,
    input: 10,
    cacheRead: 85,
    output: 5,
    callsByTool: { codemode: 1, move: 1, read: 1 },
    errorsByToolAndKind: { codemode: { "script-error": 1 }, move: { "stale-selection": 1 } },
    readsByGuide: { "docs:alpha": 2, "docs:beta": 1 },
  });
  assert.equal(result.behavior.perDelivery.toolCalls, 1.5);
  assert.equal(result.behavior.perDelivery.errorsByToolAndKind.move["stale-selection"], 0.5);
  assert.equal(result.behavior.deliveries[2].activity, null);
  assert.equal(await readFile(summaryPath, "utf8"), original);
  const rescored = path.join(root, "rescored.json");
  await writeFile(rescored, JSON.stringify(result));
  const table = run("mixed-compare", root, rescored);
  assert.match(table, /Checks passed\s+244\/246\s+244\/246/);
  assert.match(table, /Min available host memory \(MiB\)\s+unknown\s+4000/);
  assert.match(table, /OOM kills \(host\)\s+unknown\s+unknown/);
  assert.match(table, /Tool errors\/delivery: move \/ stale-selection\s+0.5\s+0.5/);
});
