import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  exportMultiAgentResult,
  multiAgentResult,
  validateMultiAgentResult,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function report(status = "blocked") {
  const schedule = [1, 2].map((number) => ({
    id: `round-00${number}`,
    assignments: [{ agent: number - 1, task: `task-00${number}` }],
  }));
  const checks = [{ label: "initial", contractId: "initial", status: "pass" }];
  const executions = [];
  for (const [index, round] of schedule.entries()) {
    const attempts = index === 1 && status === "blocked" ? 4 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      checks.push({
        label: `${round.id}-attempt-${attempt}`,
        contractId: round.id,
        status: index === 1 && status === "blocked" ? "fail" : "pass",
        category: index === 1 && status === "blocked" ? "structure" : undefined,
      });
      executions.push({
        round: round.id,
        attempt,
        agent: index,
        tasks: [round.assignments[0].task],
        status: "settled",
        startedMs: 0,
        elapsedMs: 10,
      });
    }
  }
  return {
    version: "renderer-concurrent-run-v1",
    benchmark: "explicit-edit-multi-agent",
    protocol: "shared-project-rotating-v1",
    runtime: { agent: "pi", version: "1.0.1", platform: "linux", architecture: "x64" },
    mode: "live",
    status,
    agents: 2,
    graphWidth: 2,
    workloadSha256: hash("workload"),
    graphSha256: hash("graph"),
    scheduleSha256: hash(JSON.stringify(schedule)),
    initial: hash("initial"),
    final: hash("final"),
    contractHashes: Object.fromEntries(
      ["initial", ...schedule.map((item) => item.id)].map((id) => [id, hash(id)]),
    ),
    schedule,
    totalRounds: 2,
    totalTasks: 2,
    acceptedRounds: status === "pass" ? 2 : 1,
    acceptedTasks: status === "pass" ? 2 : 1,
    deliveries: executions.length,
    repairs: executions.filter((item) => item.attempt > 1).length,
    checks,
    executions,
    elapsedMs: 1234,
    model: "example/model",
    thinking: "high",
    harness: "baseline-agent",
    policy: {
      trialTimeoutMs: null,
      attemptTimeoutMs: null,
      oracleRecoveries: 3,
      feedbackMode: "coarse",
      workspace: "shared-live",
      checkpoint: "ready-task-barrier",
      commitOrder: "observed-not-prescribed",
      assignment: "rotating-stable-ready-order",
    },
    terminal:
      status === "blocked"
        ? {
            id: "round-002",
            category: "blocked",
            failure: { category: "structure", message: "private command output" },
          }
        : null,
    agentsClosed: [true, true],
    usage: null,
  };
}

await test("jointly accepted progress stays distinct from a failed barrier and from unknown usage", () => {
  for (const status of ["pass", "blocked"]) {
    const raw = report(status);
    const result = multiAgentResult(raw);
    validateMultiAgentResult(result);
    assert.equal(result.progress.acceptedTasks, raw.acceptedTasks);
    assert.equal(result.progress.completion, raw.acceptedTasks / raw.totalTasks);
    assert.equal(result.progress.acceptedRounds, raw.acceptedRounds);
    assert.equal(result.execution.repairs, raw.repairs);
    assert.equal(result.usage, null);
    assert.equal(result.status, status);
  }
  const partial = report();
  partial.checks.at(-1).obligations = { passed: 99, total: 100 };
  assert.equal(multiAgentResult(partial).progress.acceptedTasks, 1);
});

