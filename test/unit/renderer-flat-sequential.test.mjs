import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { flatExpected } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-plan.mjs";
import { runFlatSequential } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-sequential.mjs";

// Sequential execution uses an explicit approval tied to the candidate bytes.
test("one delivery runs at a time and each candidate is inspected before the next", async () => {
  const source = "int a();\nint b();\nint c();\nint main();\n",
    initial = { "main.cpp": source };
  const tasks = ["a", "b", "c"].map((name, index) => {
    const text = `int ${name}();`,
      start = source.indexOf(text);
    return {
      id: `task-${index}`,
      file: `${name}.h`,
      kind: "header",
      replacement: `#include "${name}.h"\n`,
      destination: text,
      fragments: [
        { id: name, start, end: start + text.length, text, scope: "", kind: "declaration" },
      ],
    };
  });
  const plan = {
    initial,
    initialIdentity: treeIdentity(initial),
    tasks,
    expected: flatExpected(initial, tasks),
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "flat-sequence-")),
    order = [];
  let active = 0;
  const completed = [];
  try {
    const result = await runFlatSequential(plan, root + "/run", {
      agents: 2,
      async createDriver(agent) {
        assert.equal(active++, 0);
        return {
          closed: false,
          agent,
          async assertIdle() {
            return { sessionId: String(agent) };
          },
          async terminate() {
            this.closed = true;
            active--;
          },
        };
      },
      async execute(driver, task, { workspace }) {
        order.push("run:" + task.id);
        completed.push(task);
        const expected = flatExpected(initial, completed);
        await writeFile(path.join(workspace, "main.cpp"), expected["main.cpp"]);
        await writeFile(path.join(workspace, task.file), expected[task.file]);
      },
      async inspect(request) {
        order.push("inspect:" + request.ids[0]);
        return {
          runId: request.runId,
          sequence: request.sequence,
          candidateIdentity: request.candidateIdentity,
        };
      },
      async measure() {
        return { buildPassed: true, resultMatched: true };
      },
      expectedPixels: ["a", "b"],
    });
    assert.deepEqual(order, [
      "run:task-0",
      "inspect:task-0",
      "run:task-2",
      "inspect:task-2",
      "run:task-1",
      "inspect:task-1",
    ]);
    assert.equal(result.status, "complete");
    assert.equal(active, 0);
    assert.ok(result.rounds.every((round) => round.structure.status === "pass"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
