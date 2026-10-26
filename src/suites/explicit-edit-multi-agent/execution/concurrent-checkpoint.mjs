import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readTree, treeIdentity, writeTree } from "../generation/generator.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bindingKeys = [
  "agents",
  "batchSize",
  "workloadSha256",
  "graphSha256",
  "scheduleSha256",
  "schedule",
  "contractHashes",
  "policy",
  "atomic",
  "initial",
  "expectedFinal",
];
const binding = (report) => Object.fromEntries(bindingKeys.map((key) => [key, report[key]]));

function metadata(report, roundId, source, sourceReportSha256) {
  assert.ok(Number.isSafeInteger(report.agents) && report.agents > 0);
  const index = report.schedule.findIndex((round) => round.id === roundId);
  const base = report.resume?.completedRounds ?? 0;
  assert.ok(index >= base, "Checkpoint must advance the accepted prefix");
  const prefix = report.schedule.slice(0, index + 1);
  const acceptedTasks = prefix.reduce((sum, round) => sum + round.assignments.length, 0);
  assert.ok(report.acceptedRounds >= prefix.length && report.acceptedTasks >= acceptedTasks);
  let last;
  let previous = -1;
  for (const round of prefix.slice(base)) {
    const position = report.atomicBarriers.findIndex(
      (state) => state.round === round.id && state.status === "accepted",
    );
    assert.ok(position > previous, "Checkpoint requires a contiguous accepted prefix");
    const state = report.atomicBarriers[position];
    assert.ok(Array.isArray(state.accepted) && state.accepted.length > 0);
    previous = position;
    last = state;
  }
  const sourceIdentity = treeIdentity(source);
  const check = report.checks.find((entry) => entry.label === `${roundId}-attempt-${last.attempt}`);
  assert.equal(check?.status, "pass", "Checkpoint requires a passed strict check");
  assert.equal(check.identity, sourceIdentity, "Checkpoint source differs from accepted source");
  const baseRotation = report.resume?.rotation ?? 0;
  assert.ok(
    Number.isSafeInteger(baseRotation) && baseRotation >= 0 && baseRotation < report.agents,
  );
  return {
    version: "renderer-concurrent-checkpoint-v1",
    binding: binding(report),
    sourceReportSha256,
    sourceIdentity,
    roundId,
    completedRounds: prefix.length,
    acceptedTasks,
    rotation: (baseRotation + previous + 1) % report.agents,
  };
}

/** Export only a fully accepted barrier. Publish the marker last; never overwrite.
 * Checkpoints contain source and progress, not provider credentials or chat history.
 */
export async function writeConcurrentCheckpoint(directory, { report, roundId, source }) {
  const bytes = JSON.stringify(report) + "\n";
  const checkpoint = metadata(report, roundId, source, digest(bytes));
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await writeTree(path.join(directory, "source"), source);
  await writeFile(path.join(directory, "source-report.json"), bytes, { flag: "wx" });
  await writeFile(
    path.join(directory, "checkpoint.pending.json"),
    JSON.stringify(checkpoint) + "\n",
    {
      flag: "wx",
    },
  );
  await rename(
    path.join(directory, "checkpoint.pending.json"),
    path.join(directory, "checkpoint.json"),
  );
  return checkpoint;
}

/** Artifact integrity is not acceptance: the caller must strictly regrade this
 * source under the current verifier before opening any new participant sessions.
 */
export async function readConcurrentCheckpoint(directory, currentReport) {
  const checkpoint = JSON.parse(await readFile(path.join(directory, "checkpoint.json"), "utf8"));
  const bytes = await readFile(path.join(directory, "source-report.json"), "utf8");
  assert.equal(digest(bytes), checkpoint.sourceReportSha256, "Checkpoint parent report changed");
  const source = await readTree(path.join(directory, "source"));
  const expected = metadata(JSON.parse(bytes), checkpoint.roundId, source, digest(bytes));
  assert.deepEqual(checkpoint, expected, "Checkpoint metadata changed");
  assert.deepEqual(
    checkpoint.binding,
    binding(currentReport),
    "Checkpoint workload or schedule differs",
  );
  return { ...checkpoint, source };
}