await test("safe projection drops private source, prompts, receipts and terminal prose instead of copying raw reports", async () => {
  const raw = report();
  raw.workspace = "/private/machine/workspace";
  raw.authFile = "/private/machine/auth.json";
  raw.prompt = "PRIVATE_SECRET";
  raw.terminal.message = "PRIVATE_SECRET /private/machine";
  raw.executions[0].receipt = { command: "PRIVATE_SECRET", stdout: "PRIVATE_SECRET" };
  raw.policy.token = "PRIVATE_SECRET";
  raw.usage = {
    input: null,
    output: 20,
    cacheRead: 30,
    cacheWrite: null,
    totalTokens: null,
    cost: null,
    secret: "PRIVATE_SECRET",
  };
  const safe = multiAgentResult(raw);
  assert.equal(safe.usage.input, null);
  assert.equal(safe.usage.output, 20);
  assert.ok(!JSON.stringify(safe).includes("PRIVATE_SECRET"));
  assert.ok(!JSON.stringify(safe).includes("/private/"));
  const unsafe = { ...safe, authFile: "PRIVATE_SECRET" };
  assert.throws(() => validateMultiAgentResult(unsafe));
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/multi-agent-export-"));
  try {
    await writeFile(path.join(root, "report.json"), JSON.stringify(raw));
    const output = path.join(root, "result.json");
    await exportMultiAgentResult(root, output);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), safe);
    await assert.rejects(exportMultiAgentResult(root, output));
    assert.equal(await readFile(path.join(root, "report.json"), "utf8"), JSON.stringify(raw));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("credential-shaped model selectors are refused before any public result is written", async () => {
  const selectors = [
    "provider/sk_live_example-secret",
    "provider/sk-example-secret",
    "provider/ghp_exampleSecret",
    "provider/github_pat_exampleSecret",
    "provider/xoxb-example-secret",
  ];
  for (const model of selectors) {
    const raw = report();
    raw.model = model;
    assert.throws(() => multiAgentResult(raw), /Credential-shaped model identifier/);
    const safe = multiAgentResult(report());
    safe.configuration.model = model;
    assert.throws(() => validateMultiAgentResult(safe), /Credential-shaped model identifier/);
  }
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/multi-agent-private-model-"));
  try {
    const raw = report();
    raw.model = selectors[0];
    const original = JSON.stringify(raw);
    await writeFile(path.join(root, "report.json"), original);
    const output = path.join(root, "result.json");
    await assert.rejects(
      exportMultiAgentResult(root, output),
      /Credential-shaped model identifier/,
    );
    await assert.rejects(readFile(output), { code: "ENOENT" });
    assert.equal(await readFile(path.join(root, "report.json"), "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("mismatched schedules, fabricated progress and incomplete correction exhaustion are rejected", () => {
  for (const change of [
    (raw) => {
      raw.scheduleSha256 = hash("different");
    },
    (raw) => {
      raw.acceptedTasks = 2;
    },
    (raw) => {
      raw.acceptedRounds = 2;
    },
    (raw) => {
      raw.status = "pass";
      raw.terminal = null;
    },
    (raw) => {
      raw.deliveries++;
    },
    (raw) => {
      raw.repairs--;
    },
    (raw) => {
      raw.schedule[1].assignments[0].task = "task-001";
      raw.scheduleSha256 = hash(JSON.stringify(raw.schedule));
    },
    (raw) => {
      raw.schedule[0].assignments[0].agent = 2;
      raw.scheduleSha256 = hash(JSON.stringify(raw.schedule));
    },
    (raw) => {
      raw.checks.pop();
    },
    (raw) => {
      raw.policy.oracleRecoveries = 4;
    },
    (raw) => {
      raw.benchmark = "another-benchmark";
    },
    (raw) => {
      delete raw.protocol;
    },
    (raw) => {
      raw.model = "/private/auth.json";
    },
  ]) {
    const raw = report();
    change(raw);
    assert.throws(() => multiAgentResult(raw));
  }
});

await test("provider, driver and cancellation stops keep their accepted prefix without becoming editing blocks", () => {
  for (const status of ["provider_failure", "driver_exit", "infrastructure", "cancelled"]) {
    const raw = report();
    raw.status = status;
    raw.checks = raw.checks.slice(0, 2);
    raw.executions = raw.executions.slice(0, 2);
    raw.executions[1].status = "error";
    raw.deliveries = 2;
    raw.repairs = 0;
    raw.terminal = { category: status, message: "private upstream error" };
    const safe = multiAgentResult(raw);
    assert.equal(safe.status, status);
    assert.equal(safe.progress.acceptedTasks, 1);
    assert.equal(safe.terminal.category, status);
    assert.ok(!JSON.stringify(safe).includes("private upstream"));
  }
  assert.throws(() => multiAgentResult({ ...report(), status: "running" }));
});
