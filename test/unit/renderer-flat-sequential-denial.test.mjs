import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { flatExpected } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-plan.mjs";
import { runFlatSequential } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-sequential.mjs";

test("a rejected candidate stops the queue and closes the participant", async () => {
  const initial = { "main.cpp": "int a();\nint b();\n" };
  const tasks = ["a", "b"].map((name) => {
    const text = `int ${name}();`,
      start = initial["main.cpp"].indexOf(text);
    return {
      id: name,
      file: `${name}.h`,
      kind: "header",
      replacement: `#include "${name}.h"\n`,
      destination: text,
      fragments: [
        { id: name, text, start, end: start + text.length, scope: "", kind: "declaration" },
      ],
    };
  });
  const plan = {
    initial,
    initialIdentity: treeIdentity(initial),
    tasks,
    expected: flatExpected(initial, tasks),
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "flat-denied-"));
  let deliveries = 0,
    closed = false;
  try {
    await assert.rejects(
      runFlatSequential(plan, root + "/run", {
        agents: 1,
        async createDriver() {
          return {
            closed: false,
            async assertIdle() {
              return { sessionId: "one" };
            },
            async terminate() {
              this.closed = true;
              closed = true;
            },
          };
        },
        async execute() {
          deliveries++;
        },
        async inspect() {
          throw new Error("inspection denied");
        },
      }),
      /inspection denied/,
    );
    const report = JSON.parse(await readFile(root + "/run/report.json", "utf8"));
    assert.equal(deliveries, 1);
    assert.equal(closed, true);
    assert.equal(report.status, "interrupted");
    assert.equal(report.rounds[0].inspection, "awaiting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
