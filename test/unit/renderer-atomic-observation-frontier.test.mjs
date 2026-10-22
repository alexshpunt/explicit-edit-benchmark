import assert from "node:assert/strict";
import test from "node:test";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { prepareAtomicNamingBatch } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";

function fixture() {
  const source = "int sum(int left, int right) { return left + right; }\n";
  const tree = { "main.cpp": source };
  const bindings = [
    ["A", "left", "a"],
    ["B", "right", "b"],
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
    dependencies: [],
    operations: [{ phase: "names" }],
  }));
  const checkpoint = createAtomicCheckpoint(tree, nodes, [
    { taskId: "names", batch: prepareAtomicNamingBatch(tree, bindings) },
  ]);
  const started = new Set(),
    writers = new Set(),
    completed = new Set(),
    settled = new Set();
  const context = {
    get started() {
      return new Set(started);
    },
    get writers() {
      return new Set(writers);
    },
    get completed() {
      return new Set(completed);
    },
    get settled() {
      return new Set(settled);
    },
  };
  return { tree, checkpoint, started, writers, completed, settled, context };
}

test("stable source spans are not interleaved with another expensive observation", async () => {
  const { tree, checkpoint, context } = fixture();
  const reads = [];
  const observe = (id) =>
    checkpoint.observe(
      async () => {
        reads.push(id);
        await new Promise((resolve) => setImmediate(resolve));
        return tree;
      },
      id,
      context,
      { input: true },
    );
  const results = await Promise.all([observe("A"), observe("B")]);
  assert.ok(results.every((result) => result.status === "pass"));
  assert.deepEqual(reads, ["A", "A", "B", "B"]);
});

test("a cancelled queued observation does not read source or poison the next span", async () => {
  const { tree, checkpoint, context } = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let firstReads = 0;
  const first = checkpoint.observe(
    async () => {
      if (++firstReads === 1) {
        entered.resolve();
        await release.promise;
      }
      return tree;
    },
    "A",
    context,
    { input: true },
  );
  await entered.promise;
  const controller = new AbortController();
  let queuedReads = 0;
  const queued = checkpoint.observe(
    async () => {
      queuedReads++;
      return tree;
    },
    "B",
    context,
    { input: true, signal: controller.signal },
  );
  controller.abort(Error("queued case deadline"));
  const rejected = assert.rejects(queued, /queued case deadline/);
  release.resolve();
  const [result] = await Promise.all([first, rejected]);
  assert.equal(result.status, "pass");
  assert.equal(queuedReads, 0);
  assert.equal(
    (await checkpoint.observe(async () => tree, "B", context, { input: true })).status,
    "pass",
  );
});

test("a failed observation releases its source span without hiding the I/O error", async () => {
  const { tree, checkpoint, context } = fixture();
  const failure = Object.assign(Error("disk unavailable"), { code: "EIO" });
  const bad = checkpoint.observe(
    async () => {
      throw failure;
    },
    "A",
    context,
    { input: true },
  );
  const good = checkpoint.observe(async () => tree, "B", context, { input: true });
  await assert.rejects(bad, (error) => error === failure);
  assert.equal((await good).status, "pass");
});

test("writer startup alone cannot invalidate a passing observation of unchanged source", async () => {
  for (const input of [false, true]) {
    const { tree, checkpoint, started, writers, context } = fixture();
    const current = input ? tree : checkpoint.expected(new Set(["A"])).tree;
    let reads = 0;
    const result = await checkpoint.observe(
      async () => {
        if (++reads === 2) {
          started.add("B");
          writers.add("B");
        }
        return current;
      },
      "A",
      context,
      { input },
    );
    assert.equal(result.status, "pass");
    assert.equal(reads, 2);
  }
});

test(
  "fifteen independent input observations do not retry merely because the first writer starts",
  { timeout: 10000 },
  async () => {
    const { runAtomicStream } =
      await import("../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs");
    const source = Array.from(
      { length: 15 },
      (_, index) => `int f${index}(int arg${index}) { return arg${index}; }`,
    ).join("\n");
    const tree = { "main.cpp": source };
    const bindings = Array.from({ length: 15 }, (_, index) => ({
      id: `A${index}`,
      plan: {
        edits: [...source.matchAll(new RegExp(`\\barg${index}\\b`, "g"))].map((match) => ({
          file: "main.cpp",
          start: match.index,
          old: `arg${index}`,
          new: `value${index}`,
        })),
      },
    }));
    const nodes = bindings.map(({ id }) => ({
      id,
      taskId: "names",
      dependencies: [],
      operations: [{ phase: "names" }],
    }));
    const checkpoint = createAtomicCheckpoint(tree, nodes, [
      { taskId: "names", batch: prepareAtomicNamingBatch(tree, bindings) },
    ]);
    const firstStarted = Promise.withResolvers();
    const allStarted = Promise.withResolvers();
    const release = Promise.withResolvers();
    const calls = new Map();
    let dispatched = 0;
    const run = runAtomicStream(nodes, {
      agents: 15,
      checkInputs: async (node, signal, context) => {
        calls.set(node.id, (calls.get(node.id) ?? 0) + 1);
        let reads = 0;
        const result = await checkpoint.observe(
          async () => {
            if (++reads === 2 && node.id !== "A0") await firstStarted.promise;
            return tree;
          },
          node.id,
          context,
          { input: true, signal },
        );
        return result.status === "pass" ? true : result.status === "pending" ? "pending" : false;
      },
      execute: async () => {
        if (++dispatched === 1) firstStarted.resolve();
        if (dispatched === 15) allStarted.resolve();
        await release.promise;
      },
      verify: async () => true,
    });
    try {
      await allStarted.promise;
      assert.equal(calls.size, 15);
      assert.ok(
        [...calls.values()].every((count) => count === 1),
        JSON.stringify([...calls]),
      );
    } finally {
      release.resolve();
      await run;
    }
  },
);
test("a new writer still defers a nonpassing observation rather than spending a correction", async () => {
  const { tree, checkpoint, started, writers, context } = fixture();
  const broken = {
    "main.cpp": tree["main.cpp"].replace("return left + right", "return left - right"),
  };
  let reads = 0;
  const result = await checkpoint.observe(
    async () => {
      if (++reads === 2) {
        started.add("B");
        writers.add("B");
      }
      return broken;
    },
    "A",
    context,
    { input: true },
  );
  assert.equal(result.status, "pending");
});

test("source changes and narrowed reservation or verified frontiers still invalidate observations", async () => {
  for (const change of ["source", "reservation", "completion", "settlement"]) {
    const { tree, checkpoint, started, writers, completed, settled, context } = fixture();
    started.add("B");
    writers.add("B");
    const current = checkpoint.expected(new Set(["A"]), started).tree;
    let reads = 0;
    const result = await checkpoint.observe(
      async () => {
        if (++reads === 2) {
          if (change === "reservation") {
            started.delete("B");
            writers.delete("B");
          }
          if (change === "completion") completed.add("B");
          if (change === "settlement") settled.add("B");
          if (change === "source") return tree;
        }
        return current;
      },
      "A",
      context,
    );
    assert.equal(result.status, "pending", change);
  }
});
