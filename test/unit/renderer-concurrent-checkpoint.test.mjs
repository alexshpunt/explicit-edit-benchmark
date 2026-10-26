import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tempDirectory } from "../helpers/temp.mjs";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  readConcurrentCheckpoint,
  writeConcurrentCheckpoint,
} from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-checkpoint.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";

const source = { "main.cpp": "int f() { return 1; }\n" };
function fixture() {
  return {
    agents: 2,
    batchSize: 1,
    workloadSha256: "workload",
    graphSha256: "graph",
    scheduleSha256: "schedule",
    schedule: ["one", "two", "three"].map((id) => ({
      id,
      assignments: [{ agent: 0, task: `task-${id}` }],
    })),
    contractHashes: { one: "a", two: "b", three: "c" },
    policy: { attempts: 6 },
    atomic: { edits: 3 },
    initial: "initial",
    expectedFinal: "final",
    acceptedRounds: 2,
    acceptedTasks: 2,
    atomicBarriers: [
      { round: "one", attempt: 1, status: "accepted", accepted: ["edit-one"] },
      { round: "two", attempt: 1, status: "failed" },
      { round: "two", attempt: 2, status: "accepted", accepted: ["edit-two"] },
      { round: "three", attempt: 1, status: "failed" },
    ],
    checks: ["one-attempt-1", "two-attempt-2"].map((label) => ({
      label,
      status: "pass",
      identity: treeIdentity(source),
    })),
  };
}
async function directory(t) {
  const root = await tempDirectory("concurrent-checkpoint-");
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "checkpoint");
}

test("checkpoint recovery cannot be a scripted reference or omit its fault reason", async () => {
  await assert.rejects(
    runConcurrent("unused", "unused", { resumeFrom: "checkpoint", reference: true }),
  );
  await assert.rejects(
    runConcurrent("unused", "unused", { resumeFrom: "checkpoint", createDriver() {} }),
  );
});

test("checkpoint exports an accepted prefix, not later failed workspace edits", async (t) => {
  const root = await directory(t);
  const report = fixture();
  await writeConcurrentCheckpoint(root, { report, roundId: "two", source });
  const restored = await readConcurrentCheckpoint(root, report);
  assert.deepEqual(restored.source, source);
  assert.equal(restored.completedRounds, 2);
  assert.equal(restored.acceptedTasks, 2);
  assert.equal(restored.rotation, 1);
  assert.equal(restored.roundId, "two");
  await assert.rejects(writeConcurrentCheckpoint(root, { report, roundId: "two", source }));
});

test("checkpoint rejects failed, skipped and mismatched accepted snapshots", async (t) => {
  const root = await directory(t);
  const report = fixture();
  await assert.rejects(writeConcurrentCheckpoint(root, { report, roundId: "three", source }));
  report.atomicBarriers = report.atomicBarriers.filter((state) => state.round !== "one");
  await assert.rejects(writeConcurrentCheckpoint(root, { report, roundId: "two", source }));
  await assert.rejects(
    writeConcurrentCheckpoint(root, {
      report: fixture(),
      roundId: "two",
      source: { "main.cpp": "int f() { return 2; }\n" },
    }),
  );
});

test("checkpoint binds the schedule, workload and delivery size", async (t) => {
  const root = await directory(t);
  const report = fixture();
  await writeConcurrentCheckpoint(root, { report, roundId: "two", source });
  for (const change of [
    { batchSize: 10 },
    { workloadSha256: "other" },
    { schedule: report.schedule.toReversed() },
    { contractHashes: {} },
  ]) {
    await assert.rejects(readConcurrentCheckpoint(root, { ...report, ...change }));
  }
});

test("checkpoint rejects changed source, metadata and parent report", async (t) => {
  for (const file of ["source/main.cpp", "source-report.json", "checkpoint.json"]) {
    const root = await directory(t);
    await writeConcurrentCheckpoint(root, { report: fixture(), roundId: "two", source });
    const target = path.join(root, file);
    const original = await readFile(target, "utf8");
    await writeFile(target, file.endsWith(".json") ? original.replace('"two"', '"three"') : "bad");
    await assert.rejects(readConcurrentCheckpoint(root, fixture()));
  }
});

test("an interrupted checkpoint is not resumable", async (t) => {
  const root = await directory(t);
  await mkdir(root);
  await writeFile(path.join(root, "checkpoint.pending.json"), "{}");
  await assert.rejects(readConcurrentCheckpoint(root, fixture()));
});

test("a resumed segment checkpoints cumulative progress and retained rotation", async (t) => {
  const root = await directory(t);
  const report = fixture();
  report.resume = { completedRounds: 1, acceptedTasks: 1, rotation: 1 };
  report.atomicBarriers = report.atomicBarriers.filter((state) => state.round !== "one");
  await writeConcurrentCheckpoint(root, { report, roundId: "two", source });
  const restored = await readConcurrentCheckpoint(root, report);
  assert.equal(restored.completedRounds, 2);
  assert.equal(restored.rotation, 1);
});
