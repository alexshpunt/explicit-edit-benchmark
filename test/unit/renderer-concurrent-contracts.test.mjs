import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { contractTransition } from "../../src/suites/explicit-edit-multi-agent/tasks/concurrent-schedule.mjs";
import { checkpointContracts } from "../../src/suites/explicit-edit-multi-agent/grading/concurrent-contracts.mjs";

const initial = {
  "main.cpp": `#ifndef _GEOMETRY_H_
#define _GEOMETRY_H_
#ifndef _MATH_H_
#define _MATH_H_
namespace frond { struct Number { int value; }; }
#endif
namespace frond { struct Geometry { Number value; }; }
#endif
#ifndef _COLOR_H_
#define _COLOR_H_
namespace frond { struct Color { Number Old; }; }
#endif
int main() { return 0; }
`,
};
const header = (id, file, guard, includes) => ({
  id,
  phase: "structure",
  subsystem: file,
  operations: [{ action: "header", file, guard, includes }],
});
const tasks = [
  header("math", "math.h", "_MATH_H_", []),
  header("geometry", "geometry.h", "_GEOMETRY_H_", ["math.h"]),
  header("color", "color.h", "_COLOR_H_", ["math.h"]),
  { id: "color-names", phase: "names", subsystem: "color.h", operations: [] },
];
let expected = initial;
const states = [prepareCoherentContract(initial)];
for (const task of tasks.slice(0, 3)) {
  expected = task.operations.reduce(applyCoherentStructure, expected);
  states.push(prepareCoherentContract(expected));
}
const final = { ...expected, "color.h": expected["color.h"].replace("Number Old", "Number value") };
states.push(prepareCoherentContract(final));
const transitions = tasks.map((task, index) =>
  contractTransition(task.id, states[index], states[index + 1]),
);
const round = (id, ...ids) => ({ id, assignments: ids.map((task) => ({ task })) });

test("partial module checkpoints are built from trusted moves, not sequential guard-context deltas or candidate source", () => {
  const schedule = [
    round("first", "math"),
    round("second", "color", "color-names"),
    round("third", "geometry"),
  ];
  const contracts = checkpointContracts(initial, states[0], tasks, transitions, schedule);
  let actual = tasks[0].operations.reduce(applyCoherentStructure, initial);
  actual = tasks[2].operations.reduce(applyCoherentStructure, actual);
  actual = { ...actual, "color.h": actual["color.h"].replace("Number Old", "Number value") };
  assert.equal(evaluateCoherentContract(actual, contracts.get("second")).status, "pass");
  assert.equal(
    evaluateCoherentContract({ ...actual, "geometry.h": "" }, contracts.get("second")).status,
    "fail",
  );
  assert.equal(
    evaluateCoherentContract(
      { ...actual, "color.h": actual["color.h"].replace("Number value", "int value") },
      contracts.get("second"),
    ).status,
    "fail",
  );
  actual = tasks[1].operations.reduce(applyCoherentStructure, actual);
  assert.equal(evaluateCoherentContract(actual, contracts.get("third")).status, "pass");
  assert.equal(evaluateCoherentContract(final, contracts.get("third")).status, "pass");
  assert.equal(initial["main.cpp"].includes("Number Old"), true);
});

test("ready sibling headers may publish in either order with identical cumulative requirements", () => {
  const forwards = [
    round("first", "math"),
    round("second", "geometry", "color"),
    round("third", "color-names"),
  ];
  const reversed = [forwards[0], round("second", "color", "geometry"), forwards[2]];
  const left = checkpointContracts(initial, states[0], tasks, transitions, forwards);
  const right = checkpointContracts(initial, states[0], tasks, transitions, reversed);
  const normalize = (contract) => ({
    ...contract,
    obligations: [...contract.obligations].sort((a, b) => a.id.localeCompare(b.id)),
  });
  for (const checkpoint of forwards)
    assert.deepEqual(normalize(left.get(checkpoint.id)), normalize(right.get(checkpoint.id)));
});
