import assert from "node:assert/strict";
import test from "node:test";
import { createAtomicInventory } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-inventory.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";

const source = "int sum(int left) { return left + 7; }\n";

await test("atomic inventory reuse is bounded to the exact source and file paths", () => {
  const read = createAtomicInventory();
  const tree = { "main.cpp": source };
  const first = read(tree);
  assert.equal(read({ ...tree }), first);
  tree["main.cpp"] = source.replace("7", "8");
  const changed = read(tree);
  assert.notEqual(changed, first);
  assert.deepEqual(changed, prepareCoherentContract(tree));
  const moved = read({ "other.cpp": tree["main.cpp"] });
  assert.notEqual(moved, changed);
  assert.equal(moved.obligations[0].file, "other.cpp");
  // Returning to an older source reparses instead of retaining a history of trees.
  assert.notEqual(read({ "main.cpp": source }), first);
});

await test("clearing an inventory releases reuse without changing lexical requirements", () => {
  const read = createAtomicInventory();
  const tree = { "main.cpp": source };
  const first = read(tree);
  read.clear();
  read.clear();
  const rebuilt = read(tree);
  assert.notEqual(rebuilt, first);
  assert.deepEqual(rebuilt, first);
  tree["main.cpp"] = source.replace("7", "8");
  assert.notDeepEqual(read(tree), rebuilt);
});

await test("callers cannot poison reused inventory records or tokens", () => {
  const read = createAtomicInventory();
  const tree = { "main.cpp": source };
  const inventory = read(tree);
  assert.throws(() => inventory.obligations.pop(), TypeError);
  assert.throws(() => (inventory.obligations[0].tokens[0] = "corrupt"), TypeError);
  assert.deepEqual(read(tree), prepareCoherentContract(tree));
});

await test("malformed and changed inactive source cannot reuse a passing inventory", () => {
  const read = createAtomicInventory();
  const tree = {
    "main.cpp":
      "#if MODE\nint active() { return 1; }\n#else\nint inactive() { return 2; }\n#endif\n",
  };
  const before = read(tree);
  tree["main.cpp"] = tree["main.cpp"].replace("return 2", "return 3");
  assert.notDeepEqual(read(tree), before);
  tree["main.cpp"] = "int broken(";
  assert.throws(() => read(tree));
  assert.throws(() => read(tree));
});

await test("binding decisions remain fresh while unchanged lexical records are reused", () => {
  const readInventory = createAtomicInventory();
  const expected = prepareCoherentContract({ "main.cpp": source });
  const owner = expected.obligations.find((record) => record.kind === "owner");
  const projection = {
    records: [
      {
        ...owner,
        masks: owner.tokens.flatMap((token, index) =>
          token === "left" ? [{ index, from: "a", to: "left", role: "current" }] : [],
        ),
      },
    ],
  };
  const tree = { "main.cpp": source };
  const passed = evaluateAtomicBindingGate(tree, projection, { readInventory });
  assert.equal(passed.status, "pass");
  const second = evaluateAtomicBindingGate(tree, projection, { readInventory });
  assert.notEqual(second, passed);
  tree["main.cpp"] = source.replaceAll("left", "a");
  assert.equal(evaluateAtomicBindingGate(tree, projection, { readInventory }).status, "fail");
  tree["main.cpp"] = source.replace("7", "8");
  assert.equal(
    evaluateAtomicBindingGate(tree, projection, { readInventory }).status,
    "unobservable",
  );
});
