import assert from "node:assert/strict";
import test from "node:test";
import { runRestoring } from "../../src/suites/explicit-edit-multi-agent/execution/restoring-run.mjs";

test("measured execution cannot change delivery sizing through reference-only options", async () => {
  await assert.rejects(
    runRestoring("missing-preparation", "missing-output", {
      configPath: "private-config-never-read.json",
      proofPath: "proof-never-read.json",
      allowModelCalls: true,
      batchSize: 10,
      referenceBatchSize: 100,
    }),
    { code: "ERR_ASSERTION" },
  );
});

test("invalid reference delivery limits fail before preparation or participants", async () => {
  for (const referenceBatchSize of [0, -1, 1.5, null, "100", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      runRestoring("missing-preparation", "missing-output", { referenceBatchSize }),
      { code: "ERR_ASSERTION" },
    );
  }
});
