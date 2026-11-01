import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { runExtractionRecovery } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery.mjs";

const pixels = ["0".repeat(64), "1".repeat(64)];
function fixture() {
  const header = "#ifndef A_H\n#define A_H\nint value = 3;\n#endif\n";
  return {
    ...prepareHeaderExtraction({
      initial: { "main.cpp": header + "int main() { return value; }\n" },
      headers: [{ file: "a.h", guard: "A_H", includes: [] }],
      modules: ["a.h"],
    }),
    version: "renderer-module-extraction-plan-v2",
    scope: "experimental-module-pairs",
    agents: 1,
    modules: ["a"],
  };
}

async function exercise({ outcomes, broken = false, regress = false, refuse = null }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-recovery-"));
  const output = path.join(root, "run");
  const plan = fixture();
  const opened = [],
    closed = [],
    deliveries = [],
    measurements = [];
  const options = {
    expectedPixels: pixels,
    async createDriver(agent, session, context) {
      const record = { agent, session, stage: context.stage, workspace: context.workspace };
      opened.push(record);
      return {
        closed: false,
        assertIdle: async () => ({ sessionId: `${context.stage}-${session}`, messageCount: 0 }),
        async terminate() {
          this.closed = true;
          closed.push(record);
        },
      };
    },
    async execute(_driver, task, context) {
      const workspace = context.workspace;
      deliveries.push({ stage: context.stage, id: task.id, agent: context.agent });
      if (refuse === context.stage)
        throw Object.assign(new Error("fixture refusal"), { category: "provider_failure" });
      if (context.stage === "original") {
        await writeFile(
          path.join(workspace, "a.h"),
          broken ? "invalid target\n" : plan.tasks[0].destination,
        );
        await writeFile(path.join(workspace, "main.cpp"), plan.expected["main.cpp"]);
      } else if (context.stage === "structural-correction") {
        await writeFile(path.join(workspace, "a.h"), plan.tasks[0].destination);
      } else if (regress) {
        await writeFile(path.join(workspace, "a.h"), "new regression\n");
      }
      return { status: "complete" };
    },
    async assess(tree) {
      const targetMatched = tree["a.h"] === plan.expected["a.h"];
      return {
        status: targetMatched ? "pass" : "fail",
        files: [{ id: plan.tasks[0].id, file: "a.h", targetMatched, sourceMatched: true }],
        differenceIds: targetMatched ? [] : [plan.tasks[0].id],
        mainMatched: true,
        inventoryMatched: true,
        unrelatedMatched: true,
        diagnostics: [],
      };
    },
    async measure(_source, evidence, tree) {
      assert.equal(tree["main.cpp"], plan.expected["main.cpp"]);
      const stage = path.basename(path.dirname(evidence));
      assert.equal(closed.length, stage === "original" ? 0 : opened.length);
      measurements.push(stage);
      const next = outcomes[measurements.length - 1];
      assert.ok(next);
      return { ...next, ...(next.resultMatched ? { pixels } : {}) };
    },
  };
  return { root, output, plan, options, opened, closed, deliveries, measurements };
}

const success = { buildPassed: true, resultMatched: true };
const buildFailure = { buildPassed: false, resultMatched: false };
const imageFailure = { buildPassed: true, resultMatched: false };

