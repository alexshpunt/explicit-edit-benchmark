import { test } from "node:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_BINARIES,
  dependencyRoot,
  ADAPTER_IDS,
  defaultConfigPath,
  makeAdapter,
  resolveIdePackage,
  resolveProfileName,
  resolveProviderRoute,
} from "../../scripts/prepare-benchmark.mjs";
import { recoveryAdapter } from "../../scripts/harness-runtime.mjs";
import { defineHarness, resolveBenchmarkProfiles } from "../../scripts/benchmark-config.mjs";
import { dshCredentialDocument } from "../../scripts/export-pi-oauth-to-dsh.mjs";
import { tempDirectory } from "../helpers/temp.mjs";

await test("an IDE entry must be the extension its package declares", async () => {
  const root = await tempDirectory("ide-entry");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "example-ide", pi: { extensions: ["./src/real.ts"] } }),
  );
  await writeFile(path.join(root, "src/real.ts"), "");
  await writeFile(path.join(root, "src/barrel.ts"), "");
  assert.deepEqual(resolveIdePackage(root).entry, path.join(root, "src/real.ts"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "example-ide", pi: { extensions: ["./src", "./src/real.ts"] } }),
  );
  assert.throws(() => resolveIdePackage(root), /exactly one pi.extensions entry/);
});

await test("matrix profile names stay separate from Copilot runtime kind", () => {
  assert.equal(resolveProfileName("copilot", undefined), "copilot");
  assert.equal(resolveProfileName("copilot", "copilot-vekil-luna-low"), "copilot-vekil-luna-low");
  assert.throws(() => resolveProfileName("copilot", "Copilot/Luna"), /Invalid profile name/);
});

await test("a resolved profile publishes the harness family, not the config key", async () => {
  const profiles = await resolveBenchmarkProfiles({
    models: { luna: { family: "gpt-5.6-luna", version: "2026-09", thinking: "low" } },
    harnesses: {
      "pi-agent-ide": defineHarness({
        createAdapter: () => ({
          kind: "custom",
          model: "openai-codex/gpt-5.6-luna",
          thinking: "low",
          agentFamily: "pi",
          agentVersion: "0.85.1",
          modelFamily: "gpt-5.6-luna",
          modelVersion: "2026-09",
          harnessFamily: "pi-agent-ide",
          adapterVersion: "1",
          configurationLabels: ["harness/pi-agent-ide"],
        }),
      }),
    },
    selection: { matrix: [{ models: ["luna"], harnesses: ["pi-agent-ide"] }], pairs: [] },
  });
  assert.equal(profiles["luna-pi-agent-ide"].harnessId, "pi-agent-ide");
});
const provider = {
  id: "example-provider",
  displayName: "Example provider",
  apiKeyEnv: "EXAMPLE_API_KEY",
  endpoints: {
    completions: "https://example.test/v1",
    responses: "https://example.test/v1",
  },
  supportsReasoningEffort: false,
  transport: "direct",
};
const env = { EXAMPLE_API_KEY: "test-secret" };

await test("native adapters carry explicit model and reasoning through recovery", async () => {
  const ide = await tempDirectory("ide-package");
  await mkdir(path.join(ide, "dist"), { recursive: true });
  await writeFile(path.join(ide, "dist/pi-agent-ide.js"), "");
  await writeFile(
    path.join(ide, "package.json"),
    JSON.stringify({
      name: "pi-agent-ide",
      version: "1.0.0",
      pi: { extensions: ["./dist/pi-agent-ide.js"] },
    }),
  );
  for (const harness of [
    "pi-default",
    "pi-agent-ide",
    "codex-cli-default",
    "opencode-default",
    "oh-my-pi-default",
  ]) {
    const adapter = makeAdapter({
      harness,
      command: "/usr/bin/tool",
      version: "test",
      model: "provider/model-example",
      thinking: "medium",
      ...(harness === "pi-agent-ide" ? { idePackage: ide } : {}),
    });
    assert.ok(JSON.stringify(adapter.args).includes("provider/model-example"));
    assert.ok(JSON.stringify(adapter.args).includes("medium"));
    assert.equal(adapter.ready, false);
    assert.equal(adapter.env.SHELL, harness === "pi-agent-ide" ? "/bin/bash" : undefined);
    assert.deepEqual(adapter.seedFiles, {});
    assert.ok(
      JSON.stringify(recoveryAdapter(adapter, true).args).includes("provider/model-example"),
    );
  }
  assert.throws(() => makeAdapter({ harness: "codex-cli-default" }), /Explicit/);
  const opencode = makeAdapter({
    harness: "opencode-default",
    command: "/usr/bin/tool",
    version: "test",
    model: "provider/model-example",
    thinking: "low",
  });
  assert.ok(opencode.args.includes("--dangerously-skip-permissions"));
  assert.ok(!opencode.args.includes("--auto"));
  assert.throws(
    () => makeAdapter({ harness: "other", model: "x", thinking: "low" }),
    /Unsupported/,
  );
});

