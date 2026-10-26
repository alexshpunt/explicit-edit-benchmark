import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectHarnessOutput } from "../../scripts/harness-runtime.mjs";
import { recoverWithOracle } from "../../scripts/oracle-recovery.mjs";

const failure = (errorMessage = "Temporary fixture transport failure") => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "error", errorMessage },
});
const response = (stopReason) => ({
  type: "message_end",
  message: { role: "assistant", stopReason },
});
const start = (attempt = 1) => ({ type: "auto_retry_start", attempt, maxAttempts: 3 });
const end = (success) => ({ type: "auto_retry_end", success, attempt: 2 });
const settled = [{ type: "agent_end" }, { type: "agent_settled" }];
const recovered = () => [
  failure(),
  start(),
  failure("Another transient fixture failure"),
  start(2),
  response("toolUse"),
  end(true),
  { type: "tool_execution_start", toolName: "bash" },
  { type: "tool_execution_end", isError: false },
  response("stop"),
  ...settled,
];
async function inspect(t, events, kind = "baseline-agent") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-retry-metrics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "stdout.jsonl");
  await writeFile(file, events.map(JSON.stringify).join("\n") + "\n");
  return inspectHarnessOutput(kind, file);
}

for (const kind of ["baseline-agent", "pi-default", "pi-agent-ide", "oh-my-pi-default"]) {
  test(`${kind} keeps recovered transport errors observable without treating them as terminal`, async (t) => {
    const metrics = await inspect(t, recovered(), kind);
    assert.equal(metrics.errors.length, 2);
    assert.equal(metrics.terminalEventErrors, 0);
    assert.equal(metrics.toolCalls, 1);
    assert.equal(metrics.modelRounds, 4);
  });
}
/** @type {Array<[string, object[], number]>} */
const failureCases = [
  ["terminal error without a retry", [failure(), ...settled], 1],
  ["exhausted retry", [failure(), start(), failure(), end(false), ...settled], 2],
  ["interrupted retry", [failure(), start()], 1],
  ["unmatched recovery marker", [failure(), response("stop"), end(true), ...settled], 1],
  ["recovery marker without a successful response", [failure(), start(), end(true), ...settled], 1],
  [
    "unfinished tool continuation",
    [failure(), start(), response("toolUse"), end(true), ...settled],
    1,
  ],
  ["missing final settlement", [failure(), start(), response("stop"), end(true)], 1],
  ["later terminal error", [...recovered(), failure(), ...settled], 1],
  [
    "aborted settlement",
    [...recovered().slice(0, -2), { type: "agent_end" }, { type: "agent_settled", aborted: true }],
    2,
  ],
  [
    "exhaustion followed by unrelated success",
    [failure(), start(), end(false), response("stop"), ...settled],
    1,
  ],
  ["unrelated earlier error", [failure(), response("stop"), ...recovered()], 1],
];
for (const [name, events, count] of failureCases) {
  test(`Pi still rejects ${name}`, async (t) => {
    const metrics = await inspect(t, events);
    assert.equal(metrics.terminalEventErrors, count);
    assert.ok(metrics.errors.length >= count);
  });
}

test("native recovery does not spend the benchmark correction budget", async (t) => {
  const metrics = await inspect(t, recovered());
  const result = await recoverWithOracle({
    recoveries: 5,
    run: async () => ({ exitCode: 0, timedOut: false, ...metrics }),
    verify: async () => ({ exactMatch: true }),
    record: async () => {},
  });
  assert.equal(result.firstAttemptPassed, true);
  assert.equal(result.recoveriesUsed, 0);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].execution.errors.length, 2);
});

test("recovery never overrides an incorrect workspace, timeout or nonzero exit", async (t) => {
  const metrics = await inspect(t, recovered());
  for (const [execution, exactMatch] of [
    [{ exitCode: 0, timedOut: false }, false],
    [{ exitCode: 0, timedOut: true }, true],
    [{ exitCode: 1, timedOut: false }, true],
  ]) {
    const result = await recoverWithOracle({
      recoveries: 0,
      run: async () => ({ ...metrics, ...execution }),
      verify: async () => ({ exactMatch }),
      record: async () => {},
    });
    assert.equal(result.eventuallyPassed, false);
  }
});

test("legacy execution errors remain fatal without explicit recovery metrics", async () => {
  const result = await recoverWithOracle({
    recoveries: 0,
    run: async () => ({ exitCode: 0, errors: [failure()] }),
    verify: async () => ({ exactMatch: true }),
    record: async () => {},
  });
  assert.equal(result.eventuallyPassed, false);
});
