import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Rebuild list and atomic-operation counts from retained evidence, without models
 * or grading. Missing usage stays unknown. No prompts, diagnostics or machine paths
 * are copied into the summary. This is a view of saved receipts, not a fresh proof.
 */
export async function groupedReport(directory) {
  const json = async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const report = await json("report.json"),
    lists = await json("lists.json"),
    requests = await json("requests.json");
  assert.ok(
    ["renderer-full-grouped-hour-v1", "renderer-full-grouped-scripted-v1"].includes(report.version),
  );
  assert.deepEqual(
    lists.flatMap((list) => list.requests.map((request) => request.id)),
    requests.map((request) => request.id),
  );
  assert.equal(new Set(requests.map((request) => request.id)).size, requests.length);
  const chain = report.chain;
  const passedLists = chain?.passedBatches ?? 0;
  assert.ok(Number.isSafeInteger(passedLists) && passedLists >= 0 && passedLists <= lists.length);
  const passedRequests = lists
    .slice(0, passedLists)
    .reduce((sum, list) => sum + list.requests.length, 0);
  if (chain) assert.equal(chain.passedRequests, passedRequests);
  const deliveries = chain?.deliveries ?? [];
  const originals = deliveries.filter((delivery) => !delivery.repair);
  const deliveredRequests = originals.reduce(
    (sum, delivery) => sum + delivery.requestIds.length,
    0,
  );
  for (const [index, delivery] of originals.entries())
    assert.deepEqual(
      delivery.requestIds,
      lists[index].requests.map((request) => request.id),
    );
  if (report.status === "pass") {
    assert.equal(passedRequests, requests.length);
    assert.ok(
      Number.isFinite(report.elapsedMs) && report.elapsedMs <= report.policy.trialTimeoutMs,
      "A late completion cannot count as an hour-profile pass",
    );
  }
  const summary = {
    profile: report.profile,
    status: report.status,
    model: report.model ?? null,
    thinking: report.thinking ?? null,
    atomicOperations: requests.length,
    lists: lists.length,
    passedOperations: passedRequests,
    passedLists,
    deliveredOperations: deliveredRequests,
    originalListDeliveries: originals.length,
    repairDeliveries: deliveries.filter((delivery) => delivery.repair).length,
    totalModelDeliveries:
      report.version === "renderer-full-grouped-hour-v1" ? deliveries.length : null,
    elapsedMs: report.elapsedMs ?? null,
    totalLimitMs: report.policy.trialTimeoutMs,
    terminal: report.terminal
      ? {
          id: report.terminal.id ?? report.terminal.batch ?? null,
          category: report.terminal.category,
        }
      : null,
    usage: report.usage ?? null,
    agentClosed: report.agentClosed ?? null,
  };
  const markdown = `# Grouped renderer report\n\nStatus: **${summary.status}**. Verified operations: **${passedRequests}/${requests.length}**. Verified lists: **${passedLists}/${lists.length}**.\n\nOriginal list deliveries: ${summary.originalListDeliveries}. Coarse repair deliveries: ${summary.repairDeliveries}. Delivered operations: ${deliveredRequests}.\n\nElapsed minutes: ${summary.elapsedMs === null ? "unknown" : (summary.elapsedMs / 60000).toFixed(2)}. Overall limit: ${summary.totalLimitMs / 60000} minutes.\n\nUsage: ${summary.usage === null ? "unknown" : JSON.stringify(summary.usage)}. Costs, when available, are configured estimates, not billing receipts.\n`;
  await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(path.join(directory, "summary.md"), markdown);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await groupedReport(process.argv[2]), null, 2));
