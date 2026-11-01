import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { runExtractionRecovery } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery.mjs";

const bodies = [
  "int alpha() { return 1; }",
  "int beta() { return 2; }",
  "int gamma() { return 3; }",
];
const success = { buildPassed: true, resultMatched: true };
async function fixture(mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owner-recovery-"));
  const headers = bodies
    .map((body, i) => `#ifndef H${i}\n#define H${i}\n${body}\n#endif\n`)
    .join("");
  const plan = {
    ...prepareHeaderExtraction({
      initial: { "main.cpp": headers + "int main() { return 0; }\n" },
      headers: bodies.map((_b, i) => ({ file: `f${i}.h`, guard: `H${i}`, includes: [] })),
      modules: ["f0.h", "f1.h", "f2.h"],
    }),
    version: "renderer-module-extraction-plan-v2",
    scope: "experimental-module-pairs",
    agents: 2,
  };
  const output = path.join(root, "run");
  const opened = [],
    closed = [],
    deliveries = [],
    measurements = [],
    repairs = [];
  const together = Promise.withResolvers();
  let serial = Promise.resolve();
  const mutate = (fn) => {
    const next = serial.then(fn);
    serial = next.catch(() => {});
    return next;
  };
  const options = {
    async createDriver(agent, _session, { stage }) {
      opened.push({ agent, stage });
      return {
        closed: false,
        count: 0,
        async assertIdle() {
          return { sessionId: `${stage}-${agent}`, messageCount: this.count };
        },
        async terminate() {
          this.closed = true;
          closed.push({ agent, stage });
        },
      };
    },
    async execute(driver, task, context) {
      driver.count++;
      deliveries.push({ agent: context.agent, stage: context.stage, id: task.id });
      if (context.stage === "original") {
        await writeFile(path.join(context.workspace, task.file), task.destination);
        if (task.id === plan.tasks[2].id)
          await writeFile(
            path.join(context.workspace, "main.cpp"),
            plan.expected["main.cpp"].replace(
              "return 0;",
              mode === "shared" ? "return 4;" : "return 0;",
            ) +
              (mode === "parallel"
                ? `${bodies[0]}\n${bodies[1]}\n`
                : `namespace n {\n${bodies[0]}\n${bodies[1]}\n}\n`),
          );
      } else if (context.stage === "structural-correction") {
        assert.equal(opened.length, 2);
        assert.equal(closed.length, 0);
        assert.equal(deliveries.filter((d) => d.stage === "original").length, 3);
        assert.equal(
          context.agent,
          task.kind === "main-recovery" ? 0 : plan.tasks.findIndex((t) => t.id === task.id) % 2,
        );
        repairs.push(task);
        if (mode === "parallel") {
          if (repairs.length === 2) together.resolve();
          await together.promise;
        }
        await mutate(async () => {
          const file = path.join(context.workspace, "main.cpp");
          const before = await readFile(file, "utf8");
          if (task.kind === "main-recovery") {
            assert.deepEqual(
              task.recovery.diagnostics.map((d) => d.id),
              ["preservation:main.cpp"],
            );
            await writeFile(
              file,
              before.replace("int main() { return 4; }", "int main() { return 0; }"),
            );
          } else if (mode === "skip" && task.id === plan.tasks[0].id)
            await writeFile(file, plan.expected["main.cpp"]);
          else if (mode !== "exhausted") {
            const index = plan.tasks.findIndex((t) => t.id === task.id);
            const diagnostic = task.recovery.diagnostics.find((d) => d.kind === "source-residue");
            const checkpoint =
              mode === "parallel"
                ? await readFile(
                    path.join(output, "stages/original/candidate/source/main.cpp"),
                    "utf8",
                  )
                : before;
            assert.equal(checkpoint.slice(diagnostic.start, diagnostic.end), bodies[index]);
            assert.equal(before.split(bodies[index]).length - 1, 1);
            if (mode === "serial" && repairs.length === 2) {
              const original = firstDiagnostics.get(task.id);
              assert.notEqual(diagnostic.start, original.start);
            }
            await writeFile(
              file,
              ("\n\n" + before.replace(bodies[index], "")).replace(/namespace n \{\s*\}/g, ""),
            );
            if (mode === "regression" && task.id === plan.tasks[0].id)
              await writeFile(
                path.join(context.workspace, plan.tasks[2].file),
                "int new_error = ;\n",
              );
          }
        });
      } else throw Error("Unexpected integration correction");
      return { completed: task.id };
    },
    async measure(_source, evidence) {
      const stage = path.basename(path.dirname(evidence));
      measurements.push(stage);
      if (stage === "original") {
        assert.equal(deliveries.length, 3);
        assert.equal(closed.length, 0);
      } else assert.equal(closed.length, opened.length);
      return success;
    },
  };
  const firstDiagnostics = new Map();
  const execute = options.execute;
  options.execute = async (driver, task, context) => {
    if (context.stage === "structural-correction" && repairs.length === 0) {
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      for (const diagnostic of report.first.structure.diagnostics)
        if (diagnostic.kind === "source-residue") firstDiagnostics.set(diagnostic.id, diagnostic);
    }
    return execute(driver, task, context);
  };
  return { root, output, plan, options, opened, closed, deliveries, measurements, repairs };
}