await test("Copilot can use its existing account without a custom provider", () => {
  const adapter = makeAdapter({
    harness: "github-copilot-cli-default",
    command: "/usr/bin/copilot",
    version: "test",
    model: "gpt-5.6-luna",
    thinking: "low",
    authFile: "/opt/auth/copilot.json",
  });
  assert.equal(adapter.transport, "harness-native");
  assert.equal(adapter.env.COPILOT_OFFLINE, undefined);
  assert.ok(adapter.args.includes("gpt-5.6-luna"));
  assert.equal(adapter.seedFiles["home/.copilot/config.json"], "/opt/auth/copilot.json");
});
await test("Copilot BYOK uses current provider variables without unsupported effort", () => {
  const adapter = makeAdapter({
    harness: "github-copilot-cli-default",
    command: "/usr/bin/copilot",
    version: "test",
    model: "model-example",
    thinking: "low",
    provider,
    env,
  });
  assert.equal(adapter.env.COPILOT_PROVIDER_BASE_URL, "https://example.test/v1");
  assert.equal(adapter.env.COPILOT_PROVIDER_API_KEY, "test-secret");
  assert.equal(adapter.env.COPILOT_PROVIDER_WIRE_API, "completions");
  assert.equal(adapter.env.COPILOT_OFFLINE, "true");
  assert.ok(!adapter.args.includes("--effort"));
  assert.deepEqual(adapter.seedFiles, {});
});

await test("Copilot can route a GPT-5 model through an OAuth Responses endpoint", () => {
  const adapter = makeAdapter({
    harness: "github-copilot-cli-default",
    command: "/usr/bin/copilot",
    version: "test",
    model: "gpt-5.6-luna",
    thinking: "low",
    provider: {
      id: "openai-codex",
      apiKeyEnv: "OPENAI_CODEX_ACCESS_TOKEN",
      endpoints: { responses: "https://chatgpt.com/backend-api/codex" },
      copilotWireApi: "responses",
      copilotModelId: "gpt-5.4",
      copilotCredentialType: "bearer",
      copilotHeadersEnv: "OPENAI_CODEX_HEADERS",
      copilotMaxPromptTokens: 272000,
      copilotMaxOutputTokens: 128000,
    },
    env: {
      OPENAI_CODEX_ACCESS_TOKEN: "access-token",
      OPENAI_CODEX_HEADERS: "chatgpt-account-id: account",
    },
  });
  assert.equal(adapter.env.COPILOT_PROVIDER_WIRE_API, "responses");
  assert.equal(adapter.env.COPILOT_PROVIDER_MODEL_ID, "gpt-5.4");
  assert.equal(adapter.env.COPILOT_PROVIDER_WIRE_MODEL, "gpt-5.6-luna");
  assert.equal(adapter.env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS, "272000");
  assert.equal(adapter.env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS, "128000");
  assert.equal(adapter.env.COPILOT_PROVIDER_BEARER_TOKEN, "access-token");
  assert.equal(adapter.env.COPILOT_PROVIDER_HEADERS, "chatgpt-account-id: account");
  assert.equal(adapter.env.COPILOT_PROVIDER_API_KEY, undefined);
});
await test("Codex custom providers use isolated Responses configuration", () => {
  const adapter = makeAdapter({
    harness: "codex-cli-default",
    command: "/usr/bin/codex",
    version: "test",
    model: "model-example",
    thinking: "low",
    provider,
    env,
  });
  const config = adapter.stateFiles["codex/config.toml"];
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /env_key = "EXAMPLE_API_KEY"/);
  assert.match(config, /model = "model-example"/);
  assert.ok(!adapter.args.includes("--ignore-user-config"));
  assert.ok(!config.includes("test-secret"));
  assert.equal(adapter.transport, "direct");
});

