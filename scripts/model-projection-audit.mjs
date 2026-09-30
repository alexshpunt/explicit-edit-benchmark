import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function sourceDigests(root, prefix = "") {
  const result = {};
  for (const entry of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await sourceDigests(root, relative));
    else result[relative] = digest(await readFile(path.join(root, relative)));
  }
  return result;
}

async function table(root, name, runId) {
  return gunzipSync(await readFile(path.join(root, "data", name, `${runId}.jsonl.gz`))).toString(
    "utf8",
  );
}

function withoutModelProjection({
  modelFamily: _family,
  modelVersion: _version,
  provider: _provider,
  configurationHash: _hash,
  ...row
}) {
  return row;
}

/** Verify a model projection rebuild preserves source bytes and run facts before publication. */
export async function auditModelProjectionRebuild(previousDirectory, nextDirectory) {
  const source = await sourceDigests(path.join(previousDirectory, "source"));
  assert.deepEqual(
    await sourceDigests(path.join(nextDirectory, "source")),
    source,
    "A projection rebuild must preserve every source file",
  );
  const previous = JSON.parse(
    await readFile(path.join(previousDirectory, "dataset-index.json"), "utf8"),
  );
  const next = JSON.parse(await readFile(path.join(nextDirectory, "dataset-index.json"), "utf8"));
  const identities = (index) =>
    index.runs
      .map(({ runId, submissionId, manifestSha256 }) => ({ runId, submissionId, manifestSha256 }))
      .sort((a, b) => a.runId.localeCompare(b.runId));
  assert.deepEqual(
    identities(next),
    identities(previous),
    "A projection rebuild must preserve run IDs and source identities",
  );
  const changes = [];
  for (const { runId } of next.runs) {
    for (const name of ["trials", "rounds", "tool-calls"])
      assert.equal(
        await table(nextDirectory, name, runId),
        await table(previousDirectory, name, runId),
        `A projection rebuild must preserve ${name} for ${runId}`,
      );
    const rows = (content) =>
      content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const before = rows(await table(previousDirectory, "profiles", runId));
    const after = rows(await table(nextDirectory, "profiles", runId));
    assert.deepEqual(
      after.map(withoutModelProjection),
      before.map(withoutModelProjection),
      `A projection rebuild changed non-model profile facts for ${runId}`,
    );
    for (const [position, profile] of after.entries()) {
      const prior = before[position];
      if (
        profile.modelFamily === prior.modelFamily &&
        profile.modelVersion === prior.modelVersion &&
        profile.provider === prior.provider &&
        profile.configurationHash === prior.configurationHash
      )
        continue;
      const trialIds = new Set(
        rows(await table(nextDirectory, "trials", runId))
          .filter((trial) => trial.profileId === profile.profileId)
          .map((trial) => trial.trialId),
      );
      const rounds = rows(await table(nextDirectory, "rounds", runId)).filter((round) =>
        trialIds.has(round.trialId),
      );
      const total = (key) =>
        rounds.some((round) => typeof round[key] === "number")
          ? rounds.reduce((sum, round) => sum + (round[key] ?? 0), 0)
          : null;
      changes.push({
        runId,
        profileId: profile.profileId,
        previousModelFamily: prior.modelFamily,
        modelFamily: profile.modelFamily,
        modelVersion: profile.modelVersion,
        provider: profile.provider,
        model: profile.model,
        totalTokens: total("totalTokens"),
        costUsd: total("costUsd"),
      });
    }
  }
  return {
    sourceFilesVerified: Object.keys(source).length,
    runsVerified: next.runs.length,
    changes,
  };
}
