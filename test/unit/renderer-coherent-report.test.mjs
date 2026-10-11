import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  coherentSummary,
  rebuildCoherentReport,
} from "../../scripts/multi-agent/experiments/coherent-report.mjs";

await test("partial obligations do not become accepted tasks, and interrupted or blocked reports rebuild without execution", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-report-"));
  try {
    const report = {
      version: "renderer-coherent-run-v1",
      profile: "coherent-hour",
      status: "blocked",
      tasks: [
        { id: "task-001", subsystem: "math", goal: "restore math" },
        { id: "task-002", subsystem: "shape", goal: "restore shape" },
      ],
      checks: [
        {
          label: "first",
          contractId: "task-001",
          status: "pass",
          obligations: { passed: 2, total: 2 },
        },
        {
          label: "partial",
          contractId: "task-002",
          status: "fail",
          category: "structure",
          obligations: { passed: 99, total: 100 },
        },
      ],
      chain: { steps: [{ status: "pass" }, { status: "blocked" }] },
      acceptedTasks: 1,
      policy: { trialTimeoutMs: 3600000 },
      deliveries: 5,
      repairs: 3,
      elapsedMs: 123,
      usage: null,
    };
    for (const { label, size, failed } of [
      { label: "first", size: 2, failed: false },
      { label: "partial", size: 100, failed: true },
    ]) {
      await mkdir(path.join(root, "checks", label), { recursive: true });
      await writeFile(
        path.join(root, "checks", label, "obligations.json"),
        JSON.stringify({
          passed: size - Number(failed),
          total: size,
          obligations: Array.from({ length: size }, (_, index) => ({
            status: failed && index === size - 1 ? "fail" : "pass",
          })),
        }),
      );
    }
    for (const status of ["blocked", "timeout", "provider_failure", "cancelled"]) {
      await writeFile(path.join(root, "report.json"), JSON.stringify({ ...report, status }));
      const summary = await rebuildCoherentReport(root);
      assert.equal(summary.status, status);
      assert.equal(summary.acceptedTasks, 1);
      assert.equal(summary.tasks[1].checks[0].obligations.passed, 99);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(root, "summary.json"), "utf8")),
        summary,
      );
    }
    assert.throws(() => coherentSummary({ ...report, acceptedTasks: 2 }));
    await writeFile(
      path.join(root, "report.json"),
      JSON.stringify({ ...report, checks: [{ ...report.checks[1], status: "pass" }] }),
    );
    await assert.rejects(rebuildCoherentReport(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
