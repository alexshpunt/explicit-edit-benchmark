import assert from "node:assert/strict";
import test from "node:test";
import { publicEditingTasks } from "../renderer/pi-independent-reference.mjs";

import {
  atomicDeliveryIds,
  streamDeliveryWorkIds,
  latestStreamDeliveries,
  validateAtomicParents,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
const original = {
  id: "task-001-edit-00001",
  operations: [
    { phase: "structure", action: "header", file: "module.h", guard: "MODULE_H", includes: [] },
  ],
};
const correction = (id = "repair-round-001-attempt-2-point-0") => ({
  id,
  operations: [
    {
      phase: "repair",
      action: "rename-binding",
      target: {
        file: "module.h",
        identifier: 5,
        name: "Old",
        role: "field",
        translationUnit: "main.cpp",
      },
      required: { name: "restored" },
      category: "fields",
      files: ["module.h", "main.cpp"],
    },
  ],
});
const metadata = (tasks) => ({
  deliveryKind: "barrier-repair",
  atomicId: tasks[0]?.id,
  atomicIds: [],
  repairTasks: tasks,
});

test("fresh repair transport uses only the current problem payload without an original atom lookup", () => {
  const problem = { ...correction(), original, privateBindings: [{ usr: "PRIVATE_USR" }] };
  const trap = {
    get() {
      throw Error("No original task lookup is permitted");
    },
  };
  const selected = publicEditingTasks(metadata([problem]), trap);
  assert.deepEqual(selected, [{ id: problem.id, operations: problem.operations }]);
  assert.equal(JSON.stringify(selected).includes("PRIVATE_USR"), false);
  assert.equal(JSON.stringify(selected).includes(original.id), false);
});

test("fresh problem work has bounded identities but no original atom or parent coverage", () => {
  const task = correction();
  const delivery = {
    atomicId: task.id,
    atomicIds: [],
    repairIds: [task.id],
    deliveryKind: "barrier-repair",
  };
  assert.deepEqual(atomicDeliveryIds(delivery), []);
  assert.deepEqual(streamDeliveryWorkIds(delivery), [task.id]);
  assert.equal(latestStreamDeliveries([delivery]).size, 0);
  validateAtomicParents(delivery, [], ["task-001"]);
  assert.throws(() => validateAtomicParents(delivery, ["task-001"], ["task-001"]));
  assert.throws(() => atomicDeliveryIds({ ...delivery, atomicIds: [original.id] }));
  assert.throws(() => atomicDeliveryIds({ ...delivery, atomicId: "repair-round-001-other" }));
  const many = {
    ...delivery,
    repairIds: Array.from({ length: 51 }, (_, index) => `${task.id}-${index}`),
  };
  many.atomicId = many.repairIds[0];
  assert.throws(() => validateAtomicParents(many, [], ["task-001"]));
  validateAtomicParents(many, [], ["task-001"], { batchSize: 51 });
});

test("original editing deliveries still resolve their disclosed atom IDs", () => {
  const selected = publicEditingTasks(
    { atomicId: original.id, atomicIds: [original.id] },
    new Map([[original.id, original]]),
  );
  assert.deepEqual(selected, [original]);
});

test("repair transport rejects historical atom replay and undisclosed tasks", () => {
  const tasks = new Map([[original.id, original]]);
  const problem = correction();
  const reject = (value) => assert.throws(() => publicEditingTasks(value, tasks));
  reject({ ...metadata([problem]), atomicIds: [original.id] });
  reject(metadata([{ ...problem, operations: original.operations }]));
  reject(metadata([{ ...problem, id: original.id }]));
  reject(metadata([{ ...problem, id: "repair-" }]));
  reject(metadata([{ ...problem, id: "repair-../../private" }]));
  reject({ ...metadata([problem]), atomicId: "repair-wrong-problem" });
  reject(metadata([]));
  reject(metadata([problem, problem]));
  reject({ atomicIds: [original.id], repairTasks: [problem] });
});

test("repair message bounds count fresh problems and respect the configured delivery size", () => {
  const problems = Array.from({ length: 51 }, (_, index) =>
    correction(`repair-round-001-attempt-2-${index}`),
  );
  assert.throws(() => publicEditingTasks(metadata(problems), new Map()));
  assert.equal(publicEditingTasks({ ...metadata(problems), batchSize: 51 }, new Map()).length, 51);
  assert.throws(() => publicEditingTasks({ ...metadata([problems[0]]), batchSize: 0 }, new Map()));
});