await test("OpenCode and OMP create secret-free custom provider definitions", () => {
  const opencode = makeAdapter({
    harness: "opencode-default",
    command: "/opt/opencode/bin/opencode",
    version: "test",
    model: "model-example",
    thinking: "low",
    provider,
    env,
  });
  assert.equal(opencode.model, "example-provider/model-example");
  assert.ok(!opencode.args.includes("--variant"));
  assert.match(opencode.env.OPENCODE_CONFIG_CONTENT, /\{env:EXAMPLE_API_KEY\}/);
  assert.ok(!opencode.env.OPENCODE_CONFIG_CONTENT.includes("test-secret"));

  const omp = makeAdapter({
    harness: "oh-my-pi-default",
    command: "/opt/user/.bun/install/omp.js",
    version: "test",
    model: "model-example",
    thinking: "low",
    provider,
    env,
  });
  assert.equal(omp.model, "example-provider/model-example");
  assert.match(omp.stateFiles["omp/models.yml"], /"apiKey": "EXAMPLE_API_KEY"/);
  assert.ok(!omp.stateFiles["omp/models.yml"].includes("test-secret"));
  assert.match(omp.env.PATH, /^\/opt\/user\/\.bun\/bin:/);
});
await test("DeepSeek Harness keeps Standard and Code Mode distinct", () => {
  const standard = makeAdapter({
    harness: "dsh-standard",
    command: "/usr/bin/dsh",
    version: "test",
    model: "model-example",
    thinking: "low",
    provider,
    env,
  });
  const code = makeAdapter({
    harness: "dsh-code",
    command: "/usr/bin/dsh",
    version: "test",
    model: "model-example",
    thinking: "low",
    provider,
    env,
  });
  assert.equal(standard.env.DSH_TOOLS_MODE, "native");
  assert.equal(code.env.DSH_TOOLS_MODE, "ptc");
  assert.equal(standard.env.DSH_TELEMETRY_MODE, "DISABLED");
  assert.equal(code.env.DSH_TELEMETRY_MODE, "DISABLED");
  assert.deepEqual(standard.stateArtifacts, { "dsh/sessions": "sessions" });
  assert.deepEqual(code.stateArtifacts, { "dsh/sessions": "sessions" });
  assert.equal(standard.promptStdin, true);
  assert.equal(code.promptStdin, true);
  assert.equal(standard.driver.command, "/usr/bin/node");
  assert.match(standard.driver.args[0], /dsh-sdk-runner\.mjs$/);
  assert.equal(standard.args[1], "sdk");
  const settings = JSON.parse(standard.stateFiles["dsh/settings.yaml"]);
  assert.equal(settings["agent-default-model"].provider, "example-provider");
  assert.equal(settings["agent-default-model"].model, "model-example");
  assert.equal(settings["llm-pi-ai"].providers["example-provider"].apiKeyEnv, "EXAMPLE_API_KEY");
  assert.ok(!standard.stateFiles["dsh/settings.yaml"].includes("test-secret"));
});

