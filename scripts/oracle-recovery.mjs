/** Return verifier diagnostics without exposing expected text or a corrective diff. */
export function oracleFeedback(comparison, execution = {}) {
  const diagnostics = {
    passed: false,
    exactMatch: comparison.exactMatch === true,
    differingFiles: comparison.differingFiles ?? [],
    missingFiles: comparison.missingFiles ?? [],
    unexpectedFiles: comparison.unexpectedFiles ?? [],
    timedOut: execution.timedOut === true,
    exitCode: execution.exitCode ?? null,
  };
  return `The verifier did not pass. Continue in the current workspace and correct the result according to the original request. The following diagnostics do not include expected content.\n${JSON.stringify(diagnostics, null, 2)}`;
}

/** Run one session with a bounded number of verifier-guided continuations.
 * The caller owns session persistence, workspace snapshots and attempt artifacts.
 * An exception is an infrastructure failure, never a fresh-session fallback.
 */
export async function recoverWithOracle({ recoveries, run, verify, record }) {
  if (!Number.isInteger(recoveries) || recoveries < 0)
    throw Error("Invalid oracle recovery budget");
  const attempts = [];
  let feedback;
  for (let attempt = 0; attempt <= recoveries; attempt++) {
    const execution = await run({ attempt, feedback });
    const comparison = await verify();
    const passed =
      execution.exitCode === 0 &&
      !execution.timedOut &&
      !(execution.terminalEventErrors ?? execution.errors?.length) &&
      comparison.exactMatch === true;
    const result = { attempt, execution, comparison, passed };
    await record(result);
    attempts.push(result);
    if (passed) break;
    feedback = oracleFeedback(comparison, execution);
  }
  return {
    mode: "oracle-recovery",
    firstAttemptPassed: attempts[0].passed,
    eventuallyPassed: attempts.at(-1).passed,
    recoveriesUsed: attempts.length - 1,
    exhausted: !attempts.at(-1).passed,
    attempts,
  };
}
