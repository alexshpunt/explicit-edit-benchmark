import assert from "node:assert/strict";
import test from "node:test";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { preparePairedExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/paired-plan.mjs";

import { pairedExtractionFixture as fixture } from "../helpers/module-extraction-generation.mjs";

test("a selected pair and its header-only dependencies are complete separate file assignments", () => {
  const input = fixture(),
    initial = structuredClone(input.initial);
  const plan = preparePairedExtraction({ ...input, modules: ["frond_a"], agents: 1 });
  assert.equal(plan.version, "renderer-module-extraction-plan-v2");
  assert.equal(plan.scope, "experimental-module-pairs");
  assert.equal(plan.agents, 1);
  assert.deepEqual(plan.modules, ["frond_a"]);
  assert.deepEqual(
    new Set(plan.tasks.map((task) => task.file)),
    new Set(["frond_a.h", "frond_math.h", "frond_a.cpp"]),
  );
  const implementation = plan.tasks.find((task) => task.file === "frond_a.cpp");
  assert.equal(implementation.kind, "implementation");
  assert.ok(implementation.destination.includes("int operation_a() { return identity(1); }"));
  assert.ok(!plan.expected["main.cpp"].includes("int operation_a() { return identity(1); }"));
  assert.ok(plan.expected["main.cpp"].includes("int operation_b() { return 2; }"));
  assert.ok(plan.expected["main.cpp"].includes("#ifndef B_H"));
  assert.ok(!Object.hasOwn(plan.expected, "frond_b.h"));
  assert.equal(plan.expected["frond_a.cpp"], implementation.destination);
  assert.deepEqual(input.initial, initial);
  assert.equal(plan.initialIdentity, treeIdentity(initial));
  for (const task of plan.tasks)
    for (const fragment of task.fragments)
      assert.equal(fragment.text, initial["main.cpp"].slice(fragment.start, fragment.end));
  const pieces = plan.tasks.flatMap((task) => task.fragments).sort((a, b) => a.start - b.start);
  for (let index = 1; index < pieces.length; index++)
    assert.ok(pieces[index - 1].end <= pieces[index].start);
});

test("header-only modules cannot masquerade as paired modules, and participant count is bound", () => {
  const input = fixture();
  for (const modules of [["frond_math"], ["frond_a.h"], ["frond_a", "frond_a"], []])
    assert.throws(() => preparePairedExtraction({ ...input, modules, agents: 1 }));
  for (const agents of [0, 11, 1.5, NaN])
    assert.throws(() => preparePairedExtraction({ ...input, modules: ["frond_a"], agents }));
  const first = preparePairedExtraction({ ...input, modules: ["frond_a"], agents: 1 });
  const second = preparePairedExtraction({ ...input, modules: ["frond_a"], agents: 2 });
  assert.deepEqual(first.expected, second.expected);
  assert.deepEqual(first.tasks, second.tasks);
  assert.notDeepEqual(first, second);
});
