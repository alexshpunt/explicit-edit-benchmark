import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { officialSmokeDiagnostic } from "../../scripts/official-smoke-diagnostic.mjs";

async function fixture(result, comparison, stderr = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "official-smoke-test-"));
  const trial = path.join(root, "trials", "replace-all-10-plain__r01__pi-agent-ide");
  await mkdir(path.join(trial, "agent"), { recursive: true });
  await writeFile(path.join(trial, "result.json"), JSON.stringify(result));
  if (comparison !== null)
    await writeFile(path.join(trial, "comparison.json"), JSON.stringify(comparison));
  await writeFile(path.join(trial, "agent", "stderr.log"), stderr);
  return root;
}

test("reports auth failure without exposing stderr, paths or error text", async () => {
  const root = await fixture(
    {
      exitCode: 1,
      timedOut: false,
      modelRounds: 0,
      toolCalls: 0,
      eventCount: 0,
      error: "secret-token-in-exception",
      errors: ["secret-token-in-model-event"],
    },
    null,
    "401 unauthorized bearer secret-token-in-stderr /private/agent/path",
  );
  try {
    const result = await officialSmokeDiagnostic(root, "pi-agent-ide");
    assert.deepEqual(result, {
      kind: "authentication",
      exitCode: 1,
      timedOut: false,
      modelRounds: 0,
      toolCalls: 0,
      events: 0,
      agentErrors: 1,
      exactMatch: null,
    });
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies a Pi message_end provider error without leaking its contents", async () => {
  const root = await fixture(
    {
      exitCode: 0,
      timedOut: false,
      modelRounds: 1,
      toolCalls: 0,
      errors: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "401 unauthorized: secret-provider-token",
          },
        },
      ],
    },
    { exactMatch: false },
  );
  try {
    const report = await officialSmokeDiagnostic(root, "pi-agent-ide");
    assert.equal(report.kind, "authentication");
    assert.equal(report.agentErrors, 1);
    assert.equal(JSON.stringify(report).includes("secret-provider-token"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("classifies a missing runtime module without copying its private path", async () => {
  const root = await fixture(
    { exitCode: 1, timedOut: false, modelRounds: 0 },
    null,
    "ERR_MODULE_NOT_FOUND: cannot find module /private/runtime/secret.js",
  );
  try {
    assert.equal((await officialSmokeDiagnostic(root, "pi-agent-ide")).kind, "missing-module");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("distinguishes wrong edits from failed process and missing comparison", async () => {
  const root = await fixture(
    { exitCode: 0, timedOut: false, modelRounds: 1, toolCalls: 2, eventCount: 4, errors: [] },
    { exactMatch: false, diff: "sensitive source" },
  );
  try {
    assert.equal((await officialSmokeDiagnostic(root, "pi-agent-ide")).kind, "incorrect-edit");
    await assert.rejects(officialSmokeDiagnostic(root, "../secrets"), /Invalid smoke profile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const failed = await fixture({ exitCode: 2, timedOut: false, error: "private failure" }, null);
  try {
    assert.equal((await officialSmokeDiagnostic(failed, "pi-agent-ide")).kind, "process-failed");
  } finally {
    await rm(failed, { recursive: true, force: true });
  }
});
