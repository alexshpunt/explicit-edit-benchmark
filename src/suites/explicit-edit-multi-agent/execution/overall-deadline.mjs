/** Start the grouped profile's hard deadline before initial grading. Shorter limits
 * support real runtime checks; no caller can raise the limit past one hour.
 * Closing clears only the timer. Child owners must honor signal and close in finally.
 */
export function overallDeadline(signal, milliseconds = 3_600_000) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3_600_000)
    throw Error("Overall limit must be positive and no more than 60 minutes");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Overall time limit reached", "TimeoutError")),
    milliseconds,
  );
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    close: () => clearTimeout(timer),
  };
}

/** Distinguish a deadline from an explicit user cancellation. */
export function abortStatus(signal) {
  return signal?.reason?.name === "TimeoutError" ? "timeout" : "cancelled";
}
