import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineBenchmarkConfig, defineHarness } from "../../scripts/benchmark-config.mjs";
import { dependencyRoot } from "../../scripts/prepare-benchmark.mjs";
import { inspectTimelineFile } from "./timeline.mjs";

/**
 * Example: benchmark a harness that orchestrates other agents.
 *
 * bb is an agent IDE. It runs Claude Code, Codex, Pi, or OpenCode in threads, on a server
 * it starts on the same machine. Like any other harness it gets a prompt and edits the
 * workspace; the difference is that one command cannot express it, so a driver script turns
 * the prompt into a thread and prints the timeline the parser reads.
 *
 * Read the settings below, install bb once, then run a smoke task:
 *
 *   npm install --prefix /opt/bb bb-app
 *   BB_APP=/opt/bb/node_modules/bb-app BB_PROVIDER=codex BB_MODEL=... \
 *   BB_AGENT_AUTH=$HOME/.codex/auth.json BB_VERSION=0.43.1 BB_AGENT_VERSION=0.153.4 \
 *   npm run benchmark -- check --config examples/bb/benchmark.config.mjs
 *
 * Set BB_AGENT_MODELS instead of BB_AGENT_AUTH when Pi uses a self-contained private models.json.
 * If Node is installed outside /usr, set BB_NODE_RUNTIME to the directory containing its bin/.
 *
 * Run bb one trial at a time: `--concurrency 1`. By default every trial starts its own bb server,
 * machine daemon, and agent. A sequential run can reuse an externally started server by setting
 * BB_SERVER_URL; every trial still gets its own daemon, machine, sandbox, and thread. Several
 * concurrent trials compete for the machine and produce failures unrelated to the task.
 *
 * A bb trial also needs more time than the default, because the server has to come up before the
 * agent starts: `--concurrency 1 --timeout-seconds 900`. Against bb 0.43.1 a smoke task passed in
 * about 40 seconds idle.
 *
 * Identity comes from the environment, because these versions are facts about your machine
 * and the benchmark must not guess them. `bb updates status --json` reports the bb version
 * and each provider's CLI version.
 *
 * bb also reads the provider's own global configuration. With `BB_PROVIDER=pi` it picks up
 * the Pi extensions you have installed, and the result is then a mix of bb and those
 * extensions. Run a bare provider, or isolate its home, when you want a clean bb family.
 */

const bbApp = process.env.BB_APP;
const nodeRuntime = process.env.BB_NODE_RUNTIME;
const provider = process.env.BB_PROVIDER ?? "pi";
const serverUrl = process.env.BB_SERVER_URL;
const modelsFile = process.env.BB_AGENT_MODELS;
const transport = process.env.BB_TRANSPORT;
const harnessVersion = process.env.BB_VERSION;
const agentVersion = process.env.BB_AGENT_VERSION;
const agentFamilyOverride = process.env.BB_AGENT_FAMILY;

/** bb provider id to the agent family this benchmark publishes. Extend it for your provider. */
const PROVIDER_AGENT = {
  pi: "pi",
  codex: "codex-cli",
  "claude-code": "claude-code",
  "acp-opencode": "opencode",
  "acp-cursor": "cursor-agent",
};

/** Credentials bb and the provider read, and where the sandbox has to carry them. */
const PROVIDER_AUTH = {
  pi: "home/.pi/agent/auth.json",
  codex: "home/.codex/auth.json",
  "claude-code": "home/.claude/.credentials.json",
};

const agentFamily = agentFamilyOverride ?? PROVIDER_AGENT[provider];
const authDestination = PROVIDER_AUTH[provider];
const authFile = process.env.BB_AGENT_AUTH;

if (!bbApp) throw Error("BB_APP must point at an installed bb-app package");
if (!harnessVersion) throw Error("BB_VERSION must be the bb version from `bb updates status`");
if (!agentVersion) throw Error("BB_AGENT_VERSION must be the provider CLI version bb reports");
if (!agentFamily)
  throw Error(`Set BB_AGENT_FAMILY for bb provider ${provider}, or extend PROVIDER_AGENT`);
