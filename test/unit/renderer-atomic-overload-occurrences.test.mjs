import assert from "node:assert/strict";
import test from "node:test";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { prepareAtomicNamingBatch } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";

function setup() {
  const source =
    "struct Original {};\nstruct Peer {};\nvoid inspect(Original value) {}\nvoid inspect(Peer value) {}\n";
  const initial = { "main.h": source };
  const node = { id: "type", taskId: "names", dependencies: [], operations: [{ phase: "names" }] };
  const batch = prepareAtomicNamingBatch(initial, [
    {
      id: node.id,
      plan: {
        edits: [...source.matchAll(/\bOriginal\b/g)].map((match) => ({
          file: "main.h",
          start: match.index,
          old: "Original",
          new: "Restored",
        })),
      },
    },
  ]);
  return {
    initial,
    checkpoint: createAtomicCheckpoint(initial, [node], [{ taskId: "names", batch }]),
  };
}

test("a type mask cannot confuse its physical overload with an unrelated identical-body overload", () => {
  const { initial, checkpoint } = setup();
  assert.equal(checkpoint.check(initial, "type", { input: true }).status, "pass");
  const completed = new Set(["type"]);
  const output = checkpoint.expected(completed).tree;
  assert.equal(checkpoint.check(output, "type", { completed }).status, "pass");
  assert.equal(checkpoint.check(initial, "type").status, "fail");
  const mistaken = { "main.h": initial["main.h"].replaceAll("Original", "Mistaken") };
  assert.equal(checkpoint.check(mistaken, "type", { input: true }).status, "pass");
  assert.equal(checkpoint.check(mistaken, "type").status, "fail");
});

test("physical overload selection retains peer tokens and the global copy denominator", () => {
  const { initial, checkpoint } = setup();
  for (const text of [
    initial["main.h"].replace("inspect(Peer value)", "inspect(Other value)"),
    initial["main.h"] + "void inspect(Original value) {}\n",
    initial["main.h"].replace("void inspect(Peer value) {}\n", ""),
  ])
    assert.notEqual(checkpoint.check({ "main.h": text }, "type", { input: true }).status, "pass");
  assert.notEqual(
    checkpoint.check({ ...initial, "extra.h": "void inspect(Original value) {}\n" }, "type", {
      input: true,
    }).status,
    "pass",
  );
});
