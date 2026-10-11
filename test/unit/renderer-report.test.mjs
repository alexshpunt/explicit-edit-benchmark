import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  createEvidence,
  rebuildReport,
  summarizeChain,
} from "../../scripts/multi-agent/experiments/chain-report.mjs";
import {
  runRequestChain,
  ExecutionFailure,
} from "../../src/suites/explicit-edit-multi-agent/execution/request-chain.mjs";
import { GradeFailure } from "../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import {
  readTree,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

async function temporary(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/renderer-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function history() {
  const attempts = ["pass", "fail", "pass", "fail", "fail", "fail"].map((status, i) => ({
    id: `step-${i < 1 ? 1 : i < 3 ? 2 : 3}`,
    index: i < 1 ? 0 : i < 3 ? 1 : 2,
    attempt: i < 1 ? 1 : i < 3 ? i : i - 2,
    status,
    prompt: "secret-token /home/private/account",
    grade:
      status === "fail"
        ? { category: "build", message: "Bearer private-secret" }
        : { status: "pass" },
    execution: {
      agentMs: 10,
      toolCalls: 1,
      failedToolCalls: 0,
      usage: { input: 2, output: 1, totalTokens: 3 },
      sessionId: "private-account",
      lifetime: "same",
    },
    graderMs: 20,
  }));
  return {
    version: "renderer-request-chain-v1",
    status: "blocked",
    passedPrefix: 2,
    steps: ["pass", "pass", "blocked", "unattempted"].map((status, i) => ({
      id: `step-${i + 1}`,
      status,
    })),
    attempts,
    usage: { input: 12, output: 6, totalTokens: 18 },
    terminal: {
      id: "step-3",
      category: "blocked",
      failure: { category: "build", message: "private-secret" },
    },
    arbitrary: "password /mnt/c/Users/Private",
  };
}

test("offline summaries keep initial failures, repairs, blocks and unknown metrics without leaking raw evidence", () => {
  const report = history();
  const summary = summarizeChain(report);
  assert.equal(summary.status, "blocked");
  assert.equal(summary.passedPrefix, 2);
  assert.deepEqual(summary.counts, {
    initialPass: 1,
    repairedPass: 1,
    failedAttempts: 4,
    attempts: 6,
    unattempted: 1,
  });
  assert.deepEqual(summary.firstFailure, { step: 2, attempt: 1, category: "build" });
  assert.deepEqual(summary.terminal, { step: 3, category: "blocked", failure: "build" });
  assert.equal(summary.usage.totalTokens.total, 18);
  assert.equal(summary.usage.cost.total, null);
  assert.equal(summary.timing.agentMs.total, 60);
  assert.equal(summary.timing.graderMs.total, 120);
  assert.equal(summary.continuity, "stable");
  assert.doesNotMatch(JSON.stringify(summary), /private|secret|password|Bearer|\/home\/|\/mnt\//i);
  report.attempts[1].execution.usage = { input: 2 };
  report.usage.output = null;
  report.usage.totalTokens = null;
  assert.equal(summarizeChain(report).usage.totalTokens.total, null);
  assert.equal(summarizeChain(report).usage.totalTokens.observed, 15);
  assert.equal(summarizeChain(report).usage.totalTokens.known, 5);
  const pending = structuredClone(history());
  pending.attempts = pending.attempts.slice(0, 2);
  pending.attempts[1] = { ...pending.attempts[1], status: "running", execution: undefined };
  pending.status = "running";
  pending.passedPrefix = 1;
  pending.usage = { input: 2, output: 1, totalTokens: 3 };
  const interrupted = summarizeChain(pending, { offline: true });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.usage.totalTokens.total, null);
  assert.equal(interrupted.usage.totalTokens.observed, 3);
  report.attempts.at(-1).execution.lifetime = "changed";
  assert.equal(summarizeChain(report).continuity, "changed");
  assert.throws(() => summarizeChain({ ...report, passedPrefix: 4 }), /prefix/i);
});

test("a durable history rebuilds without cached reports, retains failed source edits and does not sum repeated cumulative saves", async (t) => {
  const root = await temporary(t);
  const evidence = await createEvidence(root);
  let source = "int value = 0;\n";
  const report = await runRequestChain(
    ["first", "repair", "blocked", "future"].map((prompt, i) => ({ id: `step-${i + 1}`, prompt })),
    {
      save: evidence.save,
      identity: () => evidence.checkpoint({ "main.cpp": source }),
      execute: async () => {
        source += "int next;\n";
        return { usage: { input: 2, output: 1, totalTokens: 3 }, toolCalls: 1 };
      },
      grade: async ({ index, attempt }) => {
        if ((index === 1 && attempt === 1) || index === 2)
          throw new GradeFailure("build", "broken source");
        return { status: "pass" };
      },
    },
  );
  await evidence.save(report);
  const expected = JSON.parse(await readFile(path.join(root, "summary.json"), "utf8"));
  await rm(path.join(root, "report.json"));
  await rm(path.join(root, "summary.json"));
  const rebuilt = await rebuildReport(root);
  assert.deepEqual(rebuilt.summary, expected);
  assert.equal(rebuilt.summary.usage.totalTokens.total, 18);
  const rewritten = structuredClone(report);
  rewritten.attempts[1].grade.message = "failure silently erased";
  await assert.rejects(evidence.save(rewritten), /history|finished attempt/i);
  for (const attempt of report.attempts) {
    for (const hash of [attempt.before, attempt.after]) {
      const tree = await readTree(path.join(root, "sources", hash));
      assert.equal(treeIdentity(tree), hash);
    }
  }
  assert.equal(
    source,
    (await readTree(path.join(root, "sources", report.attempts.at(-1).after)))["main.cpp"],
  );
  const timeline = await readFile(path.join(root, "timeline.md"), "utf8");
  assert.match(timeline, /Attempt 2: fail/);
  assert.match(timeline, /broken source/);
  assert.match(timeline, /sources\/[a-f0-9]{64}/);
  execFileSync(process.execPath, ["scripts/multi-agent/experiments/chain-report.mjs", root], {
    cwd: process.cwd(),
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "summary.json"), "utf8")), expected);
});

