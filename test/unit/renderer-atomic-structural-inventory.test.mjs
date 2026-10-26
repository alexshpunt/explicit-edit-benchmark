import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareAtomicEffect } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-structural-effects.mjs";
import { createAtomicInventory } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-inventory.mjs";

const first = "int first() { return 1; }\n";
const second = "int second() { return 2; }\n";
const unchanged = "int untouched() { return 3; }\n";

test("successive structural effects reuse complete current inventories without changing their effects", () => {
  const trees = [
    { "packed.cpp": first + second, "peer.cpp": unchanged },
    { "packed.cpp": second, "first.cpp": first, "peer.cpp": unchanged },
    { "first.cpp": first, "second.cpp": second, "peer.cpp": unchanged },
  ];
  const read = createAtomicInventory();
  const observations = [];
  const readInventory = (tree) => {
    const contract = read(tree);
    observations.push(contract);
    return contract;
  };
  for (let index = 1; index < trees.length; index++) {
    const before = trees[index - 1];
    const after = trees[index];
    assert.deepEqual(
      prepareAtomicEffect(before, after, { readInventory }),
      prepareAtomicEffect(before, after, {}),
    );
  }
  assert.equal(observations.length, 4, "Both trusted snapshots use the supplied inventory reader");
  assert.equal(observations[1], observations[2], "The next input is the exact previous output");
  const peer = observations[0].obligations.filter((record) => record.file === "peer.cpp");
  for (const contract of observations)
    for (const record of peer) assert.ok(contract.obligations.includes(record));
});

test("reused structural inventories still expose in-place changes, relocation and deleted copies", () => {
  const readInventory = createAtomicInventory();
  const before = { "packed.cpp": first + second, "peer.cpp": unchanged };
  const after = { "packed.cpp": second, "first.cpp": first, "peer.cpp": unchanged };
  prepareAtomicEffect(before, after, { readInventory });
  before["peer.cpp"] = "int untouched() { return 99; }\n";
  after["relocated.cpp"] = after["peer.cpp"];
  delete after["peer.cpp"];
  assert.deepEqual(
    prepareAtomicEffect(before, after, { readInventory }),
    prepareAtomicEffect(before, after),
  );
  readInventory.clear();
  assert.deepEqual(
    prepareAtomicEffect(before, after, { readInventory }),
    prepareAtomicEffect(before, after, {}),
  );
});