if (modelsFile && provider !== "pi")
  throw Error("BB_AGENT_MODELS is only supported by the bb Pi provider");
if ((!authFile || !authDestination) && !modelsFile)
  throw Error(
    `Set BB_AGENT_AUTH for bb provider ${provider}, or BB_AGENT_MODELS for a self-contained model catalog`,
  );

const bb = defineHarness({
  createAdapter({ model }) {
    const selectedModel = model.selectors?.bb;
    if (!selectedModel) throw Error("Model has no bb selector");
    return {
      kind: "bb",
      // The sandbox runs the driver, so the driver has to travel with the state directory.
      command: process.execPath,
      args: ["/state/bb/driver.mjs"],
      // One long-running driver per trial: it starts bb once and keeps the thread for recovery.
      driver: { command: process.execPath, args: ["/state/bb/driver.mjs"], persistent: true },
      // The published version is bb's own, so ask bb instead of asking Node.
      versionArgs: [path.join(bbApp, "dist/bb.js"), "--version"],
      // The harness version falls back to this CLI version, because they are the same build.
      version: harnessVersion,
      agentFamily,
      agentVersion,
      modelFamily: model.family,
      modelVersion: model.version,
      provider: model.provider ?? null,
      transport: transport ?? null,
      harnessFamily: "bb",
      adapterVersion: serverUrl ? "shared-server-1" : "1",
      configurationLabels: [
        `harness/bb`,
        `provider/${provider}`,
        ...(model.provider ? [`route/${model.provider}`] : []),
        `server/${serverUrl ? "shared" : "per-trial"}`,
      ],
      configurationId: `bb/${provider}/${model.provider ?? "direct"}/${serverUrl ? "shared-server" : "per-trial"}`,
      configuration: {
        tools: [`bb@${harnessVersion}`],
        extensions: [],
        rules: [],
        runtimeFlags: [
          `thinking=${model.thinking}`,
          "environment-provider=project-checkout",
          `server=${serverUrl ? "shared" : "per-trial"}`,
        ],
        environment: ["BB_APP", "BB_MODEL", "BB_PROVIDER", ...(serverUrl ? ["BB_SERVER_URL"] : [])],
      },
      model: selectedModel,
      thinking: model.thinking,
      ready: false,
      readOnly: [dependencyRoot(bbApp), ...(nodeRuntime ? [nodeRuntime] : [])],
      seedFiles: {
        "bb/driver.mjs": fileURLToPath(new URL("./driver.mjs", import.meta.url)),
        ...(authFile && authDestination ? { [authDestination]: authFile } : {}),
        ...(modelsFile ? { "home/.pi/agent/models.json": modelsFile } : {}),
      },
      env: {
        BB_APP: bbApp,
        BB_DATA_DIR: "/state/bb",
        BB_WORKSPACE: "/workspace",
        BB_PROVIDER: provider,
        BB_MODEL: selectedModel,
        BB_REASONING: model.thinking,
        ...(serverUrl ? { BB_SERVER_URL: serverUrl } : {}),
        ...(nodeRuntime ? { PATH: `${nodeRuntime}/bin:/usr/local/bin:/usr/bin:/bin` } : {}),
      },
    };
  },
  inspectOutput: inspectTimelineFile,
  continueSession(adapter) {
    // The driver keeps running and tells the same thread, so the adapter does not change.
    return adapter;
  },
});

export default defineBenchmarkConfig({
  models: {
    gpt: {
      family: process.env.BB_MODEL_FAMILY ?? "gpt-5.6-luna",
      version: process.env.BB_MODEL_VERSION ?? "gpt-5.6-luna",
      provider: process.env.BB_MODEL_PROVIDER ?? "openai-codex",
      thinking: process.env.BB_THINKING ?? "low",
      selectors: { bb: process.env.BB_MODEL ?? "" },
    },
  },
  harnesses: { bb },
  selection: { matrix: [{ models: ["gpt"], harnesses: ["bb"] }], pairs: [] },
});
