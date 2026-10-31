import assert from "node:assert/strict";
import timers from "node:timers/promises";

export const PROVIDER_RECOVERY_POLICY = Object.freeze({
  version: "renderer-provider-recovery-v1",
  cooldownMs: 60000,
  mode: "pause-new-deliveries-and-single-session-probe",
  terminalFailure: "stop-new-requests-and-drain-inflight",
});

/** Hard account refusals override retryable wrappers such as server_error. */
export function isTerminalProviderError(message) {
  if (typeof message !== "string") return false;
  return (
    /^(?:401|402|403)\b/.test(message) ||
    /\b(?:API error|HTTP(?: error)?|status(?:[_ ]code)?)\s*["':(=\s]*(?:401|402|403)\b/i.test(
      message,
    ) ||
    /\b(?:insufficient_quota|billing_hard_limit_reached|credit_balance_too_low|quota_exhausted|GoUsageLimitError|FreeUsageLimitError)\b/i.test(
      message,
    ) ||
    /\b(?:insufficient|not enough)\s+(?:account\s+)?(?:funds|credits?|balance)\b/i.test(message) ||
    /\bcredit balance\s+(?:is\s+)?(?:too low|exhausted)\b/i.test(message) ||
    /\bexceeded your current quota\b/i.test(message) ||
    /\bfree usage exceeded\b/i.test(message) ||
    /\b(?:daily|monthly)\s+(?:usage\s+)?(?:quota|limit)\s+(?:exceeded|exhausted)\b/i.test(message)
  );
}

/** Admit a delivery before any native execution or receipt exists. */
export async function admitProviderDelivery(recovery, options) {
  try {
    await recovery.admit(options);
  } catch (error) {
    // The shared stop reason may acquire the originating session's receipt later.
    const failure = new Error(error?.message ?? String(error), { cause: error });
    failure.name = error?.name ?? failure.name;
    failure.category = error?.category;
    throw failure;
  }
}

/**
 * Coordinate held native sessions without cancelling healthy work or replaying assignments.
 * @param {{ cooldownMs?: number, onEvent?: (event: { type: string, atMs: number, [key: string]: unknown }) => void }} [options]
 */
