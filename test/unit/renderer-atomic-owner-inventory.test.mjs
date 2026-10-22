import assert from "node:assert/strict";
import test from "node:test";
import { atomicFileOwners } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { createAtomicInventory } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-inventory.mjs";

const source = {
  "one.h": "namespace n { int f(int a) { return a + 1; } int f(int a) { return a + 1; } }\n",
  "two.h": "#if FIRST\nint g(int b) { return b; }\n#else\nint g(int b) { return b; }\n#endif\n",
};

test("physical owner boundaries can use the complete current inventory without losing copies or branches", () => {
  const read = createAtomicInventory();
  const contract = read(source);
  assert.deepEqual(atomicFileOwners(source, { contract }), atomicFileOwners(source));
  for (const [file, text] of Object.entries(source)) {
    const owners = atomicFileOwners({ [file]: text }, { contract });
    assert.deepEqual(owners, atomicFileOwners({ [file]: text }));
    assert.ok(owners.length >= 2);
    assert.ok(owners.every((owner) => contract.obligations.includes(owner.record)));
  }
});

test("reused lexical identities still locate actual current boundaries after layout changes", () => {
  const read = createAtomicInventory();
  const tree = { ...source };
  for (const layout of ["\n\n", "/* retained comment */\n", ""]) {
    tree["one.h"] = layout + source["one.h"];
    assert.deepEqual(atomicFileOwners(tree, { contract: read(tree) }), atomicFileOwners(tree));
  }
});

test("an old inventory cannot authorize an owner whose actual protected tokens changed", () => {
  const read = createAtomicInventory();
  const contract = read(source);
  const changed = { ...source, "one.h": source["one.h"].replaceAll("+ 1", "+ 2") };
  assert.throws(() => atomicFileOwners(changed, { contract }), /owner inventory alignment/);
  assert.deepEqual(
    atomicFileOwners(changed, { contract: read(changed) }),
    atomicFileOwners(changed),
  );
});
