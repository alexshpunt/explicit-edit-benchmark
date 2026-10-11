import assert from "node:assert/strict";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  treeIdentity,
  writeTree,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const outcomes = new Set([
  "running",
  "preparing",
  "pass",
  "fail",
  "blocked",
  "cancelled",
  "timeout",
  "provider_failure",
  "driver_exit",
  "infrastructure",
  "interrupted",
  "unattempted",
]);
const categories = new Set(["build", "behavior", "structure", ...outcomes]);
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function metric(values) {
  const known = values.filter(number);
  const observed = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  return {
    total: values.length && known.length === values.length ? observed : null,
    observed,
    known: known.length,
    expected: values.length,
  };
}

/** Build an allowlisted summary. Raw prompts, errors, paths and account identifiers never enter it.
 * Cumulative session usage is a snapshot, not an increment to add on each save.
 */
export function summarizeChain(report, { offline = false, truncatedTail = false } = {}) {
  assert.ok(
    Array.isArray(report.steps) && Array.isArray(report.attempts),
    "Invalid chain evidence",
  );
  assert.ok(outcomes.has(report.status), "Invalid chain outcome");
  const recoveries = report.policy?.oracleRecoveries ?? 2;
  assert.ok(
    Number.isSafeInteger(recoveries) && recoveries >= 0 && recoveries <= 3,
    "Invalid oracle policy",
  );
  const maxAttempts = recoveries + 1;
  const groups = report.steps.map(() => []);
  let index = 0;
  for (const attempt of report.attempts) {
    assert.equal(attempt.index, index, "Invalid attempt order");
    const group = groups[index];
    assert.ok(group && attempt.id === report.steps[index].id, "Invalid attempt owner");
    assert.equal(attempt.attempt, group.length + 1, "Invalid attempt sequence");
    assert.ok(
      attempt.attempt <= maxAttempts && outcomes.has(attempt.status),
      "Invalid attempt outcome",
    );
    assert.ok(
      !group.length || group.at(-1).status === "fail",
      "Invalid attempt after terminal outcome",
    );
    group.push(attempt);
    if (attempt.status === "pass") index++;
  }
  assert.equal(report.passedPrefix, index, "Stored prefix contradicts attempt evidence");
  if (report.status === "pass")
    assert.equal(index, report.steps.length, "Incomplete passing chain");
  if (report.status === "blocked")
    assert.ok(
      groups[index]?.length === maxAttempts && groups[index].every((a) => a.status === "fail"),
      "Invalid terminal block",
    );
  const status =
    offline && ["preparing", "running"].includes(report.status) ? "interrupted" : report.status;
  const last = report.attempts.at(-1);
  const failure = report.attempts.find((a) => a.status === "fail");
  const safeCategory = (value) => (categories.has(value) ? value : "unknown");
  const executions = report.attempts.map((a) => a.execution);
  const identities = executions.map((e) =>
    e?.sessionId && e?.lifetime ? JSON.stringify([e.sessionId, e.lifetime, e.agentPid]) : null,
  );
  const continuity =
    new Set(identities.filter(Boolean)).size > 1
      ? "changed"
      : identities.length && identities.every(Boolean)
        ? "stable"
        : "unknown";
  const usage = Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].map((key) => {
      const value = metric(executions.map((e) => e?.usage?.[key]));
      if (report.usage && Object.hasOwn(report.usage, key))
        value.total =
          number(report.usage[key]) && !report.attempts.some((a) => a.status === "running")
            ? report.usage[key]
            : null;
      return [key, value];
    }),
  );
  return {
    version: "renderer-chain-summary-v1",
    workloadVersion:
      report.workloadVersion === "renderer-atomic-slice-v2" ? report.workloadVersion : null,
    initial: hash(report.initial) ? report.initial : null,
    status,
    passedPrefix: index,
    totalSteps: report.steps.length,
    counts: {
      initialPass: groups.filter((g) => g.length === 1 && g[0].status === "pass").length,
      repairedPass: groups.filter((g) => g.length > 1 && g.at(-1).status === "pass").length,
      failedAttempts: report.attempts.filter((a) => a.status === "fail").length,
      attempts: report.attempts.length,
      unattempted: groups.filter((g) => !g.length).length,
    },
    firstFailure: failure
      ? {
          step: failure.index + 1,
          attempt: failure.attempt,
          category: safeCategory(failure.grade?.category),
        }
      : null,
    terminal: ["pass", "running", "preparing"].includes(status)
      ? null
      : {
          step: last && last.status !== "pass" ? last.index + 1 : null,
          category: status,
          ...(status === "blocked" ? { failure: safeCategory(last?.grade?.category) } : {}),
        },
    steps: groups.map((g, i) => ({
      step: i + 1,
      attempts: g.length,
      status:
        g.at(-1)?.status === "pass"
          ? "pass"
          : !g.length
            ? "unattempted"
            : status === "running"
              ? "running"
              : status,
      repaired: g.length > 1 && g.at(-1).status === "pass",
    })),
    timing: {
      agentMs: metric(report.attempts.map((a) => a.execution?.agentMs ?? a.executeMs)),
      graderMs: metric(report.attempts.map((a) => a.graderMs)),
    },
    tools: {
      calls: metric(executions.map((e) => e?.toolCalls)),
      failed: metric(executions.map((e) => e?.failedToolCalls)),
    },
    usage,
    continuity,
    persistence: { truncatedTail },
  };
}