export function createProviderRecovery({
  cooldownMs = PROVIDER_RECOVERY_POLICY.cooldownMs,
  onEvent = () => {},
} = {}) {
  assert.ok(
    Number.isSafeInteger(cooldownMs) && cooldownMs > 0 && cooldownMs <= 2147483647,
    "Provider cooldown must be a positive timer-safe integer",
  );
  assert.equal(typeof onEvent, "function", "Provider recovery observer must be a function");
  const paused = new Set();
  const admissions = new Set();
  const resumed = Object.freeze({ complete() {} });
  /** @type {{ phase: string, failure: Error | null }} */
  const status = { phase: "ready", failure: null };
  let probe;
  let timer;

  function assertActive(signal) {
    signal?.throwIfAborted();
    if (status.failure !== null) throw status.failure;
  }

  function emit(type, extra = {}) {
    onEvent({ type, atMs: Date.now(), ...extra });
  }

  function clearTimer() {
    const previous = timer;
    timer = undefined;
    previous?.controller.abort();
  }

  function detach(entry) {
    entry.signal?.removeEventListener("abort", entry.abort);
  }

  function fault(error, extra = []) {
    if (status.failure === null)
      status.failure = error instanceof Error ? error : new Error(String(error));
    clearTimer();
    for (const entry of [...paused, ...admissions, ...(probe ? [probe] : []), ...extra]) {
      detach(entry);
      entry.reject(status.failure);
    }
    paused.clear();
    admissions.clear();
    probe = undefined;
  }

  function ready(cause) {
    clearTimer();
    status.phase = "ready";
    const waiting = [...paused];
    const admitted = [...admissions];
    paused.clear();
    admissions.clear();
    if (probe) detach(probe);
    probe = undefined;
    for (const entry of [...waiting, ...admitted]) detach(entry);
    try {
      emit("provider_recovery_ready", { cause });
    } catch (error) {
      fault(error, [...waiting, ...admitted]);
      throw error;
    }
    for (const entry of waiting)
      if (entry.signal?.aborted) entry.reject(entry.signal.reason);
      else entry.resolve(resumed);
    for (const entry of admitted)
      if (entry.signal?.aborted) entry.reject(entry.signal.reason);
      else entry.resolve();
  }

  function coolDown(metadata, cause) {
    clearTimer();
    status.phase = "cooldown";
    const current = { controller: new AbortController() };
    timer = current;
    emit("provider_recovery_cooldown", {
      ...metadata,
      cause,
      cooldownMs,
      readyAtMs: Date.now() + cooldownMs,
    });
    timers
      .setTimeout(cooldownMs, undefined, { signal: current.controller.signal })
      .then(() => {
        if (timer !== current || status.failure !== null) return;
        timer = undefined;
        issueProbe();
      })
      .catch((error) => {
        if (timer !== current && current.controller.signal.aborted) return;
        fault(error);
      });
  }

  function issueProbe() {
    const entry = paused.values().next().value;
    if (!entry) {
      ready("no-paused-participants");
      return;
    }
    paused.delete(entry);
    status.phase = "probe";
    probe = entry;
    const lease = {
      complete(success) {
        if (probe !== entry || status.failure !== null) return;
        assert.equal(typeof success, "boolean");
        detach(entry);
        probe = undefined;
        try {
          if (success) ready("probe-succeeded");
          else {
            coolDown(entry.metadata, "probe-failed");
            // The same delivery may immediately requeue after another exhausted
            // native retry cycle. Do not open admission between those two calls.
            queueMicrotask(() => {
              if (
                status.failure === null &&
                status.phase === "cooldown" &&
                !probe &&
                !paused.size
              ) {
                try {
                  ready("no-paused-participants");
                } catch (error) {
                  fault(error);
                }
              }
            });
          }
        } catch (error) {
          fault(error);
          throw error;
        }
      },
    };
    emit("provider_recovery_probe", entry.metadata);
    if (probe === entry) entry.resolve(lease);
  }

  function cancellation(entry) {
    const wasProbe = probe === entry;
    paused.delete(entry);
    admissions.delete(entry);
    detach(entry);
    entry.reject(entry.signal.reason);
    if (wasProbe) probe = undefined;
    try {
      if (wasProbe && paused.size) coolDown(entry.metadata, "probe-cancelled");
      else if (status.phase !== "ready" && !probe && !paused.size) ready("no-paused-participants");
    } catch (error) {
      fault(error);
    }
  }

  function pending(signal, metadata = undefined) {
    const entry = { ...Promise.withResolvers(), signal, metadata, abort: undefined };
    entry.abort = () => cancellation(entry);
    signal?.addEventListener("abort", entry.abort, { once: true });
    return entry;
  }

  return {
    /** Stop future requests after a terminal failure, without cancelling in-flight work. */
    stop(error) {
      if (status.failure !== null) return;
      const reason = error instanceof Error ? error.message : String(error);
      fault(error);
      emit("provider_recovery_stopped", { reason });
    },
    /** Admission does not own or cancel requests that were already in flight. */
    async admit({ signal } = {}) {
      assertActive(signal);
      while (status.phase !== "ready") {
        const entry = pending(signal);
        admissions.add(entry);
        await entry.promise;
        assertActive(signal);
      }
    },
    /**
     * A granted probe lease remains live until completion, cancellation or a new failure.
     * @param {{ signal?: AbortSignal, sessionId?: string, lifetime?: string, reason?: unknown }} [request]
     * @returns {Promise<{ complete: (success: boolean) => void }>}
     */
    async wait({ signal, sessionId, lifetime, reason } = {}) {
      assertActive(signal);
      const entry = pending(signal, { sessionId, lifetime, reason });
      paused.add(entry);
      try {
        if (status.phase === "ready") coolDown(entry.metadata, "retryable-provider-failure");
      } catch (error) {
        fault(error);
      }
      return entry.promise;
    },
  };
}
