import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  scopedNamingSession,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import {
  prepareAtomicNamingBatch,
  createAtomicNamingReplay,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { atomicWorkload } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-workload.mjs";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";

await test("a certified type rename preserves every identical prototype and its full checkpoint count", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/duplicate-naming-owners-"));
  const prototype = "int evaluate(const Old& shape, int element);";
  const tree = {
    "main.cpp": `namespace frond {
struct Old { int value; };
${prototype}
${prototype}
int evaluate(const Old& shape, int element) { return shape.value + element; }
}
int main() { return frond::evaluate({1}, 2); }
`,
  };
  const session = await scopedNamingSession(tree, root);
  try {
    const certification = await session.atomicPlans({
      id: "type",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "Old", to: "Restored" }],
      selectors: [{ kind: "type", scope: "frond::Old" }],
    });
    session.close();
    const { nodes } = atomicWorkload([
      { id: "task-001", phase: "names", operations: [certification.operation] },
    ]);
    assert.equal(nodes.length, 1);
    const id = nodes[0].id;
    const batch = prepareAtomicNamingBatch(tree, [{ id, plan: certification.plan }]);
    const replay = createAtomicNamingReplay(batch);
    const expected = applyScopedNamePlan(tree, certification.plan);
    const result = replay(tree, [id]);
    assert.deepEqual(result.tree, expected);
    assert.equal(
      (result.tree["main.cpp"].match(/int evaluate\(const Restored& shape, int element\);/g) ?? [])
        .length,
      2,
    );
    execFileSync("clang++", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
      input: result.tree["main.cpp"],
    });
    const checkpoint = createAtomicCheckpoint(tree, nodes, [{ taskId: "task-001", batch }]);
    assert.equal(checkpoint.check(tree, id, { input: true }).status, "pass");
    assert.equal(checkpoint.check(expected, id).status, "pass");
    const restoredPrototype = prototype.replace("Old", "Restored");
    for (const source of [
      expected["main.cpp"].replace(restoredPrototype, ""),
      expected["main.cpp"].replace(restoredPrototype, `${restoredPrototype}\n${restoredPrototype}`),
      expected["main.cpp"].replace(restoredPrototype, prototype),
    ]) {
      assert.notEqual(checkpoint.check({ "main.cpp": source }, id).status, "pass");
    }
    const extra = { "main.cpp": tree["main.cpp"].replace(prototype, `${prototype}\n${prototype}`) };
    assert.throws(() => replay(extra, [id]), /ambiguous|repeated.*owner/i);
    replay.clear();
    assert.deepEqual(replay(tree, [id]).tree, expected);
    const missing = { "main.cpp": tree["main.cpp"].replace(prototype, "") };
    assert.throws(() => replay(missing, [id]), /ambiguous|repeated.*owner/i);
    const moved = { "module.cpp": tree["main.cpp"] };
    assert.deepEqual(replay(moved, [id]).tree, { "module.cpp": expected["main.cpp"] });
    const shifted = { "main.cpp": `\n\n${tree["main.cpp"]}` };
    assert.deepEqual(replay(shifted, [id]).tree, { "main.cpp": `\n\n${expected["main.cpp"]}` });
  } finally {
    session.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test("identical copies with distinct binding slots remain ambiguous", () => {
  const tree = { "main.cpp": "int evaluate(int value);\nint evaluate(int value);\n" };
  const sites = cppTokens(tree["main.cpp"]).filter((token) => token.text === "value");
  const batch = prepareAtomicNamingBatch(
    tree,
    sites.map((token, index) => ({
      id: `parameter-${index}`,
      plan: { edits: [{ file: "main.cpp", start: token.start, old: "value", new: "restored" }] },
    })),
  );
  const replay = createAtomicNamingReplay(batch);
  assert.throws(() => replay(tree, ["parameter-0"]), /ambiguous.*owner/i);
  assert.throws(() => replay(tree, ["parameter-0", "parameter-1"]), /ambiguous.*owner/i);
});

await test("uniform copies preserve a correct binding while a peer changes only one copy", () => {
  // Controlled uniform type slots isolate checkpoint aggregation; the preceding
  // test exercises the same duplicate-owner path with real compiler evidence.
  const source = `namespace frond {
struct LeftType { int left; };
struct RightType { double right; };
int evaluate(const LeftType& first, const RightType& second);
int evaluate(const LeftType& first, const RightType& second);
}
`;
  const tree = { "main.cpp": source };
  const bindings = [
    ["A", "LeftType", "RestoredLeft"],
    ["B", "RightType", "RestoredRight"],
  ].map(([id, from, to]) => ({
    id,
    plan: {
      edits: cppTokens(source)
        .filter((token) => token.text === from)
        .map((token) => ({ file: "main.cpp", start: token.start, old: from, new: to })),
    },
  }));
  const batch = prepareAtomicNamingBatch(tree, bindings);
  const replay = createAtomicNamingReplay(batch);
  const nodes = bindings.map(({ id }) => ({
    id,
    taskId: "types",
    dependencies: [],
    operations: [{ phase: "names" }],
  }));
  const checkpoint = createAtomicCheckpoint(tree, nodes, [{ taskId: "types", batch }]);
  for (const selected of [["A"], ["B"], ["A", "B"]]) {
    const expected = replay(tree, selected).tree;
    for (const id of selected)
      assert.equal(checkpoint.check(expected, id, { settled: new Set(selected) }).status, "pass");
  }
  const partial = {
    "main.cpp": replay(tree, ["A"]).tree["main.cpp"].replace(
      "const RightType& second",
      "const RestoredRight& second",
    ),
  };
  const state = { settled: new Set(["A", "B"]), completed: new Set(), writers: new Set() };
  assert.equal(checkpoint.check(partial, "A", state).status, "pass");
  assert.equal(checkpoint.check(partial, "B", state).status, "fail");
  const retained = checkpoint.revalidate(partial, { completed: new Set(["A", "B"]) });
  assert.deepEqual([...retained.completed], ["A"]);
  const badCurrent = {
    "main.cpp": partial["main.cpp"].replace("const RestoredLeft& first", "const LeftType& first"),
  };
  assert.notEqual(checkpoint.check(badCurrent, "A", state).status, "pass");
});

await test("overlapping hinted copy families cannot reuse a physical owner", () => {
  const source = "#ifdef MODE\nint evaluate(int value);\n#else\nint evaluate(int value);\n#endif\n";
  const tree = { "a.cpp": source, "b.cpp": source };
  const edits = Object.entries(tree).flatMap(([file, text]) =>
    cppTokens(text)
      .filter((token) => token.text === "value")
      .map((token) => ({ file, start: token.start, old: "value", new: "restored" })),
  );
  const batch = prepareAtomicNamingBatch(tree, [{ id: "all", plan: { edits } }]);
  assert.doesNotThrow(() => createAtomicNamingReplay(batch)(tree, ["all"]));
  batch.owners[0].fileHint = "a.cpp";
  batch.owners[1].fileHint = "a.cpp";
  batch.owners[2].conditionsHint = batch.owners[0].originConditions;
  batch.owners[3].conditionsHint = batch.owners[0].originConditions;
  assert.throws(() => createAtomicNamingReplay(batch)(tree, ["all"]), /repeated.*owner/i);
});