function display(value) {
  if (value.total !== null) return String(value.total);
  return value.observed === null
    ? "unknown"
    : `unknown (observed ${value.observed}; ${value.known}/${value.expected} attempts)`;
}

/** Render the safe summary as daily English, separately from the private timeline. */
export function renderSummary(summary) {
  const c = summary.counts;
  return [
    "# Renderer chain report",
    "",
    `Status: **${summary.status}**. Verified prefix: **${summary.passedPrefix}/${summary.totalSteps}**.`,
    "",
    `Initial passes: ${c.initialPass}. Repaired passes: ${c.repairedPass}. Failed attempts: ${c.failedAttempts}. Unattempted requests: ${c.unattempted}.`,
    summary.firstFailure
      ? `First failure: step ${summary.firstFailure.step}, attempt ${summary.firstFailure.attempt} [${summary.firstFailure.category}].`
      : "First failure: none recorded.",
    summary.terminal
      ? `Terminal stop: ${summary.terminal.category}${summary.terminal.step ? ` at step ${summary.terminal.step}` : ""}.`
      : "Terminal stop: none.",
    "",
    `Agent time (ms): ${display(summary.timing.agentMs)}. Grader time (ms): ${display(summary.timing.graderMs)}.`,
    `Tool calls: ${display(summary.tools.calls)}. Tool errors: ${display(summary.tools.failed)}.`,
    `Tokens: ${display(summary.usage.totalTokens)}. Configured cost estimate: ${display(summary.usage.cost)} (not a billing receipt).`,
    `Observed process/session continuity: ${summary.continuity}.`,
    ...(summary.persistence.truncatedTail
      ? ["The incomplete final history record was ignored; earlier complete evidence was retained."]
      : []),
    "",
    "| Step | Attempts | Outcome |",
    "| --- | ---: | --- |",
    ...summary.steps.map(
      (s) => `| ${s.step} | ${s.attempts} | ${s.status}${s.repaired ? " (repaired)" : ""} |`,
    ),
    "",
  ].join("\n");
}

