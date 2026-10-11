import { GradeFailure } from "../grading/failure.mjs";
import { abortStatus } from "./overall-deadline.mjs";

/** A terminal agent failure, distinct from an editable candidate failure. */
export class ExecutionFailure extends Error {
  constructor(category, message) {
    super(message);
    if (!["provider_failure", "driver_exit"].includes(category))
      throw Error("Unknown execution failure");
    this.category = category;
  }
}

/** Deliver one request at a time against one evolving workspace. Trusted callbacks
 * own isolation and must honor the supplied abort signal. Candidate grade failures
 * get the configured number of corrections; runtime/infrastructure stops never consume repairs.
 * Set either time limit to null to disable that deadline. External cancellation
 * remains active even when both deadlines are disabled.
 * The report retains all attempts, failed edits and the later unattempted suffix.
 */
export async function runRequestChain(
  steps,
  {
    execute,
    grade,
    identity,
    save = async () => {},
    log = () => {},
    signal,
    attemptTimeoutMs = /** @type {number | null} */ (600_000),
    trialTimeoutMs = /** @type {number | null} */ (7_200_000),
    oracleRecoveries = 2,
    feedbackMode = "detailed",
  },
) {
  if (
    (attemptTimeoutMs !== null &&
      (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs <= 0)) ||
    (trialTimeoutMs !== null && (!Number.isSafeInteger(trialTimeoutMs) || trialTimeoutMs <= 0))
  )
    throw new Error("Expected positive finite time limits, or null to disable a deadline");
  if (!Number.isSafeInteger(oracleRecoveries) || oracleRecoveries < 0 || oracleRecoveries > 3)
    throw new Error("Oracle recoveries must be between 0 and 3");
  if (!["coarse", "detailed"].includes(feedbackMode)) throw new Error("Unknown feedback mode");
  const maxAttempts = oracleRecoveries + 1;
  const coarseFeedback = {
    build: "The project does not build.",
    behavior: "The rendered images do not match.",
    structure: "The batch requirements are not met.",
  };
  const report = {
    version: "renderer-request-chain-v1",
    policy: { oracleRecoveries, feedbackMode },
    status: "running",
    passedPrefix: 0,
    usage: null,
    attempts: [],
    steps: steps.map((step) => ({ id: step.id, status: "unattempted" })),
  };
  const started = performance.now();
  const stopped = (kind, record, message) => {
    report.status = kind;
    report.terminal = { id: record?.id ?? null, category: kind, message };
    if (record) {
      record.status = kind;
      report.steps[record.index].status = kind;
    }
  };
  await save(report);
  for (const [index, step] of steps.entries()) {
    if (signal?.aborted) {
      stopped(abortStatus(signal), null, signal.reason?.message ?? "Trial cancelled");
      break;
    }
    let feedback;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining =
        trialTimeoutMs === null ? Infinity : trialTimeoutMs - (performance.now() - started);
      if (remaining <= 0) {
        stopped("timeout", null, "Trial time limit reached");
        break;
      }
      const controller = new AbortController();
      const currentSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const attemptLimit = Math.min(attemptTimeoutMs ?? Infinity, remaining);
      const timer = Number.isFinite(attemptLimit)
        ? setTimeout(() => controller.abort(new Error("Attempt time limit reached")), attemptLimit)
        : undefined;
      const prompt = feedback
        ? `${step.prompt}\n\n${feedbackMode === "coarse" ? coarseFeedback[feedback.category] : `Previous attempt failed [${feedback.category}]: ${feedback.message}`}\nCorrect the current workspace. Keep earlier changes and satisfy the current request.`
        : step.prompt;
      const record = {
        id: step.id,
        index,
        attempt,
        status: "running",
        prompt,
        before: await identity(),
      };
      report.attempts.push(record);
      report.steps[index].status = "running";
      await save(report);
      let phase = "execute";
      try {
        log(`EDIT ${step.id}: attempt ${attempt}/${maxAttempts}`);
        const executingStarted = performance.now();
        try {
          record.execution = await execute({ prompt, index, attempt, signal: currentSignal });
        } finally {
          record.executeMs = performance.now() - executingStarted;
        }
        currentSignal.throwIfAborted();
        phase = "grade";
        const gradingStarted = performance.now();
        try {
          record.grade = await grade({ index, attempt, signal: currentSignal });
        } finally {
          record.graderMs = performance.now() - gradingStarted;
        }
        if (record.grade?.status !== "pass")
          throw new GradeFailure("infrastructure", "Grader did not return a verified pass");
        currentSignal.throwIfAborted();
        record.status = "pass";
        report.steps[index].status = "pass";
        report.passedPrefix++;
        log(`PASS ${step.id}: attempt ${attempt}/${maxAttempts}`);
      } catch (error) {
        if (error.execution) record.execution = error.execution;
        if (currentSignal.aborted) {
          stopped(
            signal?.aborted ? abortStatus(signal) : "timeout",
            record,
            signal?.aborted
              ? (signal.reason?.message ?? "Trial cancelled")
              : "Attempt or trial time limit reached",
          );
        } else if (
          phase === "grade" &&
          error instanceof GradeFailure &&
          ["build", "behavior", "structure"].includes(error.category)
        ) {
          feedback = { category: error.category, message: error.message };
          record.status = "fail";
          record.grade = feedback;
          log(`FAIL ${step.id}: attempt ${attempt}/${maxAttempts} [${error.category}]`);
          if (attempt === maxAttempts) {
            report.status = "blocked";
            report.steps[index].status = "blocked";
            report.terminal = { id: step.id, category: "blocked", failure: feedback };
          }
        } else {
          stopped(
            error instanceof ExecutionFailure
              ? error.category
              : phase === "execute" && !(error instanceof GradeFailure)
                ? "driver_exit"
                : "infrastructure",
            record,
            error.message,
          );
        }
      } finally {
        clearTimeout(timer);
        record.after = await identity();
        await save(report);
      }
      if (record.status === "pass" || report.status !== "running") break;
    }
    if (report.status !== "running") break;
  }
  if (report.status === "running") report.status = "pass";
  await save(report);
  return report;
}
