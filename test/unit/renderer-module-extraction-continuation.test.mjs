import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureCandidate,
  releaseCandidateWorkspace,
} from "../../src/suites/explicit-edit-multi-agent/execution/candidate-evidence.mjs";
import {
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { loadExtractionContinuation } from "../../src/suites/explicit-edit-multi-agent/extraction/continuation.mjs";
import { runExtractionRecovery } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-continuation-"));
  const source = path.join(root, "source-run");
  await mkdir(source);
  const header = "#ifndef BODY_H\n#define BODY_H\nint value = 3;\n#endif\n";
  const plan = {
    ...prepareHeaderExtraction({
      initial: { "main.cpp": header + "int main() { return value; }\n" },
      headers: [{ file: "body.h", guard: "BODY_H", includes: [] }],
      modules: ["body.h"],
    }),
    version: "renderer-module-extraction-plan-v2",
    scope: "experimental-module-pairs",
    agents: 1,
    modules: ["body"],
  };
  const failed = { ...plan.expected, "body.h": plan.expected["body.h"] + "int broken = ;\n" };
  await writeTree(path.join(source, "workspace"), failed);
  const candidate = await captureCandidate(
    path.join(source, "workspace"),
    path.join(source, "candidate"),
    { includeAllFiles: true },
  );
  releaseCandidateWorkspace(path.join(source, "workspace"));
  const report = {
    version: "renderer-module-extraction-run-v2",
    scope: plan.scope,
    status: "complete",
    initial: plan.initialIdentity,
    agents: 1,
    modules: plan.modules,
    files: plan.tasks.map(({ id, file }) => ({ id, file })),
    participants: [{ agent: 0, session: 0, closed: true }],
    deliveries: [{ agent: 0, session: 0, ids: [plan.tasks[0].id], status: "settled" }],
    extraction: { status: "fail", inventoryMatched: true, invalidEntries: [] },
    integration: { buildPassed: false, resultMatched: false },
  };
  const planSha256 = "9".repeat(64);
  const sourceIdentity = {
    sourceCommit: "1".repeat(40),
    sourceClean: true,
    verifierSha256: "2".repeat(64),
    runnerSha256: "3".repeat(64),
  };
  const execution = { kind: "model", sourceIdentity, planSha256 };
  const reportBytes = JSON.stringify(report) + "\n";
  const executionBytes = JSON.stringify(execution) + "\n";
  await writeFile(path.join(source, "report.json"), reportBytes);
  await writeFile(path.join(source, "execution.json"), executionBytes);
  const receipt = {
    version: "renderer-module-extraction-continuation-source-v1",
    planSha256,
    sourceIdentity,
    reportSha256: hash(reportBytes),
    executionSha256: hash(executionBytes),
    candidateIdentity: candidate.identity,
    candidateManifestSha256: hash(await readFile(path.join(source, "candidate/manifest.json"))),
  };
  return { root, source, plan, failed, report, receipt, planSha256, reportBytes, executionBytes };
}

