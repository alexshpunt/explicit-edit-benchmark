import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalizeModelProviderRows } from "../../scripts/build-public-dataset.mjs";

const registry = {
  models: [
    { id: "deepseek-v4.1-flash", routes: [{ provider: "deepseek", selector: "deepseek-flash" }] },
  ],
};
const row = () => ({
  model: "deepseek/deepseek-flash",
  provider: "deepseek",
  modelFamily: "deepseek-flash",
  modelVersion: "deepseek-flash",
  configurationHash: "old-hash",
});

test("a registered alias projects as one canonical family without changing the wire selector", () => {
  const source = row();
  const next = canonicalizeModelProviderRows([source], [source], registry);
  for (const projected of [...next.profiles, ...next.configurations]) {
    assert.equal(projected.modelFamily, "deepseek-v4.1-flash");
    assert.equal(projected.modelVersion, "deepseek-v4.1-flash");
    assert.equal(projected.model, source.model);
    assert.equal(projected.provider, "deepseek");
  }
  const { configurationHash, ...recipe } = next.configurations[0];
  assert.equal(
    configurationHash,
    createHash("sha256").update(JSON.stringify(recipe)).digest("hex"),
  );
  assert.equal(next.profiles[0].configurationHash, configurationHash);
  assert.deepEqual(
    canonicalizeModelProviderRows(next.profiles, next.configurations, registry),
    next,
  );
  assert.deepEqual(source, row());
});

test("moving aliases never rewrite explicit historical identities or cross provider boundaries", () => {
  for (const source of [
    { ...row(), modelFamily: "deepseek-v4-flash", modelVersion: "deepseek-v4-flash" },
    { ...row(), modelFamily: "deepseek-v4.1-flash", modelVersion: "2026-09-24" },
    { ...row(), provider: "another-provider", model: "another-provider/deepseek-flash" },
    { ...row(), model: "another-provider/deepseek-flash" },
    { ...row(), model: "deepseek/unknown", modelFamily: "unknown", modelVersion: "unknown" },
  ])
    assert.deepEqual(canonicalizeModelProviderRows([source], [source], registry), {
      profiles: [source],
      configurations: [source],
    });
});

test("unqualified registered selectors keep explicit versions while normalizing their alias family", () => {
  const source = { ...row(), model: "deepseek-flash", modelVersion: "2026-09-24" };
  const next = canonicalizeModelProviderRows([source], [source], registry);
  assert.equal(next.profiles[0].modelFamily, "deepseek-v4.1-flash");
  assert.equal(next.profiles[0].modelVersion, "2026-09-24");
});
