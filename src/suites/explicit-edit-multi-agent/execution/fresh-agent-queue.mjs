import assert from "node:assert/strict";

export const FRESH_AGENT_QUEUE_POLICY = Object.freeze({
  version: "renderer-fresh-agent-queue-v1",
  lifecycle: "new-agent-per-delivery-closed-after-it",
  assignment: "queue-order-next-free-slot",
  occupancy: "starting-running-and-closing-agents",
  failure: "stop-new-deliveries-and-drain-inflight",
});

export const PERSISTENT_AGENT_QUEUE_POLICY = Object.freeze({
  version: "renderer-persistent-agent-queue-v1",
  lifecycle: "one-agent-per-slot-kept-across-deliveries",
  replacement: "new-agent-after-a-timeout-or-closed-agent",
  assignment: "queue-order-next-free-slot",
  occupancy: "starting-running-and-closing-agents",
  failure: "stop-new-deliveries-and-drain-inflight",
});

export const AGENT_QUEUE_POLICIES = Object.freeze({
  "per-delivery": FRESH_AGENT_QUEUE_POLICY,
  persistent: PERSISTENT_AGENT_QUEUE_POLICY,
});
export const AGENT_LIFECYCLES = Object.freeze(Object.keys(AGENT_QUEUE_POLICIES));

/** Run items in queue order with at most maxAgents agents starting, running or
 * closing at once. A per-delivery queue starts a new agent for every item and
 * closes it afterwards. A persistent queue keeps each slot's agent for the next
 * item and replaces it only after a timed-out delivery or when it has closed.
 * The executor owns the delivery deadline and must settle when the signal aborts
 * or its driver closes. A failure stops new deliveries; deliveries already
 * running finish before the first failure is rethrown. Every created driver is
 * closed before this returns; onClosed receives the agent's last item and result
 * and the number of deliveries it took.
 */
export async function runAgentQueue(
  items,
  {
    lifecycle = "per-delivery",
    maxAgents,
    createDriver,
    execute,
    onClosed = async () => {},
    signal,
  },
) {
  assert.ok(Array.isArray(items));
  assert.ok(AGENT_LIFECYCLES.includes(lifecycle), `Unknown agent lifecycle ${lifecycle}`);
  assert.ok(Number.isSafeInteger(maxAgents) && maxAgents > 0);
  for (const callback of [createDriver, execute, onClosed])
    assert.equal(typeof callback, "function");
  const persistent = lifecycle === "persistent";
  /** @type {any[]} */
  const results = Array.from({ length: items.length }, () => null);
  const state = { failure: /** @type {Error | null} */ (null) };
  const fail = (error) => {
    state.failure ??=
      error instanceof Error ? error : new Error("Agent delivery failed", { cause: error });
  };
  let next = 0,
    session = 0,
    live = 0,
    maxLive = 0;
  async function close(driver) {
    if (!driver || driver.closed === true) return;
    const stop = driver.terminate ?? driver.close;
    assert.equal(typeof stop, "function");
    await stop.call(driver);
    assert.equal(driver.closed, true, "Agent shutdown was not confirmed");
  }
  async function retire(agent) {
    try {
      await close(agent.driver);
      await onClosed(agent.driver, agent.item, agent.result, agent.deliveries);
    } catch (error) {
      fail(error);
    } finally {
      live--;
    }
  }
  async function slot() {
    /** @type {any} */
    let agent = null;
    try {
      for (;;) {
        if (agent && (!persistent || agent.replace || agent.driver?.closed === true)) {
          await retire(agent);
          agent = null;
        }
        if (state.failure || next >= items.length || signal?.aborted) return;
        const index = next++,
          item = items[index];
        if (!agent) {
          agent = { driver: undefined, session: ++session, deliveries: 0, replace: false };
          live++;
          maxLive = Math.max(maxLive, live);
        }
        const result = {
          index,
          session: agent.session,
          status: "starting",
          started: new Date().toISOString(),
        };
        results[index] = result;
        Object.assign(agent, { item, result, deliveries: agent.deliveries + 1 });
        try {
          agent.driver ??= await createDriver(item, agent.session, { signal });
          result.status = "running";
          const outcome = await execute(agent.driver, item, {
            index,
            session: agent.session,
            signal,
          });
          result.status = outcome?.status ?? "settled";
          if (outcome?.receipt !== undefined) result.receipt = outcome.receipt;
          if (result.status === "timed-out") agent.replace = true;
        } catch (error) {
          result.status = "error";
          result.error = { name: error?.name, message: error?.message };
          fail(error);
        } finally {
          result.ended = new Date().toISOString();
        }
      }
    } finally {
      if (agent) await retire(agent);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxAgents, items.length) }, slot));
  if (state.failure) throw state.failure;
  signal?.throwIfAborted();
  return { results, maxLive, agents: session };
}

/** Run every item with its own newly started agent; see runAgentQueue. */
export function runFreshAgentQueue(items, options) {
  return runAgentQueue(items, { ...options, lifecycle: "per-delivery" });
}
