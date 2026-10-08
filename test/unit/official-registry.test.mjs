import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installedDependencyFingerprint,
  resolveExecutionPlan,
  selectOfficialCredential,
} from "../../scripts/execution-plan.mjs";
import { canonicalModelProvider, loadModelRegistry } from "../../scripts/model-registry.mjs";

const input = {
  adapter: "pi-default",
  agentVersion: "0.85.1",
  provider: "openai-codex",
  model: "openai-codex/gpt-5.6-luna",
  reasoning: "low",
};

function registry(metadata = {}) {
  return async (url) => ({
    ok: true,
    json: async () => ({
      name: "@earendil-works/pi-coding-agent",
      version: "0.85.1",
      dependencies: { "some-runtime": "1.2.3" },
      dist: {
        integrity: "sha512-abcdef",
        tarball:
          "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz",
      },
      ...metadata,
      requestedUrl: url,
    }),
  });
}

test("official resolver emits an exact declarative Pi plan", async () => {
  const plan = await resolveExecutionPlan(input, { fetch: registry() });
  assert.equal(plan.planHash.length, 64);
  assert.deepEqual(
    plan.packages.map(({ name, version, role }) => ({ name, version, role })),
    [{ name: "@earendil-works/pi-coding-agent", version: "0.85.1", role: "agent" }],
  );
  assert.equal(plan.model, "openai-codex/gpt-5.6-luna");
  assert.equal(Object.hasOwn(plan, "command"), false);
  assert.equal(Object.hasOwn(plan, "credentials"), false);
});
for (const provider of ["deepseek", "zai", "xiaomi", "opencode-go", "opencode"]) {
  test(`official resolver selects only the ${provider} API key`, async () => {
    const plan = await resolveExecutionPlan(
      { ...input, provider, model: `${provider}/model` },
      { fetch: registry() },
    );
    assert.equal(plan.provider, provider);
    assert.deepEqual(plan.credential.fields, ["type", "key"]);
    assert.deepEqual(
      selectOfficialCredential(
        {
          [provider]: { type: "api_key", key: "secret" },
          another: { type: "api_key", key: "ignored" },
        },
        plan,
      ),
      { [provider]: { type: "api_key", key: "secret" } },
    );
  });
}

test("Luna repairs known provider aliases without hiding future providers", async () => {
  const registry = await loadModelRegistry();

  for (const recorded of ["agent-proxy", "openai", "openai-codex", null])
    assert.equal(canonicalModelProvider(registry, "gpt-5.6-luna", recorded), "openai-codex");
  assert.equal(
    canonicalModelProvider(registry, "gpt-5.6-luna", "future-provider"),
    "future-provider",
  );
  assert.equal(
    canonicalModelProvider(registry, "deepseek-v4.1-flash", "opencode-go"),
    "opencode-go",
  );
});

