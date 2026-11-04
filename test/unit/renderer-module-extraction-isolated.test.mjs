import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { extractCurrentFile } from "../../src/suites/explicit-edit-multi-agent/extraction/edit.mjs";
import { runIsolatedExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/isolated.mjs";
import { isolatedAnchors } from "../../src/suites/explicit-edit-multi-agent/extraction/isolated-anchors.mjs";
import { prepareExtractionStructure } from "../../src/suites/explicit-edit-multi-agent/extraction/structure.mjs";

function fixture() {
  return prepareHeaderExtraction({
    initial: {
      "main.cpp":
        "#ifndef A_H\n#define A_H\nint a = 1;\n#endif\n#ifndef B_H\n#define B_H\nint b = 2;\n#endif\nint main() { return a+b; }\n",
      "asset.txt": "unchanged\n",
    },
    headers: [
      { file: "a.h", guard: "A_H", includes: [] },
      { file: "b.h", guard: "B_H", includes: [] },
    ],
    modules: ["a.h", "b.h"],
  });
}

test("independent assignments start clean and failures do not contaminate the next task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "isolated-extraction-"));
  const plan = fixture();
  const order = [];
  try {
    const result = await runIsolatedExtraction(plan, path.join(root, "run"), {
      async createDrivers({ task, workspace }) {
        const before = await readFile(path.join(workspace, "main.cpp"), "utf8");
        assert.equal(before, plan.initial["main.cpp"]);
        assert.equal(await readFile(path.join(workspace, "asset.txt"), "utf8"), "unchanged\n");
        order.push(`start:${task.id}`);
        return {
          createDriver: async () => ({
            closed: false,
            assertIdle: async () => ({ sessionId: task.id }),
            async terminate() {
              this.closed = true;
            },
          }),
          async execute() {
            const expected = extractCurrentFile(plan.initial, task);
            await writeFile(path.join(workspace, "main.cpp"), expected["main.cpp"]);
            await writeFile(path.join(workspace, task.file), expected[task.file]);
            if (task === plan.tasks[0])
              await writeFile(path.join(workspace, "asset.txt"), "damaged\n");
          },
          async cleanup() {},
        };
      },
      async inspect(request) {
        order.push(`inspect:${request.ids[0]}`);
        assert.ok(request.report);
        return {
          runId: request.runId,
          sequence: request.sequence,
          candidateIdentity: request.candidateIdentity,
        };
      },
    });
    assert.deepEqual(
      order,
      plan.tasks.flatMap((task) => [`start:${task.id}`, `inspect:${task.id}`]),
    );
    assert.equal(result.status, "complete");
    assert.equal(result.tasks[0].structure.status, "fail");
    assert.equal(result.tasks[0].structure.unrelatedMatched, false);
    assert.equal(result.tasks[1].structure.status, "pass");
    assert.equal(result.tasks[1].structure.inventoryMatched, true);
    assert.equal("extraction" in result.tasks[1], false);
    assert.equal("score" in result, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a no-op fails and denied inspection prevents the next task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "isolated-stop-"));
  let started = 0;
  try {
    await assert.rejects(
      runIsolatedExtraction(fixture(), path.join(root, "run"), {
        async createDrivers() {
          started++;
          return {
            createDriver: async () => ({
              closed: false,
              assertIdle: async () => ({ sessionId: "only" }),
              async terminate() {
                this.closed = true;
              },
            }),
            async execute() {},
            async cleanup() {},
          };
        },
        async inspect(request) {
          const report = JSON.parse(await readFile(request.report, "utf8"));
          assert.equal(report.tasks[0].structure.status, "fail");
          throw new Error("inspection denied");
        },
      }),
      /inspection denied/,
    );
    assert.equal(started, 1);
    const report = JSON.parse(await readFile(path.join(root, "run/report.json"), "utf8"));
    assert.equal(report.status, "interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical declarations in two owners use unique context and fail closed on changed context", () => {
  const source =
    "namespace frond {\nint before();\nint same();\nint middle();\nint same();\nint after();\n}\n";
  const text = "int same();";
  const starts = [source.indexOf(text), source.lastIndexOf(text)];
  const tasks = starts.map((start, index) => ({
    id: `task-${index}`,
    file: `file${index}.cpp`,
    kind: "implementation",
    fragments: [
      {
        id: `fragment-${index}`,
        text,
        start,
        end: start + text.length,
        scope: "frond",
        kind: "declaration",
      },
    ],
    destination: text,
    replacement: "",
  }));
  const input = { initial: { "main.cpp": source }, tasks };
  const result = isolatedAnchors(input);
  assert.equal(result.hints.size, 2);
  assert.equal(input.tasks[0].fragments[0].isolatedAnchor, undefined);
  for (const [index, task] of result.plan.tasks.entries()) {
    const extracted = extractCurrentFile(input.initial, task);
    assert.equal(extracted[task.file], text);
    assert.equal(
      extracted["main.cpp"],
      source.slice(0, starts[index]) + source.slice(starts[index] + text.length),
    );
    const anchor = task.fragments[0].isolatedAnchor;
    const changed = source.replace(anchor.context, anchor.context.replace("int", "long"));
    assert.notEqual(changed, source);
    assert.throws(() => extractCurrentFile({ "main.cpp": changed }, task), /context/);
  }
});

test("sorted assessment applies to destination, residual source and unrelated C++ files", async () => {
  const plan = fixture();
  const task = plan.tasks[0];
  const expected = extractCurrentFile(plan.initial, task);
  expected[task.file] = `#include "x.h"\n${expected[task.file]}\n#include "y.h"\n`;
  expected["main.cpp"] += '#include "x.h"\n#include "y.h"\n';
  expected["other.cpp"] = '#include "x.h"\nint z;\n#include "y.h"\n';
  const assess = await prepareExtractionStructure(
    { ...plan, tasks: [task], expected },
    { sorted: true },
  );
  assert.equal((await assess(expected)).status, "pass");
  for (const changed of [
    {
      ...expected,
      [task.file]: expected[task.file]
        .replace('#include "x.h"\n', "")
        .replace('#include "y.h"', '#include "y.h"\n#include "x.h"'),
    },
    {
      ...expected,
      "main.cpp": expected["main.cpp"].replace(
        '#include "x.h"\n#include "y.h"',
        '#include "y.h"\n#include "x.h"',
      ),
    },
    { ...expected, "other.cpp": '#include "y.h"\n#include "x.h"\nint z;\n' },
    { ...expected, "other.cpp": '#if X\n#include "x.h"\n#endif\n#include "y.h"\nint z;\n' },
  ])
    assert.equal((await assess(changed)).status, "fail");
});

test("one-task assessment detects target, source, unrelated and inventory damage", async () => {
  const plan = fixture();
  const task = plan.tasks[0];
  const expected = extractCurrentFile(plan.initial, task);
  const assess = await prepareExtractionStructure({ ...plan, tasks: [task], expected });
  assert.equal((await assess(expected)).status, "pass");
  const changed = [
    { ...expected, [task.file]: expected[task.file].replace("a = 1", "a = 7") },
    { ...expected, "main.cpp": plan.initial["main.cpp"] },
    { ...expected, "main.cpp": expected["main.cpp"].replace("b = 2", "b = 8") },
    { ...expected, "asset.txt": "changed\n" },
    { ...expected, "extra.txt": "unexpected\n" },
  ];
  for (const tree of changed) assert.equal((await assess(tree)).status, "fail");
});
