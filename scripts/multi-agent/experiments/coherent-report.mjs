import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Summarize recorded task checks, not a new verification or a score for partially
 * satisfied obligations. A valid progress unit is one complete accepted goal.
 */
export function coherentSummary(report) {
  assert.equal(report.version, "renderer-coherent-run-v1");
  const steps = report.chain?.steps ?? [];
  const accepted = steps.filter((step) => step.status === "pass").length;
  assert.equal(accepted, report.acceptedTasks);
  let prefix = 0;
  while (steps[prefix]?.status === "pass") prefix++;
  assert.equal(prefix, accepted, "Accepted coherent tasks must form a verified prefix");
  return {
    profile: report.profile,
    status: report.status,
    acceptedTasks: accepted,
    totalTasks: report.tasks.length,
    deliveries: report.deliveries,
    repairs: report.repairs,
    elapsedMs: report.elapsedMs,
    totalLimitMs: report.policy.trialTimeoutMs,
    terminal: report.terminal ?? null,
    tasks: report.tasks.map((task, index) => ({
      id: task.id,
      subsystem: task.subsystem,
      goal: task.goal,
      status: steps[index]?.status ?? "unattempted",
      checks: report.checks
        .filter((check) => check.contractId === task.id)
        .map((check) => ({
          label: check.label,
          status: check.status,
          category: check.category ?? null,
          obligations: check.obligations ?? null,
        })),
    })),
    usage: report.usage,
    agentClosed: report.agentClosed ?? null,
  };
}

/** Rebuild a view from retained evidence without a compiler, renderer, agent or model
 * request. Ledger counts are checked against their saved per-obligation results.
 * Saved PASS means that the original run verified the goal; this command does not
 * authenticate edited artifacts or perform another verification.
 */
export async function rebuildCoherentReport(directory) {
  const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
  for (const check of report.checks) {
    if (!check.obligations) continue;
    const ledger = JSON.parse(
      await readFile(path.join(directory, "checks", check.label, "obligations.json"), "utf8"),
    );
    const passed = ledger.obligations.filter((item) => item.status === "pass").length;
    assert.equal(ledger.total, ledger.obligations.length);
    assert.equal(ledger.passed, passed);
    assert.deepEqual(check.obligations, { passed, total: ledger.total });
    if (check.status === "pass") assert.equal(passed, ledger.total);
  }
  const summary = coherentSummary(report);
  await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await rebuildCoherentReport(process.argv[2]), null, 2));
