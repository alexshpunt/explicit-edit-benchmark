import assert from "node:assert/strict";
import test from "node:test";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { prepareAtomicNamingBatch } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";

function fixture() {
  const source =
    "int first(int alpha) { return alpha; }\nint second(int beta) { return beta; }\nint third(int gamma) { return gamma; }\n";
  const tree = { "main.cpp": source };
  const bindings = [
    ["A", "alpha", "a"],
    ["B", "beta", "b"],
    ["C", "gamma", "c"],
  ].map(([id, old, replacement]) => ({
    id,
    plan: {
      edits: [...source.matchAll(new RegExp(`\\b${old}\\b`, "g"))].map((match) => ({
        file: "main.cpp",
        start: match.index,
        old,
        new: replacement,
      })),
    },
  }));
  const nodes = bindings.map(({ id }) => ({
    id,
    taskId: "names",
    dependencies: id === "C" ? ["A", "B"] : [],
    operations: [{ phase: "names" }],
  }));
  const checkpoint = createAtomicCheckpoint(tree, nodes, [
    { taskId: "names", batch: prepareAtomicNamingBatch(tree, bindings) },
  ]);
  const completed = new Set(["A", "B"]);
  const context = {
    completed,
    settled: completed,
    started: new Set(completed),
    writers: new Set(),
  };
  return { tree, checkpoint, context, current: checkpoint.expected(completed).tree };
}

test("readiness checks every prerequisite and current input within one stable source span", async () => {
  const { checkpoint, context, current } = fixture();
  const observations = [];
  let reads = 0;
  const result = await checkpoint.observeInputs(
    async () => {
      reads++;
      return current;
    },
    "C",
    context,
    { onObservation: (id, mode, result) => observations.push([id, mode, result.status]) },
  );
  assert.equal(result.status, "pass");
  assert.equal(reads, 2);
  assert.deepEqual(observations, [
    ["A", "prerequisite-output", "pass"],
    ["B", "prerequisite-output", "pass"],
    ["C", "current-input", "pass"],
  ]);
});

test("a continuation or correct current output never waives a corrupted prerequisite", async () => {
  const { checkpoint, context, current } = fixture();
  context.started.add("C");
  const corrupt = { "main.cpp": current["main.cpp"].replace("return a;", "return 9;") };
  const observed = [];
  const result = await checkpoint.observeInputs(async () => corrupt, "C", context, {
    onObservation: (id, mode) => observed.push([id, mode]),
  });
  assert.notEqual(result.status, "pass");
  assert.deepEqual(observed, [["A", "prerequisite-output"]]);
  assert.equal((await checkpoint.observeInputs(async () => current, "C", context)).status, "pass");
});

test("readiness cannot combine prerequisites from different source snapshots", async () => {
  const { checkpoint, context, current } = fixture();
  let reads = 0;
  const changed = { "main.cpp": current["main.cpp"].replace("return b;", "return 7;") };
  const result = await checkpoint.observeInputs(
    async () => (++reads === 1 ? current : changed),
    "C",
    context,
  );
  assert.equal(result.status, "pending");
  assert.equal(reads, 2);
});

test("a newly verified frontier invalidates the whole readiness observation", async () => {
  const { checkpoint, context, current } = fixture();
  let reads = 0;
  const result = await checkpoint.observeInputs(
    async () => {
      if (++reads === 2) context.settled.add("C");
      return current;
    },
    "C",
    context,
  );
  assert.equal(result.status, "pending");
});

test("structural readiness keeps its already-correct output fallback in the same span", async () => {
  const tree = { "main.cpp": "void first();\nvoid second();\nint keep() { return 1; }\n" };
  const nodes = ["first", "second"].map((name, index) => ({
    id: name,
    dependencies: index ? ["first"] : [],
    operations: [
      {
        phase: "structure",
        action: "remove-generated-declaration",
        file: "main.cpp",
        selector: { scope: "::", declarator: `void${name}()`, definition: false },
      },
    ],
  }));
  const checkpoint = createAtomicCheckpoint(tree, nodes, []);
  const completed = new Set(["first"]),
    context = { completed, settled: completed, started: completed, writers: new Set() };
  const current = checkpoint.expected(new Set(["first", "second"])).tree;
  const observations = [];
  const result = await checkpoint.observeInputs(async () => current, "second", context, {
    onObservation: (id, mode, result) => observations.push([id, mode, result.status]),
  });
  assert.equal(result.status, "pass");
  assert.deepEqual(
    observations.map(([id, mode]) => [id, mode]),
    [
      ["first", "prerequisite-output"],
      ["second", "current-input"],
      ["second", "current-output"],
    ],
  );
});

test("cancelled readiness leaves the common observation lane usable", async () => {
  const { checkpoint, context, current } = fixture();
  const controller = new AbortController();
  controller.abort(Error("case deadline"));
  let reads = 0;
  await assert.rejects(
    checkpoint.observeInputs(
      async () => {
        reads++;
        return current;
      },
      "C",
      context,
      { signal: controller.signal },
    ),
    /case deadline/,
  );
  assert.equal(reads, 0);
  assert.equal((await checkpoint.observe(async () => current, "A", context)).status, "pass");
});

test("crediting an already-settled structural peer does not change a stable readiness frontier", async () => {
  const tree = {
    "main.cpp": "void first();\nvoid second();\nvoid third();\nint keep() { return 1; }\n",
  };
  const nodes = ["first", "second", "third"].map((name, index) => ({
    id: name,
    dependencies: index === 2 ? ["first"] : [],
    operations: [
      {
        phase: "structure",
        action: "remove-generated-declaration",
        file: "main.cpp",
        selector: { scope: "::", declarator: `void${name}()`, definition: false },
      },
    ],
  }));
  for (const input of [true, false]) {
    const checkpoint = createAtomicCheckpoint(tree, nodes, []);
    const settled = new Set(["first", "second"]),
      completed = new Set(["first"]);
    const context = { settled, completed, started: settled, writers: new Set() };
    const current = checkpoint.expected(settled).tree;
    let reads = 0;
    const readSource = async () => {
      if (++reads === 2) completed.add("second");
      return current;
    };
    const result = input
      ? await checkpoint.observeInputs(readSource, "third", context)
      : await checkpoint.observe(readSource, "first", context);
    assert.equal(result.status, "pass");
    assert.equal(reads, 2);
    reads = 0;
    const withdrawn = await checkpoint.observe(
      async () => {
        if (++reads === 2) completed.delete("second");
        return current;
      },
      "first",
      context,
    );
    assert.equal(withdrawn.status, "pending");
  }
});