for (const mode of ["parallel", "serial", "skip", "exhausted", "regression", "shared"])
  test(
    `original-owner recovery handles ${mode} obligations without another structural wave`,
    { timeout: 5000 },
    async () => {
      const f = await fixture(mode);
      try {
        const report = await runExtractionRecovery(f.plan, f.output, f.options);
        assert.equal(report.status, "complete");
        assert.equal(f.opened.length, 2);
        assert.equal(f.closed.length, 2);
        assert.deepEqual(f.measurements, ["original", "structural-correction"]);
        assert.equal(report.participants.length, 2);
        assert.equal(report.waves.filter((w) => w.stage === "structural-correction").length, 1);
        assert.equal(report.stages.length, 2);
        assert.deepEqual(report.first.structure.differenceIds, [
          ...f.plan.tasks.slice(0, 2).map((t) => t.id),
          ...(mode === "shared" ? ["preservation:main.cpp"] : []),
        ]);
        assert.equal(report.first.integration.buildPassed, true);
        assert.equal(f.repairs.length, mode === "skip" ? 1 : mode === "shared" ? 3 : 2);
        if (mode === "shared") {
          assert.equal(report.repairs.filter((r) => r.id === "repair-shared-project").length, 1);
          assert.equal(report.repairs.find((r) => r.id === "repair-shared-project").owner, 0);
          assert.ok(report.recoveryChecks.every((c) => c.ready.length === 1));
        }
        assert.equal(report.passed, !["exhausted", "regression"].includes(mode));
        assert.equal(report.score.structural.totalHunks, 3);
        assert.equal(report.score.build.factor, 1);
        if (mode === "parallel") assert.equal(report.recoveryChecks[0].ready.length, 2);
        if (mode === "serial") assert.equal(report.recoveryChecks[0].ready.length, 1);
        if (mode === "skip")
          assert.equal(report.repairs.find((r) => r.id === f.plan.tasks[1].id).status, "skipped");
        if (mode === "regression")
          assert.ok(report.structure.differenceIds.includes(f.plan.tasks[2].id));
        if (mode === "exhausted") assert.equal(report.score.score, 0);
        assert.ok(report.participants.every((p) => p.closed));
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

test("physical-only damage is present in the first shared feedback without duplicating file penalties", async () => {
  for (const emptyDirectory of [false, true]) {
    const f = await fixture("skip");
    const originalExecute = f.options.execute;
    let deliveries = 0;
    f.options.execute = async (driver, task, context) => {
      if (context.stage === "original") {
        await originalExecute(driver, task, context);
        if (task.id === f.plan.tasks[2].id) {
          await writeFile(path.join(context.workspace, "main.cpp"), f.plan.expected["main.cpp"]);
          await writeFile(path.join(context.workspace, "extra.txt"), "unintended file\n");
          if (emptyDirectory) await mkdir(path.join(context.workspace, "empty-extra"));
        }
      } else {
        deliveries++;
        assert.equal(task.id, "repair-shared-project");
        assert.equal(context.agent, 0);
        const first = JSON.parse(await readFile(path.join(f.output, "report.json"), "utf8")).first;
        assert.deepEqual(first.structure.differenceIds, [
          "inventory:extra.txt",
          ...(emptyDirectory ? ["preservation:physical-inventory"] : []),
        ]);
        if (emptyDirectory)
          assert.ok(
            task.recovery.diagnostics.some(
              (d) => d.id === "preservation:physical-inventory" && d.file === "empty-extra",
            ),
          );
        // Keep the pre-existing directory: it must remain unresolved, not become
        // a newly introduced difference after the regular extra file is removed.
        await rm(path.join(context.workspace, "extra.txt"));
      }
    };
    try {
      const report = await runExtractionRecovery(f.plan, f.output, f.options);
      assert.equal(deliveries, 1);
      assert.deepEqual(
        report.structure.differenceIds,
        emptyDirectory ? ["preservation:physical-inventory"] : [],
      );
      assert.deepEqual(report.score.structural.ledger[1].introduced, []);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("a closed historical candidate cannot pretend to retain live original owner contexts", async () => {
  const f = await fixture("serial");
  try {
    await assert.rejects(
      runExtractionRecovery(f.plan, f.output, { ...f.options, continuation: { source: f.root } }),
      { code: "EXTRACTION_LIVE_CONTEXT_REQUIRED" },
    );
    assert.equal(f.opened.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
