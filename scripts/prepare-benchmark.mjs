import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveCanonicalModel } from "./model-registry.mjs";
import { ADAPTERS, ADAPTER_BINARIES, ADAPTER_IDS } from "./adapter-registry.mjs";
export { ADAPTERS, ADAPTER_BINARIES, ADAPTER_IDS } from "./adapter-registry.mjs";

/** Default output of a prepared adapter, in the system temp folder, so it never lands in the checkout. */
export const defaultConfigPath = path.join(os.tmpdir(), "explicit-edit-benchmark-config.json");

/** Absolute extension entries a package declares, or null when the nearest package declares none. */
function declaredExtensionsFor(entry) {
  let directory = path.dirname(path.resolve(entry));
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const entries = JSON.parse(readFileSync(manifestPath, "utf8"))?.pi?.extensions;
      return Array.isArray(entries) && entries.length
        ? entries.map((value) => path.resolve(directory, value))
        : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Read the entry, version and mount of an installed IDE package, so the adapter loads the
 * published package instead of a hand-picked file inside a checkout.
 */
export function resolveIdePackage(directory) {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "package.json");
  if (!existsSync(manifestPath)) throw Error(`IDE package has no package.json: ${root}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entries = manifest?.pi?.extensions;
  if (!Array.isArray(entries) || entries.length !== 1)
    throw Error(`IDE package must declare exactly one pi.extensions entry: ${root}`);
  const entry = path.resolve(root, entries[0]);
  if (!existsSync(entry)) throw Error(`IDE extension entry is missing: ${entry}`);
  return { directory: root, entry, version: String(manifest.version ?? "") };
}

/**
 * Fail loudly when an IDE entry is not the extension its package declares. A barrel file
 * that re-exports one module loads a smaller tool surface than the package intends.
 */
function assertDeclaredIdeEntry(entry) {
  const absolute = path.resolve(entry);
  if (!existsSync(absolute)) throw Error(`IDE entry does not exist: ${absolute}`);
  const declared = declaredExtensionsFor(absolute);
  if (declared && !declared.includes(absolute))
    throw Error(
      `IDE entry is not declared by its package: ${absolute}\nDeclared entries: ${declared.join(", ")}`,
    );
}

/**
 * A package loads its dependencies from the tree that holds it. Mounting only the package
 * directory leaves them behind, so a mount has to cover the whole `node_modules` tree.
 */
export function dependencyRoot(packageDirectory) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = packageDirectory.indexOf(marker);
  return index < 0 ? packageDirectory : packageDirectory.slice(0, index + marker.length - 1);
}

/** Resolve and validate a provider route without exposing its credential value. */
export function resolveProviderRoute(provider, protocol, env) {
  if (!provider || typeof provider !== "object")
    throw Error(`A provider route is required for ${protocol}`);
  if (!/^[a-z0-9-]+$/.test(provider.id ?? "")) throw Error("Invalid provider id");
  if (!/^[A-Z][A-Z0-9_]+$/.test(provider.apiKeyEnv ?? ""))
    throw Error("Invalid provider apiKeyEnv");
  const baseUrl = provider.endpoints?.[protocol];
  if (typeof baseUrl !== "string" || !URL.canParse(baseUrl))
    throw Error(`Provider has no valid ${protocol} endpoint`);
  const apiKey = env[provider.apiKeyEnv];
  if (typeof apiKey !== "string" || !apiKey) throw Error(`Missing ${provider.apiKeyEnv}`);
  return { ...provider, baseUrl, apiKey };
}

/** Keep the runtime harness kind separate from the matrix profile name. */
export function resolveProfileName(harness, profileName) {
  const name = profileName ?? harness;
  if (!/^[a-z0-9-]+$/.test(name ?? "")) throw Error("Invalid profile name");
  return name;
}
function codexConfig(provider, model, thinking, env) {
  const route = resolveProviderRoute(provider, "responses", env);
  const lines = [
    `model = ${JSON.stringify(model)}`,
    'web_search = "disabled"',
    `model_provider = ${JSON.stringify(route.id)}`,
    ...(route.codexReasoningEffort ? [`model_reasoning_effort = ${JSON.stringify(thinking)}`] : []),
    "",
    `[model_providers.${route.id}]`,
    `name = ${JSON.stringify(route.displayName ?? route.id)}`,
    `base_url = ${JSON.stringify(route.baseUrl)}`,
    `env_key = ${JSON.stringify(route.apiKeyEnv)}`,
    'wire_api = "responses"',
    "",
  ];
  return { route, text: lines.join("\n") };
}

function dshSettings(provider, model, thinking, env) {
  if (provider?.catalog === true) {
    if (!/^[a-z0-9-]+$/.test(provider.id ?? "")) throw Error("Invalid catalog provider id");
    return {
      route: { id: provider.id },
      text:
        JSON.stringify(
          {
            "agent-default-model": {
              provider: provider.id,
              model,
              reasoningEffort: thinking,
            },
            "llm-pi-ai": { providers: { [provider.id]: {} } },
          },
          null,
          2,
        ) + "\n",
    };
  }
  const route = resolveProviderRoute(provider, "completions", env);
  const selection = {
    provider: route.id,
    model,
    ...(route.dshReasoningEffort ? { reasoningEffort: thinking } : {}),
  };
  return {
    route,
    text:
      JSON.stringify(
        {
          "agent-default-model": selection,
          "llm-pi-ai": {
            providers: {
              [route.id]: {
                apiKeyEnv: route.apiKeyEnv,
                api: "openai-completions",
                baseURL: route.baseUrl,
                models: [
                  {
                    id: model,
                    name: model,
                    contextWindow: provider.contextWindow ?? 262144,
                    maxTokens: provider.maxTokens ?? 32768,
                    reasoningEfforts: route.dshReasoningEffort
                      ? { low: "low", high: "high", max: "max" }
                      : false,
                  },
                ],
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
  };
}

function ompSettings(provider, model, thinking, env) {
  const route = resolveProviderRoute(provider, "completions", env);
  const originalCompat = provider.compat ?? {};
  const compat = {
    ...(typeof originalCompat.supportsStore === "boolean"
      ? { supportsStore: originalCompat.supportsStore }
      : {}),
    ...(typeof originalCompat.supportsDeveloperRole === "boolean"
      ? { supportsDeveloperRole: originalCompat.supportsDeveloperRole }
      : {}),
    ...(typeof originalCompat.supportsReasoningEffort === "boolean"
      ? { supportsReasoningEffort: originalCompat.supportsReasoningEffort }
      : {}),
    ...(originalCompat.maxTokensField ? { maxTokensField: originalCompat.maxTokensField } : {}),
    ...(originalCompat.thinkingFormat
      ? {
          thinkingFormat:
            originalCompat.thinkingFormat === "deepseek" ? "openai" : originalCompat.thinkingFormat,
        }
      : {}),
    ...(originalCompat.thinkingFormat === "deepseek"
      ? {
          reasoningContentField: "reasoning_content",
          requiresReasoningContentForToolCalls: true,
        }
      : {}),
  };
  return {
    route,
    text:
      JSON.stringify(
        {
          providers: {
            [route.id]: {
              baseUrl: route.baseUrl,
              apiKey: route.apiKeyEnv,
              api: "openai-completions",
              compat,
              models: [
                {
                  id: model,
                  name: model,
                  reasoning: true,
                  thinking: {
                    mode: "effort",
                    efforts: ["low", "high", "max"],
                    defaultLevel: thinking,
                  },
                  input: ["text"],
                  contextWindow: provider.contextWindow ?? 262144,
                  maxTokens: provider.maxTokens ?? 32768,
                },
              ],
            },
          },
        },
        null,
        2,
      ) + "\n",
  };
}
const AFT_DISABLED_TOOLS = ["aft_move", "aft_delete"];
const AFT_TOOLS = [
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "bash",
  "bash_status",
  "bash_watch",
  "bash_write",
  "bash_kill",
  "aft_outline",
  "aft_zoom",
  "aft_search",
  "aft_callgraph",
  "aft_inspect",
  "aft_import",
  "aft_safety",
  "aft_conflicts",
  "ast_grep_search",
  "ast_grep_replace",
  "lsp_diagnostics",
];
const AFT_BENCHMARK_CONFIG = Object.freeze({
  edit_mode: "default",
  format_on_edit: false,
  validate_on_edit: "syntax",
  disabled_tools: AFT_DISABLED_TOOLS,
  indexes: { trigram: true, semantic: false, callgraph: true },
  lsp: { auto_install: false },
  bash: { enabled: true, rewrite: false, compress: false, background: false },
  github: { shim: false, read: false, write: false },
  git: { co_author: "off" },
});

function canonicalIdentity({
  harness,
  canonicalModel,
  thinking,
  version,
  provider,
  providerId,
  harnessVersion,
}) {
  const agentFamily = ADAPTERS[harness]?.agentFamily;
  if (!agentFamily)
    throw Error(`Unsupported adapter: ${harness}. Use one of: ${ADAPTER_IDS.join(", ")}`);
  if (ADAPTERS[harness]?.extensionPackage && !harnessVersion)
    throw Error(`The ${harness} adapter requires --harness-version for its installed extension`);
  const exactVersion = String(version).split(/\r?\n/, 1)[0];
  return {
    agentFamily,
    harnessFamily: harness,
    agentVersion: exactVersion,
    modelFamily: canonicalModel,
    modelVersion: canonicalModel,
    provider: providerId,
    harnessVersion: harnessVersion ?? exactVersion,
    adapterVersion: "1",
    configurationLabels: [`harness/${harness}`],
    configurationId: `${harness}/default`,
    configuration: {
      tools:
        harness === "baseline-agent"
          ? ["bash"]
          : harness === "pi-agent-ide"
            ? ["pi-agent-ide"]
            : harness === "pi-aft"
              ? AFT_TOOLS
              : ["default"],
      extensions:
        harness === "baseline-agent"
          ? ["pi-baseline-agent@1"]
          : harness === "pi-agent-ide"
            ? [`pi-agent-ide@${harnessVersion}`]
            : harness === "pi-aft"
              ? [`@cortexkit/aft-pi@${harnessVersion}`]
              : [],
      rules: harness === "pi-aft" ? [`aft-workflow-hints@${harnessVersion}`] : [],
      runtimeFlags: [
        `thinking=${thinking}`,
        ...(harness === "pi-aft"
          ? [
              "edit-mode=default",
              "semantic-index=false",
              "lsp-auto-install=false",
              "bash-rewrite=false",
              "bash-compress=false",
              "bash-background=false",
            ]
          : []),
      ],
      environment: provider?.apiKeyEnv ? [provider.apiKeyEnv] : [],
    },
  };
}
/** Build a native CLI adapter. Credentials are supplied explicitly and stay local. */
export function makeAdapter({
  harness,
  command,
  model,
  thinking,
  authFile,
  modelFile,
  idePackage,
  runtime = [],
  provider,
  env = {},
  version,
}) {
  if (!model || !thinking) throw Error("Explicit --model and --thinking are required");
  const base = {
    kind: harness,
    command,
    version,
    model,
    thinking,
    transport: provider?.transport ?? "harness-native",
    ready: false,
    readOnly: [...runtime, ...(idePackage ? [dependencyRoot(path.resolve(idePackage))] : [])],
    seedFiles: {},
    env: {},
  };
  const auth = (destination) => (authFile ? { [destination]: path.resolve(authFile) } : {});
  switch (harness) {
    case "pi-default":
    case "baseline-agent":
    case "pi-agent-ide":
    case "pi-aft": {
      if (ADAPTERS[harness]?.extensionPackage && !idePackage)
        throw Error(`${harness} requires --ide-package for the installed package`);
      const installed = idePackage ? resolveIdePackage(idePackage) : null;
      if (installed) assertDeclaredIdeEntry(installed.entry);
      return {
        ...base,
        args: [
          "--model",
          model,
          "--thinking",
          thinking,
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          ...(harness === "baseline-agent"
            ? ["--tools", "bash", "--extension", "/state/runner/pi-baseline-agent.mjs"]
            : []),
          "--session-dir",
          "/state/pi/sessions",
          "--mode",
          "json",
          "-p",
          ...(installed ? ["--extension", installed.entry] : []),
          "--",
          "{prompt}",
        ],
        env: {
          ...env,
          PI_CODING_AGENT_DIR: "/state/pi",
          ...(["pi-agent-ide", "pi-aft"].includes(harness) ? { SHELL: "/bin/bash" } : {}),
          ...(harness === "pi-aft"
            ? {
                AFT_STORAGE_DIR: "/state/aft/storage",
                AFT_CACHE_DIR: "/state/aft/cache",
                XDG_CONFIG_HOME: "/state/home/.config",
              }
            : {}),
        },
        seedFiles: {
          ...auth("pi/auth.json"),
          ...(harness === "baseline-agent"
            ? {
                "runner/pi-baseline-agent.mjs": fileURLToPath(
                  new URL("./pi-baseline-agent.mjs", import.meta.url),
                ),
              }
            : {}),
          ...(modelFile ? { "pi/models.json": path.resolve(modelFile) } : {}),
        },
        ...(harness === "pi-aft"
          ? {
              stateFiles: {
                "home/.config/cortexkit/aft.jsonc":
                  JSON.stringify(AFT_BENCHMARK_CONFIG, null, 2) + "\n",
              },
            }
          : {}),
      };
    }
    case "codex-cli-default": {
      if (!provider) {
        return {
          ...base,
          args: [
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "-m",
            model,
            "-c",
            `model_reasoning_effort=${JSON.stringify(thinking)}`,
            "--json",
            "{prompt}",
          ],
          env: { ...env, CODEX_HOME: "/state/codex" },
          seedFiles: auth("codex/auth.json"),
        };
      }
      const configured = codexConfig(provider, model, thinking, env);
      return {
        ...base,
        transport: provider.transport ?? "direct-responses",
        args: [
          "exec",
          "--ignore-rules",
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
          "--json",
          "{prompt}",
        ],
        env: { ...env, CODEX_HOME: "/state/codex" },
        stateFiles: { "codex/config.toml": configured.text },
      };
    }
    case "opencode-default": {
      const route = provider ? resolveProviderRoute(provider, "completions", env) : undefined;
      const selectedModel = route ? `${route.id}/${model}` : model;
      return {
        ...base,
        model: selectedModel,
        ...(route ? { transport: provider.transport ?? "direct-completions" } : {}),
        args: [
          "run",
          "--pure",
          "--dangerously-skip-permissions",
          "--model",
          selectedModel,
          ...(route && !provider.opencodeReasoningVariant ? [] : ["--variant", thinking]),
          "--format",
          "json",
          "{prompt}",
        ],
        env: {
          ...env,
          XDG_DATA_HOME: "/state/data",
          XDG_CONFIG_HOME: "/state/config",
          XDG_CACHE_HOME: "/state/cache",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: "allow",
            share: "disabled",
            autoupdate: false,
            ...(route
              ? {
                  provider: {
                    [route.id]: {
                      npm: "@ai-sdk/openai-compatible",
                      name: route.displayName ?? route.id,
                      options: {
                        baseURL: route.baseUrl,
                        apiKey: `{env:${route.apiKeyEnv}}`,
                      },
                      models: { [model]: { name: model } },
                    },
                  },
                }
              : {}),
          }),
        },
        seedFiles: route ? {} : auth("data/opencode/auth.json"),
      };
    }
    case "oh-my-pi-default": {
      const configured = provider ? ompSettings(provider, model, thinking, env) : undefined;
      const selectedModel = configured ? `${configured.route.id}/${model}` : model;
      const bunRoot = command.includes("/.bun/")
        ? command.slice(0, command.indexOf("/.bun/") + "/.bun".length)
        : undefined;
      return {
        ...base,
        model: selectedModel,
        ...(configured ? { transport: provider.transport ?? "direct-completions" } : {}),
        args: [
          "--model",
          selectedModel,
          "--thinking",
          thinking,
          "--no-title",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--auto-approve",
          "--mode",
          "json",
          "-p",
          "{prompt}",
        ],
        env: {
          ...env,
          ...(bunRoot ? { PATH: `${bunRoot}/bin:/usr/local/bin:/usr/bin:/bin` } : {}),
          PI_CODING_AGENT_DIR: "/state/omp",
        },
        seedFiles: {
          ...auth("omp/agent.db"),
          ...(!configured && modelFile ? { "omp/models.yml": path.resolve(modelFile) } : {}),
        },
        ...(configured ? { stateFiles: { "omp/models.yml": configured.text } } : {}),
      };
    }
    case "github-copilot-cli-default": {
      if (!provider) {
        return {
          ...base,
          args: [
            "--model",
            model,
            "--stream",
            "on",
            "--no-custom-instructions",
            "--disable-builtin-mcps",
            "--no-auto-update",
            "--no-ask-user",
            "--yolo",
            "--output-format",
            "json",
            "-p",
            "{prompt}",
          ],
          env: { ...env },
          seedFiles: auth("home/.copilot/config.json"),
        };
      }
      const wireApi = provider.copilotWireApi ?? "completions";
      if (!["completions", "responses"].includes(wireApi))
        throw Error(`Unsupported Copilot wire API: ${wireApi}`);
      const route = resolveProviderRoute(provider, wireApi, env);
      const copilotModelId = provider.copilotModelId ?? model;
      const headers = provider.copilotHeadersEnv ? env[provider.copilotHeadersEnv] : undefined;
      if (provider.copilotHeadersEnv && !headers)
        throw Error(`Missing ${provider.copilotHeadersEnv}`);
      for (const [name, value] of [
        ["copilotMaxPromptTokens", provider.copilotMaxPromptTokens],
        ["copilotMaxOutputTokens", provider.copilotMaxOutputTokens],
      ]) {
        if (value !== undefined && (!Number.isInteger(value) || value <= 0))
          throw Error(`${name} must be a positive integer`);
      }
      return {
        ...base,
        transport: provider.transport ?? `direct-${wireApi}`,
        args: [
          "--model",
          copilotModelId,
          ...(provider.copilotReasoningEffort ? ["--effort", thinking] : []),
          "--stream",
          "on",
          "--no-custom-instructions",
          "--disable-builtin-mcps",
          "--no-auto-update",
          "--no-ask-user",
          "--yolo",
          "--output-format",
          "json",
          "-p",
          "{prompt}",
        ],
        env: {
          ...env,
          COPILOT_OFFLINE: "true",
          COPILOT_MODEL: copilotModelId,
          COPILOT_PROVIDER_MODEL_ID: copilotModelId,
          COPILOT_PROVIDER_WIRE_MODEL: model,
          ...(provider.copilotMaxPromptTokens
            ? { COPILOT_PROVIDER_MAX_PROMPT_TOKENS: String(provider.copilotMaxPromptTokens) }
            : {}),
          ...(provider.copilotMaxOutputTokens
            ? { COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: String(provider.copilotMaxOutputTokens) }
            : {}),
          COPILOT_PROVIDER_TYPE: "openai",
          COPILOT_PROVIDER_WIRE_API: wireApi,
          COPILOT_PROVIDER_BASE_URL: route.baseUrl,
          ...(provider.copilotCredentialType === "bearer"
            ? { COPILOT_PROVIDER_BEARER_TOKEN: route.apiKey }
            : { COPILOT_PROVIDER_API_KEY: route.apiKey }),
          ...(headers ? { COPILOT_PROVIDER_HEADERS: headers } : {}),
        },
      };
    }
    case "dsh-standard":
    case "dsh-code": {
      const configured = dshSettings(provider, model, thinking, env);
      return {
        ...base,
        transport:
          provider.transport ?? (provider.catalog ? "catalog-oauth" : "direct-completions"),
        args: ["--profile", "sdk"],
        promptStdin: true,
        driver: {
          command: "/usr/bin/node",
          persistent: true,
          args: ["/state/runner/dsh-sdk-runner.mjs", command, configured.route.id, model, thinking],
        },
        env: {
          ...env,
          DSH_HOME: "/state/dsh",
          DSH_TELEMETRY_MODE: "DISABLED",
          DSH_TOOLS_MODE: harness === "dsh-code" ? "ptc" : "native",
        },
        seedFiles: {
          "runner/dsh-sdk-runner.mjs": fileURLToPath(
            new URL("./dsh-sdk-runner.mjs", import.meta.url),
          ),
          ...auth("dsh/.credentials.yaml"),
        },
        stateFiles: { "dsh/settings.yaml": configured.text },
        stateArtifacts: { "dsh/sessions": "sessions" },
      };
    }
    default: {
      throw Error(`Unsupported adapter: ${harness}. Use one of: ${ADAPTER_IDS.join(", ")}`);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      harness: { type: "string" },
      "profile-name": { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      command: { type: "string" },
      "auth-file": { type: "string" },
      "model-file": { type: "string" },
      "provider-file": { type: "string" },
      "env-file": { type: "string" },
      "ide-package": { type: "string" },
      "harness-version": { type: "string" },
      runtime: { type: "string", multiple: true },
      output: { type: "string", default: defaultConfigPath },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      `Prepare a trusted local config: --harness ${ADAPTER_IDS.join("|")} [--profile-name MATRIX_NAME] --model MODEL --thinking LEVEL [--command CLI] [--auth-file FILE] [--model-file FILE] [--env-file JSON] [--provider-file JSON] [--ide-package DIR] [--runtime DIRECTORY ...] [--output FILE]. No login, updates or model calls are performed.`,
    );
    return;
  }
  if (!values.harness) throw Error("--harness is required");
  const binary = values.command ?? ADAPTER_BINARIES[values.harness];
  if (!binary)
    throw Error(`No known binary for ${values.harness}; pass --command for the CLI to run`);
  const command = await realpath(
    binary.includes("/") ? binary : execFileSync("which", [binary], { encoding: "utf8" }).trim(),
  );
  const runtime = (values.runtime ?? []).map((p) => path.resolve(p));
  if (!command.startsWith("/usr/") && !runtime.some((p) => command.startsWith(p + path.sep)))
    throw Error(
      "Executable is outside /usr. Supply --runtime for its installation directory (never your whole home or eval checkout).",
    );
  const env = values["env-file"] ? JSON.parse(await readFile(values["env-file"], "utf8")) : {};
  if (
    !env ||
    Array.isArray(env) ||
    typeof env !== "object" ||
    Object.values(env).some((v) => typeof v !== "string")
  )
    throw Error("--env-file must contain a JSON object of string values");
  const provider = values["provider-file"]
    ? JSON.parse(await readFile(values["provider-file"], "utf8"))
    : undefined;

  if (values["ide-package"]) {
    const installed = resolveIdePackage(values["ide-package"]);
    if (installed.version !== values["harness-version"])
      throw Error(
        `Pi extension package version ${installed.version} does not match --harness-version ${values["harness-version"]}`,
      );
  }
  const providerId =
    provider?.id ??
    (values.model.includes("/") ? values.model.slice(0, values.model.indexOf("/")) : "unknown");
  const selector = values.model.includes("/")
    ? values.model.slice(values.model.indexOf("/") + 1)
    : values.model;
  const { canonicalModel } = await resolveCanonicalModel(providerId, selector);
  const runtimeAdapter = makeAdapter({
    harness: values.harness,
    model: values.model,
    thinking: values.thinking,
    command,
    version: execFileSync(command, ["--version"], { encoding: "utf8" }).trim(),
    authFile: values["auth-file"],
    modelFile: values["model-file"],
    idePackage: values["ide-package"],
    runtime,
    env,
    provider,
  });
  const adapter = {
    ...runtimeAdapter,
    ...canonicalIdentity({
      harness: values.harness,
      canonicalModel: canonicalModel.id,
      thinking: values.thinking,
      version: runtimeAdapter.version,
      provider,
      harnessVersion: values["harness-version"],
      providerId,
    }),
  };
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await writeFile(
    values.output,
    JSON.stringify(
      { harnesses: { [resolveProfileName(values.harness, values["profile-name"])]: adapter } },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Prepared ${values.output}. Run --smoke with one task; inspect effective model/settings before setting ready=true. Credentials were not printed or changed.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
