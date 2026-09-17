import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertConfigurationMetadata,
  safeConfiguration,
  rehashConfiguration,
} from "../../scripts/normalized-run.mjs";
import { assertDeclaredHarnessVersions } from "../../scripts/benchmark-ingestion.mjs";

const adapter = {
  configurationId: "pi-default/default",
  agentFamily: "pi",
  agentVersion: "0.85.1",
  modelFamily: "gpt-5.6-luna",
  modelVersion: "gpt-5.6-luna",
  provider: "openai-codex",
  harnessFamily: "pi-default",
  harnessVersion: "0.85.1",
  adapterVersion: "1",
  model: "openai-codex/gpt-5.6-luna",
  thinking: "low",
  configurationLabels: ["harness/pi-default", "transport/harness-native"],
  kind: "pi-default",
  configuration: {
    tools: ["default"],
    extensions: [],
    rules: [],
    runtimeFlags: [],
    environment: [],
  },
};

await test("configuration metadata is required before a run can be published", () => {
  assert.doesNotThrow(() => assertConfigurationMetadata(adapter));
  assert.throws(
    () => assertConfigurationMetadata({ ...adapter, configuration: undefined }),
    /configuration metadata/u,
  );
  assert.throws(
    () =>
      assertConfigurationMetadata({
        ...adapter,
        configuration: { ...adapter.configuration, tools: undefined },
      }),
    /configuration.tools/u,
  );
});

await test("a published configuration can be re-hashed after a documented rename", () => {
  const row = safeConfiguration(adapter);
  assert.equal(rehashConfiguration(row).configurationHash, row.configurationHash);
  const renamed = rehashConfiguration({ ...row, harnessKind: "pi-agent-ide" });
  assert.notEqual(renamed.configurationHash, row.configurationHash);
  assert.deepEqual(Object.keys(renamed), Object.keys(row));
});
await test("owner and display labels do not change configuration identity", () => {
  const original = safeConfiguration(adapter);
  const renamed = safeConfiguration({
    ...adapter,
    owner: "another-contributor",
    displayLabel: "A nicer name",
  });
  assert.equal(renamed.configurationHash, original.configurationHash);
  assert.notEqual(
    safeConfiguration({ ...adapter, model: "openai-codex/another-model" }).configurationHash,
    original.configurationHash,
  );
});

await test("a declared harness version has to be one the bundle actually ran", () => {
  const harnesses = [{ id: "opencode-default", version: "1.16.2" }];
  assert.doesNotThrow(() =>
    assertDeclaredHarnessVersions(harnesses, [
      { harnessId: "opencode-default", harnessVersion: "1.18.29" },
      { harnessId: "opencode-default", harnessVersion: "1.16.2" },
    ]),
  );
  assert.throws(
    () =>
      assertDeclaredHarnessVersions(harnesses, [
        { harnessId: "opencode-default", harnessVersion: "9.9.9" },
      ]),
    /declares version 1\.16\.2, but this bundle only ran 9\.9\.9/,
  );
  assert.throws(
    () => assertDeclaredHarnessVersions(harnesses, [{ harnessId: "pi-default" }]),
    /undeclared harness/,
  );
});
