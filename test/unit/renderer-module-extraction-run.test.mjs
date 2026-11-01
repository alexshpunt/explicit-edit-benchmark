import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { runExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/run.mjs";

function fixture() {
  const first = "#ifndef A_H\n#define A_H\nint bad_a = 3;\n#endif\n";
  const second = "#ifndef B_H\n#define B_H\nint bad_b = 4;\n#endif\n";
  return prepareHeaderExtraction({
    initial: { "main.cpp": first + second + "int main() { return bad_a + bad_b; }\n" },
    headers: [
      { file: "a.h", guard: "A_H", includes: [] },
      { file: "b.h", guard: "B_H", includes: [] },
    ],
    modules: ["a.h", "b.h"],
  });
}
const pixels = ["0".repeat(64), "1".repeat(64)];

test("one final measurement sees closed participants and the exact preserved extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-final-"));
  const output = path.join(root, "run");
  const plan = fixture();
  let closed = 0,
    measures = 0;
  try {
    const result = await runExtraction(plan, output, {
      expectedPixels: pixels,
      createDriver: async (agent) => ({
        closed: false,
        assertIdle: async () => ({ sessionId: `fixture-${agent}`, messageCount: 0 }),
        async terminate() {
          this.closed = true;
          closed++;
        },
      }),
      async execute(_driver, task) {
        // Independent modules are simulated here; no model proof is inferred.
        await writeFile(path.join(output, "workspace", task.file), task.destination);
        if (task.file === "b.h")
          await writeFile(path.join(output, "workspace/main.cpp"), plan.expected["main.cpp"]);
        return { status: "complete" };
      },
      async measure(source, _evidence, tree, options) {
        measures++;
        assert.equal(closed, 2);
        assert.deepEqual(tree, plan.expected);
        assert.deepEqual(options.expectedPixels, pixels);
        assert.equal(options.completeInventory, true);
        assert.equal(
          await readFile(path.join(source, "main.cpp"), "utf8"),
          plan.expected["main.cpp"],
        );
        return { buildPassed: true, resultMatched: true, pixels };
      },
    });
    assert.equal(measures, 1);
    assert.equal(result.extraction.status, "pass");
    assert.equal(result.integration.buildPassed, true);
    assert.equal(result.status, "complete");
    assert.equal(
      await readFile(path.join(output, "workspace/main.cpp"), "utf8"),
      plan.expected["main.cpp"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted wave closes its participants, keeps partial edits and never compiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-stop-"));
  const output = path.join(root, "run");
  const stopped = new Set();
  const refusal = Object.assign(new Error("fixture refused"), { category: "provider_failure" });
  let measures = 0;
  try {
    await assert.rejects(
      runExtraction(fixture(), output, {
        expectedPixels: pixels,
        createDriver: async (agent) => ({
          closed: false,
          assertIdle: async () => ({ sessionId: `fixture-${agent}`, messageCount: 0 }),
          async terminate() {
            this.closed = true;
            stopped.add(agent);
          },
        }),
        async execute(_driver, task) {
          await writeFile(path.join(output, "workspace", task.file), task.destination);
          throw refusal;
        },
        async measure() {
          measures++;
        },
      }),
      (error) => error === refusal,
    );
    assert.equal(stopped.size, 2);
    assert.equal(measures, 0);
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.status, "interrupted");
    assert.equal(
      await readFile(path.join(output, "workspace/a.h"), "utf8"),
      fixture().expected["a.h"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("final preservation checks include non-C++ files and empty directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-inventory-"));
  try {
    for (const extra of ["backup.inc", "unused-directory"]) {
      const plan = fixture();
      const output = path.join(root, extra);
      const result = await runExtraction(plan, output, {
        expectedPixels: pixels,
        createDriver: async (agent) => ({
          closed: false,
          assertIdle: async () => ({ sessionId: `inventory-${agent}`, messageCount: 0 }),
          async terminate() {
            this.closed = true;
          },
        }),
        async execute(_driver, task) {
          await writeFile(path.join(output, "workspace", task.file), task.destination);
          if (task.file === "b.h") {
            await writeFile(path.join(output, "workspace/main.cpp"), plan.expected["main.cpp"]);
            if (extra === "backup.inc")
              await writeFile(path.join(output, "workspace", extra), task.destination);
            else await mkdir(path.join(output, "workspace", extra));
          }
        },
        async measure() {
          return { buildPassed: true, resultMatched: true, pixels };
        },
      });
      assert.equal(result.extraction.status, "fail");
      assert.equal(result.extraction.inventoryMatched, false);
      assert.equal(result.integration.buildPassed, true);
      assert.equal(
        result.participants.every(({ closed }) => closed),
        true,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unrelated non-C++ contents are preserved and their changed bytes fail extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-unrelated-"));
  try {
    for (const changed of [false, true]) {
      const original = fixture();
      const plan = prepareHeaderExtraction({
        initial: { ...original.initial, "notes.txt": "retained asset\n" },
        headers: [
          { file: "a.h", guard: "A_H", includes: [] },
          { file: "b.h", guard: "B_H", includes: [] },
        ],
        modules: ["a.h", "b.h"],
      });
      const output = path.join(root, String(changed));
      const result = await runExtraction(plan, output, {
        expectedPixels: pixels,
        createDriver: async (agent) => ({
          closed: false,
          assertIdle: async () => ({ sessionId: `unrelated-${agent}`, messageCount: 0 }),
          async terminate() {
            this.closed = true;
          },
        }),
        async execute(_driver, task) {
          await writeFile(path.join(output, "workspace", task.file), task.destination);
          if (task.file === "b.h") {
            await writeFile(path.join(output, "workspace/main.cpp"), plan.expected["main.cpp"]);
            if (changed)
              await writeFile(path.join(output, "workspace/notes.txt"), Buffer.from([0xff]));
          }
        },
        async measure() {
          return { buildPassed: true, resultMatched: true, pixels };
        },
      });
      assert.equal(result.extraction.status, changed ? "fail" : "pass");
      assert.equal(result.extraction.unrelatedMatched, !changed);
      assert.equal(result.extraction.inventoryMatched, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
