import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { ingestSubmission } from "../../scripts/benchmark-ingestion.mjs";
import { buildSubmission } from "../../scripts/benchmark-submission.mjs";
import {
  buildDerivedDatasetFromAggregateState,
  buildPublicDataset,
  buildPublicDatasetFromStore,
} from "../../scripts/build-public-dataset.mjs";
import { createAggregateState } from "../../scripts/aggregate-state.mjs";
import { bundle } from "../helpers/normalized-bundle.mjs";
import { auditModelProjectionRebuild } from "../../scripts/model-projection-audit.mjs";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const shard = async (file) =>
  gunzipSync(await readFile(file))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("full rebuild and incremental publication normalize aliases while source bytes stay unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-alias-"));
  try {
    const source = path.join(root, "bundle");
    const runId = "alias-run";
    const metadata = await bundle(
      source,
      runId,
      {
        model: "deepseek/deepseek-flash",
        provider: "deepseek",
        modelFamily: "deepseek-flash",
        modelVersion: "deepseek-flash",
      },
      {
        inputTokens: 0,
        outputTokens: 208912,
        cacheReadTokens: 8103936,
        cacheWriteTokens: 456985,
        totalTokens: 8769833,
        costUsd: 0.218206758,
      },
    );
    const names = [
      "manifest.json",
      "profiles.jsonl",
      "configurations.jsonl",
      "trials.jsonl",
      "rounds.jsonl",
      "tool-calls.jsonl",
    ];
    const before = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [name, await readFile(path.join(source, name), "utf8")]),
      ),
    );
    const store = path.join(root, "store");
    const accepted = await ingestSubmission(
      store,
      { ownerId: "alice" },
      await buildSubmission(source, metadata),
    );
    const rebuilt = path.join(root, "rebuilt");
    const fullIndex = await buildPublicDatasetFromStore(rebuilt, store);
    const single = path.join(root, "single");
    const singleIndex = await buildPublicDataset(single, [source]);
    const evidence = {};
    for (const [key, table] of [
      ["profiles", "profiles"],
      ["trials", "trials"],
      ["rounds", "rounds"],
      ["toolCalls", "tool-calls"],
    ])
      evidence[key] = await shard(path.join(single, "data", table, `${runId}.jsonl.gz`));
    const sourceIndex = await json(path.join(store, "index.json"));
    const incremental = path.join(root, "incremental");
    await mkdir(incremental);
    const run = { ...singleIndex.runs[0], ...sourceIndex.submissions[0] };
    const state = createAggregateState({ sourceIndex, run, ...evidence });
    await buildDerivedDatasetFromAggregateState(incremental, { runs: [run] }, state);
    const publicProfiles = await shard(path.join(rebuilt, "data", "profiles", `${runId}.jsonl.gz`));
    const publicConfigurations = await shard(
      path.join(rebuilt, "data", "configurations", `${runId}.jsonl.gz`),
    );
    assert.equal(publicProfiles[0].modelFamily, "deepseek-v4.1-flash");
    assert.equal(publicProfiles[0].modelVersion, "deepseek-v4.1-flash");
    assert.equal(publicProfiles[0].model, "deepseek/deepseek-flash");
    assert.equal(publicProfiles[0].configurationHash, publicConfigurations[0].configurationHash);
    const { runId: _runId, configurationHash, ...recipe } = publicConfigurations[0];
    assert.equal(
      configurationHash,
      createHash("sha256").update(JSON.stringify(recipe)).digest("hex"),
    );
    for (const name of names) {
      assert.equal(await readFile(path.join(source, name), "utf8"), before[name]);
      assert.equal(
        await readFile(
          path.join(rebuilt, "source", "accepted", accepted.submissionId, name),
          "utf8",
        ),
        before[name],
      );
    }
    assert.equal(
      fullIndex.runs[0].manifestSha256,
      createHash("sha256").update(before["manifest.json"]).digest("hex"),
    );
    const fullRows = (await json(path.join(rebuilt, "leaderboard.json"))).rows;
    const incrementalRows = (await json(path.join(incremental, "leaderboard.json"))).rows;
    assert.equal(fullRows[0].modelFamily, "deepseek-v4.1-flash");
    assert.equal(incrementalRows[0].modelFamily, fullRows[0].modelFamily);
    assert.equal(incrementalRows[0].configurationHash, fullRows[0].configurationHash);
    assert.equal(incrementalRows[0].score, fullRows[0].score);
    assert.equal(incrementalRows[0].firstExactRate, fullRows[0].firstExactRate);
    const previous = path.join(root, "previous");
    await cp(rebuilt, previous, { recursive: true });
    await writeFile(
      path.join(previous, "data", "profiles", `${runId}.jsonl.gz`),
      gzipSync(
        before["profiles.jsonl"]
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.stringify({ runId, ...JSON.parse(line) }))
          .join("\n") + "\n",
      ),
    );
    const audit = await auditModelProjectionRebuild(previous, rebuilt);
    assert.equal(audit.runsVerified, 1);
    assert.equal(audit.changes.length, 1);
    assert.equal(audit.changes[0].previousModelFamily, "deepseek-flash");
    assert.equal(audit.changes[0].modelFamily, "deepseek-v4.1-flash");
    assert.equal(audit.changes[0].totalTokens, 8769833);
    assert.equal(audit.changes[0].costUsd, 0.218206758);
    const sourceManifest = path.join(
      previous,
      "source",
      "accepted",
      accepted.submissionId,
      "manifest.json",
    );
    await writeFile(sourceManifest, "changed");
    await assert.rejects(
      auditModelProjectionRebuild(previous, rebuilt),
      /preserve every source file/u,
    );
    await writeFile(sourceManifest, before["manifest.json"]);
    await writeFile(
      path.join(previous, "data", "rounds", `${runId}.jsonl.gz`),
      gzipSync("changed\n"),
    );
    await assert.rejects(auditModelProjectionRebuild(previous, rebuilt), /preserve rounds/u);
    for (const output of [rebuilt, incremental]) {
      const index = await json(path.join(output, "dataset-index.json"));
      const summary = await shard(path.join(output, index.explorerSummary.path));
      assert.equal(summary[0].profiles[0].modelFamily, "deepseek-v4.1-flash");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
