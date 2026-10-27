import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runMultiAgentBatch } from "../../scripts/run-multi-agent-batch.mjs";
import { RESTORING_MULTI_AGENT_PROTOCOL } from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";
import { MULTI_AGENT_BENCHMARK } from "../../src/suites/explicit-edit-multi-agent/results.mjs";

test("the common CLI cannot silently route an explicit restoring protocol into the legacy runner", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-harness-batch.mjs",
      "--suite",
      MULTI_AGENT_BENCHMARK,
      "--protocol",
      RESTORING_MULTI_AGENT_PROTOCOL,
      "--concurrency",
      "15",
      "--config",
      "missing-private-config.json",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESTORING_NATIVE_ENTRY_REQUIRED/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("the common batch API refuses a restoring label before reading preparation or credentials", async () => {
  await assert.rejects(
    runMultiAgentBatch({
      root: "unused-output",
      preparation: "missing-preparation",
      profiles: {},
      safeAdapters: {},
      protocol: RESTORING_MULTI_AGENT_PROTOCOL,
    }),
    { code: "ERR_ASSERTION" },
  );
});