test("a saved continuation starts from measured failed bytes and never repeats original inference or compilation", async () => {
  const f = await fixture();
  let opens = 0,
    measures = 0;
  const stages = [];
  try {
    const continuation = await loadExtractionContinuation(
      f.plan,
      f.source,
      path.join(f.root, "source-proof"),
      { receipt: f.receipt, planSha256: f.planSha256 },
    );
    assert.equal(continuation.binding.reportSha256, f.receipt.reportSha256);
    assert.equal(continuation.binding.candidateIdentity, f.receipt.candidateIdentity);
    assert.equal(
      await readFile(path.join(continuation.source, "body.h"), "utf8"),
      f.failed["body.h"],
    );
    const output = path.join(f.root, "recovery");
    const result = await runExtractionRecovery(f.plan, output, {
      continuation,
      expectedPixels: ["a".repeat(64), "b".repeat(64)],
      async createDriver(_agent, _session, { stage, workspace }) {
        opens++;
        assert.equal(stage, "structural-correction");
        assert.equal(await readFile(path.join(workspace, "body.h"), "utf8"), f.failed["body.h"]);
        return {
          closed: false,
          assertIdle: async () => ({ sessionId: "continued-structure", messageCount: 0 }),
          async terminate() {
            this.closed = true;
          },
        };
      },
      async execute(_driver, task, context) {
        stages.push(context.stage);
        assert.equal(task.id, f.plan.tasks[0].id);
        await writeFile(path.join(context.workspace, task.file), task.destination);
        return { status: "complete" };
      },
      async assess(tree) {
        const targetMatched = tree["body.h"] === f.plan.expected["body.h"];
        return {
          version: "renderer-module-extraction-structure-v1",
          status: targetMatched ? "pass" : "fail",
          files: [{ id: f.plan.tasks[0].id, file: "body.h", targetMatched, sourceMatched: true }],
          differenceIds: targetMatched ? [] : [f.plan.tasks[0].id],
          mainMatched: true,
          inventoryMatched: true,
          unrelatedMatched: true,
          diagnostics: [],
        };
      },
      async measure() {
        measures++;
        return { buildPassed: true, resultMatched: true, pixels: ["a".repeat(64), "b".repeat(64)] };
      },
    });
    assert.deepEqual(stages, ["structural-correction"]);
    assert.equal(opens, 1);
    assert.equal(measures, 1);
    assert.equal(result.first.origin, "source-observation");
    assert.equal(result.first.integration.buildPassed, false);
    assert.equal(result.first.candidateIdentity, f.receipt.candidateIdentity);
    assert.equal(result.first.score.score, 0);
    assert.equal(result.score.score, 37.5);
    assert.equal(result.continuation.reportSha256, f.receipt.reportSha256);
    assert.equal(await readFile(path.join(f.source, "report.json"), "utf8"), f.reportBytes);
    assert.equal(await readFile(path.join(f.source, "execution.json"), "utf8"), f.executionBytes);
    assert.equal(
      await readFile(path.join(f.source, "workspace/body.h"), "utf8"),
      f.failed["body.h"],
    );
    assert.equal(treeIdentity(f.plan.initial), f.plan.initialIdentity);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const changed of [
  "workspace",
  "report",
  "execution",
  "manifest",
  "plan",
  "closure",
  "deliveries",
  "recovery-restart",
])
  test(`continuation rejects changed ${changed} evidence before starting a recovery agent`, async () => {
    const f = await fixture();
    try {
      let receipt = { ...f.receipt };
      if (changed === "workspace")
        await writeFile(path.join(f.source, "workspace/body.h"), f.plan.expected["body.h"]);
      if (changed === "manifest")
        await writeFile(path.join(f.source, "candidate/manifest.json"), "{}\n");
      if (changed === "execution") await writeFile(path.join(f.source, "execution.json"), "{}\n");
      if (changed === "report") await writeFile(path.join(f.source, "report.json"), "{}\n");
      if (changed === "plan") receipt.planSha256 = "0".repeat(64);
      if (["closure", "deliveries", "recovery-restart"].includes(changed)) {
        const report = structuredClone(f.report);
        if (changed === "closure") report.participants[0].closed = false;
        if (changed === "deliveries") report.deliveries[0].ids = ["not-the-original-task"];
        if (changed === "recovery-restart") report.version = "renderer-module-extraction-run-v3";
        const bytes = JSON.stringify(report) + "\n";
        await writeFile(path.join(f.source, "report.json"), bytes);
        receipt.reportSha256 = hash(bytes);
      }
      await assert.rejects(
        loadExtractionContinuation(f.plan, f.source, path.join(f.root, "source-proof"), {
          receipt,
          planSha256: f.planSha256,
        }),
      );
      assert.equal(
        await readFile(path.join(f.source, "workspace/main.cpp"), "utf8"),
        f.failed["main.cpp"],
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
