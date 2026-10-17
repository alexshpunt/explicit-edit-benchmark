import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coupleAtomicBindings,
  validateAtomicBindingCoupling,
} from "../../src/suites/explicit-edit-multi-agent/cpp/atomic-binding-coupling.mjs";

const edit = (start) => ({ file: "main.cpp", start, old: "old", new: "renamed" });
function binding(declaration, uses) {
  const edits = [edit(declaration), ...uses.map(edit)];
  return {
    plan: { id: "request", edits },
    signature: JSON.stringify(edits),
    mapping: { from: "old", to: "renamed" },
    entries: [{ offset: declaration, name: "old", newName: "renamed", role: "function" }],
    joinedSites: new Map(
      edits.map((item) => [
        JSON.stringify([item.file, item.start]),
        new Map([[item.start, { start: item.start, old: item.old, new: item.new }]]),
      ]),
    ),
  };
}
const options = (sharedCall) => ({
  sharedCall,
  origin: (entry) => ({ file: "main.cpp", start: entry.offset, role: "function" }),
  sourceSha256: "a".repeat(64),
});

test("only positively proven connected overlaps become one inseparable edit", () => {
  const first = binding(0, [100]),
    second = binding(10, [100, 200]),
    third = binding(20, [200]),
    independent = binding(30, [300]);
  const calls = [];
  const groups = coupleAtomicBindings(
    [first, second, third, independent],
    options((input) => {
      calls.push(input);
      return true;
    }),
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.bindingCount),
    [3, 1],
  );
  assert.deepEqual(
    groups.map((group) => group.plan.edits.length),
    [5, 2],
  );
  assert.equal(groups[1].coupling, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[0].required.map((entry) => entry.offset),
    [0, 10],
  );
  assert.deepEqual(
    calls[1].required.map((entry) => entry.offset),
    [10, 20],
  );
  assert.ok(calls.every((input) => input.allowed.length === 3));
  validateAtomicBindingCoupling(groups[0], 3);
  validateAtomicBindingCoupling(groups[1], 1);
});

test("an unknown shared reference cannot be joined even when edits are identical", () => {
  const bindings = [binding(0, [100]), binding(10, [100])];
  const before = structuredClone(bindings);
  assert.throws(
    () =>
      coupleAtomicBindings(
        bindings,
        options(() => false),
      ),
    /Partially overlapping/,
  );
  assert.deepEqual(bindings, before);
});

test("one physical site must have complete shared coverage in every joined view", () => {
  const first = binding(0, [100]),
    second = binding(10, [100]);
  second.joinedSites
    .get(JSON.stringify(["main.cpp", 100]))
    .set(1000, { start: 1000, old: "old", new: "renamed" });
  assert.throws(
    () =>
      coupleAtomicBindings(
        [first, second],
        options(() => true),
      ),
    /Partially overlapping/,
  );
});

test("coupling never crosses mappings or non-function declarations", () => {
  const first = binding(0, [100]),
    second = binding(10, [100]);
  second.mapping.to = "other";
  assert.throws(
    () =>
      coupleAtomicBindings(
        [first, second],
        options(() => true),
      ),
    /Partially overlapping/,
  );
  second.mapping.to = "renamed";
  second.entries[0].role = "variable";
  assert.throws(
    () =>
      coupleAtomicBindings(
        [first, second],
        options(() => true),
      ),
    /Partially overlapping/,
  );
});

test("sealed coupling evidence must cover distinct declarations and one connected unit", () => {
  const groups = coupleAtomicBindings(
    [binding(0, [100]), binding(10, [100, 200]), binding(20, [200])],
    options(() => true),
  );
  const original = groups[0];
  assert.throws(
    () => validateAtomicBindingCoupling({ ...original, coupling: undefined }, 3),
    /Missing compiler-certified/,
  );
  const disconnected = structuredClone(original);
  disconnected.coupling.sites.pop();
  assert.throws(() => validateAtomicBindingCoupling(disconnected, 3), /not one connected/);
  const missing = structuredClone(original);
  missing.coupling.members[0][0].start = 999;
  assert.throws(() => validateAtomicBindingCoupling(missing, 3), /declaration origin/);
  const duplicated = structuredClone(original);
  duplicated.coupling.members[1][0] = { ...duplicated.coupling.members[0][0] };
  assert.throws(() => validateAtomicBindingCoupling(duplicated, 3), /declaration origin/);
  assert.throws(() => validateAtomicBindingCoupling(original, 1), /singleton/);
});
