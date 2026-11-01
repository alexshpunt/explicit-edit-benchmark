import assert from "node:assert/strict";
import test from "node:test";
import { selectRecoveryBatch } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery-schedule.mjs";

const candidate = (id, owner, resources) => ({ id, owner, resources });
const span = (start, end, file = "main.cpp") => ({ file, range: [start, end] });
const ids = (candidates) => candidates.map(({ id }) => id);

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("nineteen repairs retain ten fixed owners and drain in input order", () => {
  let pending = Array.from({ length: 19 }, (_, index) =>
    candidate(`repair-${index}`, index % 10, [{ file: `module-${index}.h` }]),
  );
  const original = [...pending];
  const batches = [];
  while (pending.length) {
    const { ready, deferred } = selectRecoveryBatch(pending);
    assert.ok(ready.length > 0);
    assert.equal(new Set(ready.map(({ owner }) => owner)).size, ready.length);
    batches.push(ready);
    pending = deferred;
  }
  assert.deepEqual(batches, [original.slice(0, 10), original.slice(10)]);
  assert.deepEqual(batches.flat(), original);
});

test("disjoint current elements in the same source file can recover concurrently", () => {
  const repairs = [
    candidate("first", 0, [span(0, 10)]),
    candidate("second", 1, [span(10, 20)]),
    candidate("third", 2, [span(30, 40)]),
  ];
  const result = selectRecoveryBatch(repairs);
  assert.deepEqual(result.ready, repairs);
  assert.deepEqual(result.deferred, []);
});

test("overlapping elements defer only incompatible repairs, not their whole connected group", () => {
  const repairs = [
    candidate("first", 0, [span(0, 10)]),
    candidate("middle", 1, [span(9, 21)]),
    candidate("last", 2, [span(20, 30)]),
  ];
  const first = selectRecoveryBatch(repairs);
  assert.deepEqual(ids(first.ready), ["first", "last"]);
  assert.deepEqual(ids(first.deferred), ["middle"]);
  assert.deepEqual(selectRecoveryBatch(first.deferred).ready, [repairs[1]]);
});

test("one owner cannot execute two independent repairs at the same time", () => {
  const repairs = [
    candidate("first", 7, [{ file: "first.h" }]),
    candidate("second", 7, [{ file: "second.h" }]),
    candidate("other-owner", 3, [{ file: "third.h" }]),
  ];
  assert.deepEqual(ids(selectRecoveryBatch(repairs).ready), ["first", "other-owner"]);
  assert.deepEqual(ids(selectRecoveryBatch(repairs).deferred), ["second"]);
});

test("an unknown whole-file footprint conflicts with every element in that file in either order", () => {
  const unknown = candidate("unknown", 0, [{ file: "main.cpp" }]);
  const bounded = candidate("bounded", 1, [span(50, 80)]);
  const unrelated = candidate("unrelated", 2, [{ file: "separate.h" }]);
  for (const [first, second] of [
    [unknown, bounded],
    [bounded, unknown],
  ]) {
    const result = selectRecoveryBatch([first, second, unrelated]);
    assert.deepEqual(result.ready, [first, unrelated]);
    assert.deepEqual(result.deferred, [second]);
  }
});

test("any intersecting resource blocks a repair while distinct destination files remain independent", () => {
  const repairs = [
    candidate("header", 0, [{ file: "module.h" }, span(100, 150)]),
    candidate("implementation", 1, [{ file: "module.cpp" }, span(140, 160)]),
    candidate("other-header", 2, [{ file: "other.h" }, span(0, 150, "other.cpp")]),
    candidate("duplicate-destination", 3, [{ file: "module.h" }]),
  ];
  const result = selectRecoveryBatch(repairs);
  assert.deepEqual(ids(result.ready), ["header", "other-header"]);
  assert.deepEqual(ids(result.deferred), ["implementation", "duplicate-destination"]);
});

test("zero-width insertion points conflict at either boundary without merging adjacent nonempty ranges", () => {
  const cases = [
    [span(0, 10), span(10, 20), false],
    [span(10, 20), span(0, 0), false],
    [span(10, 20), span(10, 10), true],
    [span(10, 20), span(15, 15), true],
    [span(10, 20), span(20, 20), true],
    [span(10, 20), span(21, 21), false],
    [span(10, 10), span(10, 10), true],
    [span(10, 10), span(11, 11), false],
    [span(10, 10), span(10, 10, "other.cpp"), false],
    [span(0, 30), span(10, 20), true],
  ];
  for (const [left, right, conflict] of cases) {
    for (const resources of [
      [left, right],
      [right, left],
    ]) {
      const result = selectRecoveryBatch([
        candidate("left", 0, [resources[0]]),
        candidate("right", 1, [resources[1]]),
      ]);
      assert.equal(result.ready.length, conflict ? 1 : 2);
      assert.equal(result.deferred.length, conflict ? 1 : 0);
    }
  }
});

test("selection preserves frozen candidates, extra data and resource identity without hidden state", () => {
  const first = { ...candidate("one", 0, [span(0, 30)]), feedback: { revision: 4 } };
  const second = candidate("two", 1, [span(20, 50)]);
  const input = freeze([first, second]);
  const result = selectRecoveryBatch(input);
  assert.equal(result.ready[0], first);
  assert.equal(result.ready[0].feedback, first.feedback);
  assert.equal(result.deferred[0], second);
  assert.notEqual(result.ready, input);
  assert.deepEqual(selectRecoveryBatch(input), result);
  assert.deepEqual(selectRecoveryBatch([]), { ready: [], deferred: [] });
});

test("malformed candidates and unverified range coordinates are rejected before selection", () => {
  const valid = () => candidate("valid", 0, [span(0, 1)]);
  const malformed = [
    undefined,
    null,
    {},
    "not-an-array",
    [null],
    [undefined],
    [[]],
    [{ ...valid(), id: "" }],
    [{ ...valid(), id: 2 }],
    [valid(), valid()],
    ...[-1, 10, 0.5, NaN, Infinity, "0", null, undefined].map((owner) => [{ ...valid(), owner }]),
    ...[null, undefined, {}, [], [null], [{}], [{ file: "" }], [{ file: 5 }], [[]]].map(
      (resources) => [{ ...valid(), resources }],
    ),
    ...[
      null,
      {},
      [],
      [0],
      [0, 1, 2],
      [-1, 2],
      [2, 1],
      [0.5, 2],
      [0, NaN],
      [0, Infinity],
      ["0", 1],
      [0, Number.MAX_SAFE_INTEGER + 1],
    ].map((range) => [candidate("invalid-range", 0, [{ file: "main.cpp", range }])]),
    [valid(), { ...valid(), id: "late-invalid", resources: [] }],
  ];
  for (const input of malformed)
    assert.throws(() => selectRecoveryBatch(input), assert.AssertionError);
});
