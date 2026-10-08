/**
 * The one canonical registry for every benchmark execution transport.
 * Versions and credentials are run inputs; this registry only describes stable adapter behavior.
 */
export const ADAPTERS = Object.freeze({
  "pi-default": {
    agentFamily: "pi",
    binary: "pi",
    package: "@earendil-works/pi-coding-agent",
    credential: "pi",
    repositoryUrl: "https://github.com/earendil-works/pi",
  },
  "baseline-agent": {
    agentFamily: "pi",
    binary: "pi",
    package: "@earendil-works/pi-coding-agent",
    credential: "pi",
    repositoryUrl: "https://github.com/earendil-works/pi",
  },
  "pi-agent-ide": {
    agentFamily: "pi",
    binary: "pi",
    package: "@earendil-works/pi-coding-agent",
    extensionPackage: "pi-agent-ide",
    credential: "pi",
    repositoryUrl: "https://github.com/alexshpunt/pi-agent-ide",
  },
  "pi-aft": {
    agentFamily: "pi",
    binary: "pi",
    package: "@earendil-works/pi-coding-agent",
    extensionPackage: "@cortexkit/aft-pi",
    credential: "pi",
    repositoryUrl: "https://github.com/cortexkit/aft",
  },
  "codex-cli-default": {
    agentFamily: "codex-cli",
    binary: "codex",
    package: "@openai/codex",
    credential: "codex",
    repositoryUrl: "https://github.com/openai/codex",
  },
  "opencode-default": {
    agentFamily: "opencode",
    binary: "opencode",
    package: "opencode-ai",
    credential: "opencode",
    repositoryUrl: "https://github.com/anomalyco/opencode",
  },
  "oh-my-pi-default": {
    agentFamily: "oh-my-pi",
    binary: "omp",
    package: "@oh-my-pi/pi-coding-agent",
    credential: "omp",
    runtimePackage: "@oven/bun-linux-x64",
    repositoryUrl: "https://github.com/can1357/oh-my-pi",
  },
  "github-copilot-cli-default": {
    agentFamily: "github-copilot-cli",
    binary: "copilot",
    package: "@github/copilot",
    credential: "copilot",
    repositoryUrl: "https://github.com/github/copilot-cli",
  },
  "dsh-standard": {
    agentFamily: "deepseek-harness",
    binary: "dsh",
    package: "@deepseek-ai/dsh",
    credential: "dsh",
    repositoryUrl: "https://github.com/deepseek-ai/deepseek-harness",
  },
  "dsh-code": {
    agentFamily: "deepseek-harness",
    binary: "dsh",
    package: "@deepseek-ai/dsh",
    credential: "dsh",
    repositoryUrl: "https://github.com/deepseek-ai/deepseek-harness",
  },
});

export const ADAPTER_IDS = Object.freeze(Object.keys(ADAPTERS));
export const ADAPTER_BINARIES = Object.freeze(
  Object.fromEntries(Object.entries(ADAPTERS).map(([id, adapter]) => [id, adapter.binary])),
);

/** Return one adapter or reject unknown input before installation or model calls. */
export function adapterDefinition(id) {
  const adapter = ADAPTERS[id];
  if (!adapter) throw Error(`Unsupported adapter: ${id}. Use one of: ${ADAPTER_IDS.join(", ")}`);
  return adapter;
}
