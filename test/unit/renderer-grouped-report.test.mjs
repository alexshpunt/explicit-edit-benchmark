import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { groupedReport } from "../../scripts/multi-agent/experiments/grouped-report.mjs";

test("offline list reports count accepted operations separately from deliveries and keep timeouts honest", async () => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(".tmp/grouped-report-");
  try {
    const requests = [{ id: "one" }, { id: "two" }, { id: "three" }];
    const lists = [{ requests: requests.slice(0, 2) }, { requests: requests.slice(2) }];
    const report = {
      version: "renderer-full-grouped-hour-v1",
      profile: "grouped-hour",
      status: "timeout",
      policy: { trialTimeoutMs: 3600000 },
      elapsedMs: 3600100,
      usage: null,
      agentClosed: true,
      terminal: { id: "list-002", category: "timeout", message: "private compiler output" },
      chain: {
        passedBatches: 1,
        passedRequests: 2,
        deliveries: [
          { repair: false, requestIds: ["one", "two"] },
          { repair: true, requestIds: [] },
          { repair: false, requestIds: ["three"] },
        ],
      },
    };
    const save = (file, value) => writeFile(path.join(directory, file), JSON.stringify(value));
    await save("requests.json", requests);
    await save("lists.json", lists);
    await save("report.json", report);
    const summary = await groupedReport(directory);
    assert.equal(summary.status, "timeout");
    assert.equal(summary.passedOperations, 2);
    assert.equal(summary.deliveredOperations, 3);
    assert.equal(summary.originalListDeliveries, 2);
    assert.equal(summary.repairDeliveries, 1);
    assert.equal(summary.totalModelDeliveries, 3);
    assert.equal(summary.usage, null);
    assert.doesNotMatch(
      await readFile(path.join(directory, "summary.md"), "utf8"),
      /private compiler output/,
    );
    report.status = "pass";
    report.chain.passedBatches = 2;
    report.chain.passedRequests = 3;
    await save("report.json", report);
    await assert.rejects(groupedReport(directory), /late completion/i);
    report.elapsedMs = 1200;
    await save("report.json", report);
    assert.equal((await groupedReport(directory)).passedOperations, 3);
    report.chain.passedRequests = 2;
    await save("report.json", report);
    await assert.rejects(groupedReport(directory), assert.AssertionError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
