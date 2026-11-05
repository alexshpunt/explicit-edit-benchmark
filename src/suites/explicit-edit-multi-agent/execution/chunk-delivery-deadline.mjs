import assert from "node:assert/strict";

export const CHUNK_DELIVERY_DEADLINE_MS = 120_000;

/** Execute one admitted delivery. Provider admission must happen before calling
 * this function, so provider cooldown is not charged to agent execution.
 * A timeout retires the participant; no retry or replacement is performed.
 */
export async function executeChunkDelivery(
  driver,
  prompt,
  { signal, timeoutMs = CHUNK_DELIVERY_DEADLINE_MS, retire } = {},
) {
  assert.equal(typeof driver?.execute, "function");
  assert.ok(typeof driver.terminate === "function" || typeof driver.close === "function");
  assert.equal(typeof prompt, "string");
  assert.ok(retire === undefined || typeof retire === "function");
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  signal?.throwIfAborted();
  const timeout = new AbortController();
  const deadline = new Error("Chunk delivery deadline reached");
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const cancelled = Promise.withResolvers();
  const abort = () => cancelled.resolve({ type: "cancelled", reason: combined.reason });
  combined.addEventListener("abort", abort, { once: true });
  if (combined.aborted) abort();
  const timer = setTimeout(() => timeout.abort(deadline), timeoutMs);
  const work = Promise.resolve()
    .then(() => {
      combined.throwIfAborted();
      return driver.execute(prompt, { signal: combined, completion: "turn" });
    })
    .then(
      (receipt) => ({ type: "settled", receipt }),
      (error) => ({ type: "failed", error }),
    );
  try {
    const outcome = await Promise.race([work, cancelled.promise]);
    if (outcome.type === "settled") return { status: "settled", receipt: outcome.receipt };
    if (outcome.type === "failed") throw outcome.error;
    if (retire) await retire();
    else if (driver.terminate) await driver.terminate();
    else await driver.close();
    await work;
    if (driver.closed !== true)
      throw Object.assign(new Error("Participant shutdown was not confirmed"), {
        code: "CHUNK_SHUTDOWN_UNCONFIRMED",
      });
    if (outcome.reason === deadline) return { status: "timed-out" };
    throw outcome.reason;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", abort);
  }
}