test("owned source residue stays one whole-file repair, not an overlapping shared-main delivery", async () => {
  const f = await exercise({ outcomes: [buildFailure, success] });
  try {
    delete f.options.assess;
    f.options.execute = async (_driver, task, context) => {
      f.deliveries.push({ stage: context.stage, id: task.id });
      await writeFile(path.join(context.workspace, "a.h"), f.plan.tasks[0].destination);
      if (context.stage === "structural-correction")
        await writeFile(path.join(context.workspace, "main.cpp"), f.plan.expected["main.cpp"]);
      return { status: "complete" };
    };
    f.options.measure = async () => {
      assert.equal(f.closed.length, f.measurements.length === 0 ? 0 : f.opened.length);
      return f.measurements.push("measured") === 1 ? buildFailure : { ...success, pixels };
    };
    const report = await runExtractionRecovery(f.plan, f.output, f.options);
    assert.equal(report.first.structure.mainMatched, false);
    assert.deepEqual(report.first.structure.differenceIds, [f.plan.tasks[0].id]);
    assert.deepEqual(report.waves[1].ids, [f.plan.tasks[0].id]);
    assert.equal(report.participants.length, 1);
    assert.equal(report.score.score, 37.5);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("correct initial extraction spends no recovery delivery and scores 100", async () => {
  const f = await exercise({ outcomes: [success] });
  try {
    const report = await runExtractionRecovery(f.plan, f.output, f.options);
    assert.deepEqual(f.measurements, ["original"]);
    assert.equal(f.opened.length, 1);
    assert.deepEqual(
      f.deliveries.map(({ stage }) => stage),
      ["original"],
    );
    assert.equal(report.score.score, 100);
    assert.equal(report.first.score.score, 100);
    assert.equal(report.status, "complete");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.output, "report.json"), "utf8")),
      report,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("one structural recovery retains first failure and gives half credit", async () => {
  const f = await exercise({ broken: true, outcomes: [buildFailure, success] });
  try {
    const report = await runExtractionRecovery(f.plan, f.output, f.options);
    assert.deepEqual(f.measurements, ["original", "structural-correction"]);
    assert.equal(f.opened.length, 1);
    assert.equal(report.first.integration.buildPassed, false);
    assert.equal(report.first.structure.files[0].targetMatched, false);
    assert.equal(report.structure.files[0].targetMatched, true);
    assert.equal(report.score.structural.final.normalized, 0.5);
    assert.equal(report.score.build.factor, 0.75);
    assert.equal(report.score.images.factor, 1);
    assert.equal(report.score.score, 37.5);
    assert.equal(report.score.structural.totalHunks, 1);
    assert.equal(report.stages[0].integration.buildPassed, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("build and image recovery each get exactly one agent and retain existing factors", async () => {
  const f = await exercise({ outcomes: [buildFailure, imageFailure, success] });
  try {
    const report = await runExtractionRecovery(f.plan, f.output, f.options);
    assert.deepEqual(f.measurements, ["original", "build-correction", "image-correction"]);
    assert.equal(f.opened.length, 3);
    for (const stage of ["build-correction", "image-correction"]) {
      assert.equal(f.opened.filter((record) => record.stage === stage).length, 1);
      assert.equal(f.deliveries.filter((record) => record.stage === stage).length, 1);
    }
    assert.equal(report.score.build.factor, 0.75);
    assert.equal(report.score.images.factor, 0.75);
    assert.equal(report.score.score, 56.25);
    assert.equal(report.score.structural.totalHunks, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a failed build recovery is not repeated and never starts image recovery", async () => {
  const f = await exercise({ outcomes: [buildFailure, buildFailure] });
  try {
    const report = await runExtractionRecovery(f.plan, f.output, f.options);
    assert.deepEqual(f.measurements, ["original", "build-correction"]);
    assert.equal(f.opened.length, 2);
    assert.equal(report.integration.buildPassed, false);
    assert.equal(report.score.score, 25);
    assert.equal(report.score.images.firstPassed, null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an image repair regression is captured without restarting earlier budgets", async () => {
  const f = await exercise({ outcomes: [imageFailure, buildFailure], regress: true });
  try {
    const report = await runExtractionRecovery(f.plan, f.output, f.options);
    assert.deepEqual(f.measurements, ["original", "image-correction"]);
    assert.equal(report.score.structural.final.normalized, 0);
    assert.equal(report.score.build.factor, 0.5);
    assert.equal(report.score.images.factor, 0.5);
    assert.equal(report.score.score, 0);
    assert.equal(report.structure.files[0].targetMatched, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("provider refusal in recovery closes participants and never starts another phase", async () => {
  const f = await exercise({ outcomes: [buildFailure], refuse: "build-correction" });
  try {
    await assert.rejects(runExtractionRecovery(f.plan, f.output, f.options), {
      category: "provider_failure",
    });
    assert.equal(f.opened.length, f.closed.length);
    assert.deepEqual(f.measurements, ["original"]);
    const report = JSON.parse(await readFile(path.join(f.output, "report.json"), "utf8"));
    assert.equal(report.status, "interrupted");
    assert.equal(report.first.integration.buildPassed, false);
    assert.equal(report.stages.length, 1);
    assert.equal(
      await readFile(path.join(f.output, "workspace/a.h"), "utf8"),
      f.plan.expected["a.h"],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
