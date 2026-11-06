import assert from "node:assert/strict";

export const FRESH_AGENT_QUEUE_POLICY = Object.freeze({
  version: "renderer-fresh-agent-queue-v1",
  lifecycle: "new-agent-per-delivery-closed-after-it",
  assignment: "queue-order-next-free-slot",
  occupancy: "starting-running-and-closing-agents",
  failure: "stop-new-deliveries-and-drain-inflight",
});

/** Run every item with its own newly started agent, in queue order, with at most
 * maxAgents agents starting, running or closing at once. The executor owns the
 * delivery deadline and must settle when the signal aborts or its driver closes.
 * A failure stops new deliveries; deliveries already running finish before the
 * first failure is rethrown. Every created driver is closed before this returns.
 */
export async function runFreshAgentQueue(
  items,
  { maxAgents, createDriver, execute, onClosed = async () => {}, signal },
) {
  assert.ok(Array.isArray(items));
  assert.ok(Number.isSafeInteger(maxAgents) && maxAgents > 0);
  for (const callback of [createDriver, execute, onClosed]) assert.equal(typeof callback, "function");
  const results = Array.from({ length: items.length }, () => null);
  let next = 0,
    session = 0,
    live = 0,
    maxLive = 0,
    failure = null;
  async function close(driver) {
    if (!driver || driver.closed === true) return;
    const stop = driver.terminate ?? driver.close;
    assert.equal(typeof stop, "function");
    await stop.call(driver);
    assert.equal(driver.closed, true, "Agent shutdown was not confirmed");
  }
  async function slot() {
    while (!failure && next < items.length && !signal?.aborted) {
      const index = next++,
        id = ++session,
        item = items[index];
      const result = { index, session: id, status: "starting", started: new Date().toISOString() };
      results[index] = result;
      let driver;
      live++;
      maxLive = Math.max(maxLive, live);
      try {
        driver = await createDriver(item, id, { signal });
        result.status = "running";
        const outcome = await execute(driver, item, { index, session: id, signal });
        result.status = outcome?.status ?? "settled";
        if (outcome?.receipt !== undefined) result.receipt = outcome.receipt;
      } catch (error) {
        result.status = "error";
        result.error = { name: error?.name, message: error?.message };
        failure ??= error;
      } finally {
        try {
          await close(driver);
          await onClosed(driver, item, result);
        } catch (error) {
          failure ??= error;
        }
        result.ended = new Date().toISOString();
        live--;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxAgents, items.length) }, slot));
  if (failure) throw failure;
  signal?.throwIfAborted();
  return { results, maxLive };
}
