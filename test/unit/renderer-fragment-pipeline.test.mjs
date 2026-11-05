import assert from "node:assert/strict";
import test from "node:test";
import { prepareFragmentStructure } from "../../src/suites/explicit-edit-multi-agent/extraction/fragment-structure.mjs";
import { fragmentSnapshotScore } from "../../src/suites/explicit-edit-multi-agent/extraction/fragment-score.mjs";
import { runFinalChunkRecovery } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-final-recovery.mjs";

test("the initial file repair clears a single fragment and earns half its penalty", async () => {
  const a = "int a(){return 1;}",
    b = "int b(){return 2;}",
    keep = "int main(){return 0;}\n";
  const source = `${a}\n${b}\n${keep}`,
    destination = `${a}\n${b}\n`;
  const plan = {
    initial: { "main.cpp": source },
    expected: { "main.cpp": keep, "a.cpp": destination },
    tasks: [
      {
        id: "task",
        file: "a.cpp",
        kind: "implementation",
        replacement: "",
        destination,
        fragments: [
          { id: "a", start: 0, end: a.length, text: a },
          { id: "b", start: a.length + 1, end: a.length + 1 + b.length, text: b },
        ],
      },
    ],
  };
  const assess = await prepareFragmentStructure(plan);
  let candidate = { "main.cpp": `${b}\n${keep}`, "a.cpp": `${a}\n` };
  const repairs = [];
  const result = await runFinalChunkRecovery({
    totalFiles: 1,
    async capture({ assessStructure, measureIntegration }) {
      return {
        ...(assessStructure ? { structure: await assess(candidate) } : {}),
        ...(measureIntegration ? { integration: { buildPassed: true, resultMatched: true } } : {}),
      };
    },
    async structuralWave(run) {
      await run();
    },
    async repairStructural({ id }) {
      repairs.push(id);
      candidate = plan.expected;
    },
    async repairIntegration() {
      assert.fail("No integration correction");
    },
    score: fragmentSnapshotScore,
  });
  assert.deepEqual(repairs, ["task"]);
  assert.equal(result.score.structural.totalFragments, 2);
  assert.equal(result.score.structural.resolved.length, 1);
  assert.equal(result.score.score, 75);
});