await test("DeepSeek Harness accepts a catalog OAuth route and copied credential store", () => {
  const adapter = makeAdapter({
    harness: "dsh-code",
    command: "/usr/bin/dsh",
    version: "test",
    model: "gpt-5.6-luna",
    thinking: "low",
    provider: { id: "openai-codex", catalog: true },
    authFile: "/opt/auth/dsh-credentials.yaml",
  });
  const settings = JSON.parse(adapter.stateFiles["dsh/settings.yaml"]);
  assert.deepEqual(settings["llm-pi-ai"].providers["openai-codex"], {});
  assert.equal(adapter.seedFiles["dsh/.credentials.yaml"], "/opt/auth/dsh-credentials.yaml");
  assert.equal(adapter.transport, "catalog-oauth");
});
await test("Pi OAuth credentials map to a DeepSeek Harness grant without changing the payload", () => {
  const credential = {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 123,
    accountId: "account",
  };
  const document = dshCredentialDocument({ "openai-codex": credential }, "openai-codex");
  assert.deepEqual(document.records["llm-pi-ai/openai-codex"], {
    kind: "grant",
    payload: credential,
  });
  assert.throws(() => dshCredentialDocument({}, "openai-codex"), /no transferable OAuth/);
});
await test("provider routes fail closed when endpoint or credential is missing", () => {
  assert.throws(() => resolveProviderRoute(provider, "responses", {}), /Missing EXAMPLE_API_KEY/);
  assert.throws(
    () => resolveProviderRoute({ ...provider, endpoints: {} }, "responses", env),
    /no valid responses endpoint/,
  );
});

await test("a prepared config lands in the system temp folder, not in the checkout", async () => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  assert.equal(path.basename(defaultConfigPath), "explicit-edit-benchmark-config.json");
  assert.ok(
    path.relative(repository, defaultConfigPath).startsWith(".."),
    "the default output has to stay outside the repository",
  );
  await rm(defaultConfigPath, { force: true });
  try {
    await promisify(execFile)(
      process.execPath,
      [
        path.join(repository, "scripts/prepare-benchmark.mjs"),
        "--harness",
        "pi-default",
        "--command",
        process.execPath,
        // prepare rejects a binary outside /usr unless its installation directory is declared.
        "--runtime",
        path.dirname(path.dirname(process.execPath)),
        "--model",
        "openai/gpt-5",
        "--thinking",
        "low",
      ],
      { cwd: repository },
    );
    // The default path is only real when writing it succeeds there.
    assert.ok((await stat(defaultConfigPath)).isFile());
  } finally {
    await rm(defaultConfigPath, { force: true });
  }
});

await test("every adapter knows which CLI it runs", () => {
  // Without this map the adapter name was used as the binary, so --harness codex-cli-default
  // looked for a binary called codex-cli-default.
  assert.deepEqual(Object.keys(ADAPTER_BINARIES).sort(), [...ADAPTER_IDS].sort());
  for (const [adapter, binary] of Object.entries(ADAPTER_BINARIES))
    assert.ok(binary && !binary.includes("-default"), `${adapter} must name a real binary`);
});

await test("a package is mounted with the dependencies installed beside it", () => {
  // The IDE extension imports cross-spawn, which npm installs next to the package, not inside it.
  assert.equal(dependencyRoot("/opt/app/node_modules/pi-agent-ide"), "/opt/app/node_modules");
  assert.equal(dependencyRoot("/opt/standalone-package"), "/opt/standalone-package");
});

await test("every seeded file an adapter needs exists in the repository", async () => {
  // A missing seed file only shows up when a run starts, so check the paths here instead.
  const { existsSync } = await import("node:fs");
  const { makeAdapter } = await import("../../scripts/prepare-benchmark.mjs");
  // The IDE adapter needs an installed package; it seeds nothing without --auth-file anyway.
  for (const harness of ADAPTER_IDS.filter((id) => id !== "pi-agent-ide")) {
    const adapter = makeAdapter({
      harness,
      command: "/usr/bin/tool",
      version: "test",
      model: "provider/model-example",
      thinking: "medium",
      ...(harness === "dsh-standard" || harness === "dsh-code"
        ? {
            provider: {
              id: "p",
              apiKeyEnv: "P_KEY",
              endpoints: { completions: "https://example.test" },
            },
            env: { P_KEY: "test" },
          }
        : {}),
    });
    for (const source of Object.values(adapter.seedFiles))
      assert.ok(existsSync(source), `${harness} seeds a missing file: ${source}`);
  }
});
