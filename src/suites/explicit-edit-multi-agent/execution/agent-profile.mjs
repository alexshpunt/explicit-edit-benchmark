import assert from "node:assert/strict";

/** Explicit flags override the private run config. Legacy calls retain their
 * exact persistent identity; a selected profile binds lifetime and worker cap.
 */
export function restoringAgentProfile(options = {}, config = {}, agents = 1) {
  const {
    agentLifecycle: configuredLifecycle,
    maxConcurrentAgents: configuredCap,
    ...baseline
  } = config;
  const selected =
    options.agentLifecycle !== undefined ||
    options.maxConcurrentAgents !== undefined ||
    configuredLifecycle !== undefined ||
    configuredCap !== undefined;
  const agentLifecycle =
    options.agentLifecycle !== undefined
      ? options.agentLifecycle
      : configuredLifecycle !== undefined
        ? configuredLifecycle
        : "persistent";
  assert.ok(["persistent", "per-delivery"].includes(agentLifecycle), "Invalid agent lifecycle");
  const maxConcurrentAgents =
    options.maxConcurrentAgents !== undefined
      ? options.maxConcurrentAgents
      : configuredCap !== undefined
        ? configuredCap
        : agentLifecycle === "per-delivery"
          ? 30
          : agents;
  assert.ok(
    Number.isSafeInteger(maxConcurrentAgents) && maxConcurrentAgents > 0,
    "Invalid concurrent agent limit",
  );
  return {
    selected,
    agentLifecycle,
    maxConcurrentAgents,
    size:
      agentLifecycle === "per-delivery"
        ? maxConcurrentAgents
        : Math.min(agents, maxConcurrentAgents),
    baseline,
  };
}
