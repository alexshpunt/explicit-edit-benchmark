import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { treeIdentity } from "../generation/generator.mjs";
import { roundScore } from "../grading/round-score.mjs";
import { restoreCanonicalSource } from "./canonical-restore.mjs";
import { captureCandidate, assertCandidateUnchanged } from "./candidate-evidence.mjs";

/** Own the drained boundary, not the editing schedule. Deliveries may overlap;
 * only a settled whole candidate is measured, saved and eventually restored.
 * The caller retains participants, rotation, pending notices and raw diagnostics.
 */
export async function runRestoringRound({
  workspace,
  output,
  round,
  interval,
  drivers,
  notices,
  priorBoundary,
  executeAttempt,
  measureCandidate,
  onAttempt,
  signal,
  maxAttempts = 6,
  buildWeight = 2,
  resultWeight = 4,
}) {
  assert.ok(
    Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 6,
    "Invalid restoration attempt budget",
  );
  roundScore(
    { passedAtoms: 0, totalAtoms: interval.nodes.length, buildPassed: false, resultMatched: false },
    { buildWeight, resultWeight },
  );
  assert.equal(notices.length, drivers.length, "Invalid participant notice queues");
  assert.ok(
    drivers.length > 0 && drivers.every((driver) => typeof driver.assertIdle === "function"),
    "Persistent participant idle checks are required",
  );
  const idle = async () => {
    signal?.throwIfAborted();
    await Promise.all(drivers.map((driver) => driver.assertIdle()));
    signal?.throwIfAborted();
  };
  await idle();
  if (priorBoundary) await assertCandidateUnchanged(workspace, priorBoundary, { signal });
  const attempts = [];
  let candidate;
  await mkdir(path.join(output, "checks"), { recursive: true, mode: 0o700 });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    if (candidate) {
      await idle();
      await assertCandidateUnchanged(workspace, candidate, { signal });
    }
    await executeAttempt({ attempt, previous: attempts.at(-1), signal });
    await idle();
    const evidence = path.join(output, "checks", `${round}-attempt-${attempt}`);
    await mkdir(evidence, { mode: 0o700 });
    candidate = await captureCandidate(workspace, path.join(evidence, "candidate"), { signal });
    const measured = await measureCandidate(candidate, { attempt, evidence, signal });
    await idle();
    await assertCandidateUnchanged(workspace, candidate, { signal });
    assert.equal(measured.totalAtoms, interval.nodes.length, "Round atom denominator changed");
    const outcome = {
      attempt,
      ...roundScore(measured, { buildWeight, resultWeight }),
      identity: candidate.identity,
    };
    attempts.push(outcome);
    await writeFile(path.join(evidence, "outcome.json"), JSON.stringify(outcome, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await onAttempt?.(outcome, { candidate, measurement: measured, evidence });
    if (
      outcome.passedAtoms === outcome.totalAtoms &&
      outcome.buildPassed &&
      outcome.resultMatched &&
      outcome.integrityPassed
    )
      break;
  }
  await idle();
  await assertCandidateUnchanged(workspace, candidate, { signal });
  const final = attempts.at(-1);
  const successful =
    final.passedAtoms === final.totalAtoms &&
    final.buildPassed &&
    final.resultMatched &&
    final.integrityPassed;
  if (!successful && attempts.length !== 6)
    throw Object.assign(new Error("Reference check failed before editing exhaustion"), {
      category: "infrastructure",
      code: "RESTORING_ATTEMPTS_INCOMPLETE",
    });
  let restored;
  try {
    restored = await restoreCanonicalSource(workspace, interval.expectedTree, { signal });
  } catch (cause) {
    signal?.throwIfAborted();
    throw Object.assign(new Error("Canonical round restoration failed", { cause }), {
      category: "infrastructure",
    });
  }
  await idle();
  await mkdir(path.join(output, "restorations"), { recursive: true, mode: 0o700 });
  const boundary = await captureCandidate(workspace, path.join(output, "restorations", round), {
    signal,
  });
  assert.equal(
    treeIdentity(boundary.tree),
    restored.identity,
    "Restored source changed before the next round",
  );
  assert.equal(
    boundary.manifest.root.dev,
    candidate.manifest.root.dev,
    "Restoration replaced the workspace device",
  );
  assert.equal(
    boundary.manifest.root.ino,
    candidate.manifest.root.ino,
    "Restoration replaced the workspace inode",
  );
  const reason = successful ? "passed" : "editing-exhausted";
  const restoration = { status: "pass", identity: restored.identity, reason };
  await writeFile(
    path.join(output, "restorations", round, "restoration.json"),
    JSON.stringify(restoration, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  for (const queue of notices) queue.push({ round, ...restoration });
  return { round, attempts, firstAttempt: 1, finalAttempt: attempts.length, restoration, boundary };
}