test("interrupted evidence recovers the last complete record, rejects corrupt committed lines and never calls interruption a block", async (t) => {
  const root = await temporary(t);
  const evidence = await createEvidence(root);
  const running = {
    version: "renderer-request-chain-v1",
    status: "running",
    passedPrefix: 0,
    steps: [
      { id: "step-1", status: "running" },
      { id: "step-2", status: "unattempted" },
    ],
    attempts: [{ id: "step-1", index: 0, attempt: 1, status: "running", prompt: "private-secret" }],
    usage: null,
  };
  await evidence.save(running);
  await appendFile(path.join(root, "attempt-history.jsonl"), '{"version":');
  const rebuilt = await rebuildReport(root);
  assert.equal(rebuilt.summary.status, "interrupted");
  assert.equal(rebuilt.summary.passedPrefix, 0);
  assert.equal(rebuilt.summary.counts.unattempted, 1);
  assert.equal(rebuilt.summary.terminal.category, "interrupted");
  assert.equal(rebuilt.summary.persistence.truncatedTail, true);
  assert.equal(rebuilt.summary.usage.totalTokens.total, null);
  await appendFile(path.join(root, "attempt-history.jsonl"), "\n");
  await assert.rejects(rebuildReport(root), /history/i);
});

test("completed and runtime-stopped chains rebuild honestly and reject reordered or contradictory attempts", async (t) => {
  const root = await temporary(t);
  for (const status of ["pass", "provider_failure", "cancelled", "infrastructure", "timeout"]) {
    const directory = path.join(root, status);
    await mkdir(directory);
    const evidence = await createEvidence(directory);
    const controller = new AbortController();
    const report = await runRequestChain(
      [
        { id: "step-1", prompt: "edit" },
        { id: "step-2", prompt: "next" },
      ],
      {
        save: evidence.save,
        identity: () => "a".repeat(64),
        signal: controller.signal,
        attemptTimeoutMs: status === "timeout" ? 10 : 1000,
        execute: async ({ signal }) => {
          if (status === "provider_failure") throw new ExecutionFailure(status, "private error");
          if (status === "cancelled") controller.abort();
          if (["cancelled", "timeout"].includes(status))
            await new Promise((resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        },
        grade: async () => {
          if (status === "infrastructure") throw new GradeFailure(status, "unavailable");
          return { status: "pass" };
        },
      },
    );
    assert.equal((await rebuildReport(directory)).summary.status, status);
    assert.equal(report.status, status);
  }
  const broken = history();
  broken.attempts[1].attempt = 2;
  assert.throws(() => summarizeChain(broken), /attempt/i);
  broken.attempts[1].attempt = 1;
  broken.attempts[3].index = 3;
  assert.throws(() => summarizeChain(broken), /attempt/i);
  const empty = path.join(root, "empty");
  await mkdir(empty);
  await writeFile(path.join(empty, "attempt-history.jsonl"), "");
  await assert.rejects(rebuildReport(empty), /history/i);
});
