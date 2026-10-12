import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { submissionMetadata } from "../../scripts/benchmark-submit.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_VERSION,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { tempDirectory } from "../helpers/temp.mjs";

test("submission identifies the first public Multi-Agent release and rejects other protocols", async (t) => {
  const root = await tempDirectory("team-submission-identity-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      runId: "example",
      contract: MULTI_AGENT_PROTOCOL,
      suite: { id: MULTI_AGENT_BENCHMARK, protocol: MULTI_AGENT_PROTOCOL },
      taskSetSha256: "a".repeat(64),
    }),
  );
  await writeFile(path.join(root, "profiles.jsonl"), "");
  await writeFile(
    path.join(root, "trials.jsonl"),
    JSON.stringify({ taskId: "round-001", taskIds: ["task-001", "task-002"] }),
  );
  const metadata = await submissionMetadata(root, "example");
  assert.equal(MULTI_AGENT_VERSION, "1");
  assert.equal(metadata.definitions.benchmark.version, "1");
  assert.equal(metadata.definitions.benchmark.contract, "shared-project-rotating-v1");
  assert.deepEqual(metadata.definitions.taskSet.taskIds, ["task-001", "task-002"]);
  for (const protocol of ["shared-project-rotating-v2", "unknown-team-protocol"]) {
    await writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ contract: protocol, suite: { id: MULTI_AGENT_BENCHMARK, protocol } }),
    );
    await assert.rejects(submissionMetadata(root, "example"), /Unsupported Multi-Agent protocol/);
  }
});
