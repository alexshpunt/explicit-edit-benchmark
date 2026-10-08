import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { buildPublicDataset } from "../../scripts/build-public-dataset.mjs";
import { bundle } from "../helpers/normalized-bundle.mjs";

test("configuration viewer types do not depend on empty lists or null values in the first shard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viewer-schema-"));
  try {
    const empty = path.join(root, "empty");
    const filled = path.join(root, "filled");
    await bundle(empty, "a-empty");
    await bundle(
      filled,
      "b-filled",
      {
        provider: "test-provider",
        transport: "stdio",
      },
      {},
      {
        tools: ["edit", "read"],
        extensions: ["test-extension"],
        rules: ["test-rule"],
        runtimeFlags: ["safe-mode"],
        environment: ["TEST_TOKEN"],
        configurationLabels: ["test-label"],
      },
    );
    const output = path.join(root, "dataset");
    await buildPublicDataset(output, [empty, filled]);
    const card = await readFile(path.join(output, "README.md"), "utf8");
    const info = card.match(/dataset_info:\n  - config_name: configurations\n    features: (.+)/u);
    assert.ok(info, "The card must declare the configurations feature types");
    const features = JSON.parse(info[1]);
    const lists = new Set([
      "tools",
      "extensions",
      "rules",
      "runtimeFlags",
      "environment",
      "configurationLabels",
    ]);
    for (const runId of ["a-empty", "b-filled"]) {
      const row = JSON.parse(
        gunzipSync(
          await readFile(path.join(output, "data", "configurations", `${runId}.jsonl.gz`)),
        ).toString("utf8"),
      );
      assert.deepEqual(features.map(({ name }) => name).sort(), Object.keys(row).sort());
      for (const feature of features) {
        assert.deepEqual(
          feature,
          lists.has(feature.name)
            ? { name: feature.name, list: "string" }
            : { name: feature.name, dtype: "string" },
        );
        const value = row[feature.name];
        if (lists.has(feature.name)) assert.ok(value.every((item) => typeof item === "string"));
        else assert.ok(value === null || typeof value === "string");
      }
      assert.equal(row.provider, runId === "a-empty" ? null : "test-provider");
      assert.deepEqual(row.rules, runId === "a-empty" ? [] : ["test-rule"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