test("provider selectors resolve to one versioned canonical model", async () => {
  const deepseek = await resolveExecutionPlan(
    { ...input, provider: "deepseek", model: "deepseek/deepseek-flash" },
    { fetch: registry() },
  );
  const opencode = await resolveExecutionPlan(
    {
      ...input,
      provider: "opencode-go",
      model: "opencode-go/deepseek-v4.1-flash",
    },
    { fetch: registry() },
  );

  assert.equal(deepseek.canonicalModel.id, "deepseek-v4.1-flash");
  assert.equal(opencode.canonicalModel.id, "deepseek-v4.1-flash");
  assert.equal(deepseek.model, "deepseek/deepseek-flash");
  assert.equal(opencode.model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(deepseek.modelRegistry.id, "benchmark-models-v1");
  assert.match(deepseek.modelRegistry.sha256, /^[0-9a-f]{64}$/u);
});

test("an unaliased selector keeps its exact model name", async () => {
  const plan = await resolveExecutionPlan(input, { fetch: registry() });
  assert.equal(plan.canonicalModel.id, "gpt-5.6-luna");
  assert.equal(plan.canonicalModel.displayName, "gpt-5.6-luna");
});
test("an unrelated stored credential is not an official provider", async () => {
  await assert.rejects(
    resolveExecutionPlan(
      { ...input, provider: "typesafe", model: "typesafe/model" },
      { fetch: registry() },
    ),
    /Unsupported provider/,
  );
});
test("Pi Agent IDE resolves agent and extension as separate exact packages", async () => {
  const plan = await resolveExecutionPlan(
    { ...input, adapter: "pi-agent-ide", harnessVersion: "1.2.3" },
    {
      fetch: async (url) => {
        const ide = url.includes("pi-agent-ide");
        const name = ide ? "pi-agent-ide" : "@earendil-works/pi-coding-agent";
        const version = ide ? "1.2.3" : "0.85.1";
        return {
          ok: true,
          json: async () => ({
            name,
            version,
            dependencies: {},
            dist: {
              integrity: "sha512-abcdef",
              tarball: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
            },
          }),
        };
      },
    },
  );
  assert.deepEqual(
    plan.packages.map(({ role }) => role),
    ["agent", "extension"],
  );
});

test("official resolver rejects executable and mutable caller inputs before package resolution", async () => {
  for (const extra of [
    { command: "sh -c evil" },
    { config: "./benchmark.ts" },
    { endpoint: "https://attacker.invalid" },
    { env: { PATH: "/tmp/bin" } },
    { runtimeMount: "/" },
  ]) {
    await assert.rejects(
      resolveExecutionPlan({ ...input, ...extra }, { fetch: registry() }),
      /expected fields/,
    );
  }
  for (const version of ["latest", "^0.85.1", "file:../pi", "git+https://example.invalid/pi"])
    await assert.rejects(
      resolveExecutionPlan({ ...input, agentVersion: version }, { fetch: registry() }),
      /exact semantic version/,
    );
  await assert.rejects(
    resolveExecutionPlan({ ...input, adapter: "unknown" }, { fetch: registry() }),
    /Unknown adapter/,
  );
  await assert.rejects(
    resolveExecutionPlan({ ...input, model: "other/gpt" }, { fetch: registry() }),
    /provider-qualified/,
  );
  await assert.rejects(
    resolveExecutionPlan(
      { ...input, model: "openai-codex/luna; touch owned" },
      { fetch: registry() },
    ),
    /provider-qualified/,
  );
});

test("official resolver rejects substituted package bytes and origins", async () => {
  await assert.rejects(
    resolveExecutionPlan(input, { fetch: registry({ version: "0.85.2" }) }),
    /identity mismatch/,
  );
  await assert.rejects(
    resolveExecutionPlan(input, {
      fetch: registry({
        dist: { integrity: "sha512-abcdef", tarball: "https://attacker.invalid/package.tgz" },
      }),
    }),
    /forbidden tarball origin/,
  );
});

test("installed dependency fingerprint covers exact resolved tree and rejects substitution", async () => {
  const plan = await resolveExecutionPlan(input, { fetch: registry() });
  const runtime = await mkdtemp(path.join(tmpdir(), "official-runtime-"));
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: {} },
      "node_modules/@earendil-works/pi-coding-agent": {
        version: "0.85.1",
        resolved:
          "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz",
        integrity: "sha512-abcdef",
      },
      "node_modules/runtime-child": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/runtime-child/-/runtime-child-1.2.3.tgz",
        integrity: "sha512-child",
      },
    },
  };
  await writeFile(path.join(runtime, "package-lock.json"), JSON.stringify(lock));
  const first = await installedDependencyFingerprint(runtime, plan);
  assert.equal(first.packageCount, 2);
  lock.packages["node_modules/runtime-child"].version = "1.2.4";
  await writeFile(path.join(runtime, "package-lock.json"), JSON.stringify(lock));
  const changed = await installedDependencyFingerprint(runtime, plan);
  assert.notEqual(changed.fingerprint, first.fingerprint);
  lock.packages["node_modules/@earendil-works/pi-coding-agent"].version = "0.85.2";
  await writeFile(path.join(runtime, "package-lock.json"), JSON.stringify(lock));
  await assert.rejects(installedDependencyFingerprint(runtime, plan), /does not match plan/);
});

test("credential loader selects one provider and rejects embedded configuration", async () => {
  const plan = await resolveExecutionPlan(input, { fetch: registry() });
  const credential = {
    type: "oauth",
    access: "secret-access",
    refresh: "secret-refresh",
    expires: 123,
    accountId: "account",
  };
  assert.deepEqual(
    selectOfficialCredential({ "openai-codex": credential, another: { key: "ignored" } }, plan),
    { "openai-codex": credential },
  );
  for (const injected of [
    { baseUrl: "https://attacker.invalid" },
    { modelCatalog: {} },
    { callback: "./evil.js" },
  ])
    assert.throws(
      () => selectOfficialCredential({ "openai-codex": { ...credential, ...injected } }, plan),
      /expected fields/,
    );
});