function timeline(report, summary) {
  const lines = [
    renderSummary(summary),
    "## Private attempt timeline",
    "",
    "Contains prompts and verifier messages. Keep this file private.",
    "",
  ];
  if (report.terminal) {
    const terminal = JSON.stringify(report.terminal, null, 2);
    const fence = "`".repeat(
      Math.max(3, ...[...terminal.matchAll(/`+/g)].map((m) => m[0].length + 1)),
    );
    lines.push("### Terminal evidence", "", `${fence}json`, terminal, fence, "");
  }
  for (const [i, attempt] of report.attempts.entries()) {
    lines.push(
      `### Attempt ${i + 1}: ${attempt.status}`,
      "",
      `Step ${attempt.index + 1}, try ${attempt.attempt}/${(report.policy?.oracleRecoveries ?? 2) + 1}.`,
      "",
    );
    for (const [label, digest] of [
      ["Before", attempt.before],
      ["After", attempt.after],
    ]) {
      if (hash(digest)) lines.push(`[${label} source](sources/${digest}/)`, "");
    }
    const body = JSON.stringify(
      {
        request: attempt.prompt,
        verifier: attempt.grade,
        runtime: attempt.execution,
        before: attempt.before,
        after: attempt.after,
      },
      null,
      2,
    );
    const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    lines.push(`${fence}json`, body, fence, "");
  }
  return lines.join("\n");
}

function assertHistory(previous, current) {
  if (!previous) return;
  assert.ok(current.attempts.length >= previous.attempts.length, "History lost attempts");
  if (previous.steps.length)
    assert.deepEqual(
      current.steps.map((s) => s.id),
      previous.steps.map((s) => s.id),
      "History changed requests",
    );
  for (const [i, attempt] of previous.attempts.entries()) {
    if (attempt.status !== "running")
      assert.deepEqual(current.attempts[i], attempt, "History changed a finished attempt");
    else
      assert.deepEqual(
        [
          current.attempts[i].id,
          current.attempts[i].index,
          current.attempts[i].attempt,
          current.attempts[i].prompt,
          current.attempts[i].before,
        ],
        [attempt.id, attempt.index, attempt.attempt, attempt.prompt, attempt.before],
        "History changed a delivered attempt",
      );
  }
}
async function atomicFile(directory, name, content) {
  const target = path.join(directory, name);
  const temporary = `${target}.pending`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, target);
}

async function projections(directory, report, options) {
  const summary = summarizeChain(report, options);
  await atomicFile(directory, "summary.json", JSON.stringify(summary, null, 2) + "\n");
  await atomicFile(directory, "summary.md", renderSummary(summary));
  await atomicFile(directory, "timeline.md", timeline(report, summary));
  return summary;
}

/** Create private append-only evidence in a fresh run directory. Source checkpoints are
 * content-addressed copies for inspection only; they are never restored into the live workspace.
 * Save calls must be sequential, as in runRequestChain.
 */
export async function createEvidence(directory) {
  const journal = path.join(directory, "attempt-history.jsonl");
  const handle = await open(journal, "wx", 0o600);
  await handle.close();
  await mkdir(path.join(directory, "sources"), { mode: 0o700 });
  const captured = new Set();
  let sequence = 0;
  let previous;
  return {
    async checkpoint(tree) {
      const digest = treeIdentity(tree);
      if (!captured.has(digest)) {
        await writeTree(path.join(directory, "sources", digest), tree);
        captured.add(digest);
      }
      return digest;
    },
    async save(report) {
      const snapshot = JSON.parse(JSON.stringify(report));
      summarizeChain(snapshot);
      assertHistory(previous, snapshot);
      const record = {
        version: "renderer-attempt-history-v1",
        sequence: sequence++,
        report: snapshot,
      };
      // Flush the history before replacing disposable report views.
      const file = await open(journal, "a");
      try {
        await file.writeFile(JSON.stringify(record) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      previous = snapshot;
      await atomicFile(directory, "report.json", JSON.stringify(snapshot, null, 2) + "\n");
      await projections(directory, report);
    },
  };
}

/** Rebuild from complete history records only. Do not read cached reports, run a grader
 * or call a model. A torn final record is reported; corrupt complete records fail closed.
 */
export async function rebuildReport(directory) {
  const body = await readFile(path.join(directory, "attempt-history.jsonl"), "utf8");
  const lines = body.split("\n");
  const truncatedTail = lines.pop() !== "";
  let report;
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("Invalid complete history record");
    }
    assert.equal(record.version, "renderer-attempt-history-v1", "Unsupported history version");
    assert.equal(record.sequence, index, "Invalid history sequence");
    summarizeChain(record.report);
    assertHistory(report, record.report);
    report = record.report;
  }
  assert.ok(report, "No complete history records");
  await atomicFile(directory, "report.json", JSON.stringify(report, null, 2) + "\n");
  const summary = await projections(directory, report, { offline: true, truncatedTail });
  return { report, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1)
      throw new Error("Usage: node scripts/multi-agent/experiments/chain-report.mjs RUN_DIRECTORY");
    const { summary } = await rebuildReport(path.resolve(args[0]));
    console.log(renderSummary(summary));
  } catch {
    console.error(
      "Could not rebuild renderer evidence. Inspect the private history; no model was called.",
    );
    process.exitCode = 1;
  }
}
