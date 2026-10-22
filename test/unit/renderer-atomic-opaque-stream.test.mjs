import assert from "node:assert/strict";
import test from "node:test";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { prepareAtomicNamingBatch } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";

const source = `#define BIAS 7
#ifndef COUPLED_H
#define COUPLED_H
#ifdef MODE
int sum(int left,
#else
int sum(double left,
#endif
int right) { const char* text = "left"; return left + right + BIAS; }
#endif
int peer() { return 3; }
`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const initial = { "main.cpp": source };
  const nodes = [
    ["left-binding", "left", "longLeft"],
    ["right-binding", "right", "r"],
  ].map(([id, from, to]) => ({
    id,
    from,
    to,
    taskId: "conditional-parameters",
    dependencies: [],
    operations: [{ phase: "names" }],
  }));
  // These tiny trusted plans exercise sparse-mask composition, not compiler
  // certification; real compiler-to-runner coverage lives in the renderer tests.
  const batch = prepareAtomicNamingBatch(
    initial,
    nodes.map((node) => ({
      id: node.id,
      plan: {
        edits: cppTokens(source)
          .filter((token) => token.text === node.from)
          .map((token) => ({
            file: "main.cpp",
            start: token.start,
            old: node.from,
            new: node.to,
          })),
      },
    })),
  );
  assert.equal(batch.owners.length, 1);
  assert.equal(batch.owners[0].kind, "conditional");
  assert.equal(batch.owners[0].opaque, true);
  const checkpoint = createAtomicCheckpoint(initial, nodes, [
    { taskId: "conditional-parameters", batch },
  ]);
  return { initial, nodes, checkpoint };
}

function rename(tree, node, partial = false) {
  let text = tree["main.cpp"];
  const tokens = cppTokens(text).filter((token) => token.text === node.from);
  for (const token of (partial ? tokens.slice(0, 1) : tokens).reverse())
    text = text.slice(0, token.start) + node.to + text.slice(token.end);
  return { "main.cpp": text };
}

const decision = (result) =>
  result.status === "pass" ? true : result.status === "pending" ? "pending" : false;
function gates(checkpoint, read) {
  return {
    checkInputs: async (node, signal, context) =>
      decision(await checkpoint.observe(read, node.id, context, { input: true, signal })),
    verify: async (node, signal, _receipt, context) =>
      decision(await checkpoint.observe(read, node.id, context, { signal })),
  };
}

await test(
  "independent opaque-conditional bindings overlap without changing inactive syntax or literals",
  { timeout: 5_000 },
  async () => {
    const { initial, nodes, checkpoint } = fixture();
    let tree = initial;
    const started = new Set();
    const bothStarted = deferred();
    const participants = new Set();
    const result = await runAtomicStream(nodes, {
      agents: 2,
      ...gates(checkpoint, async () => ({ ...tree })),
      execute: async (node, agent) => {
        started.add(node.id);
        participants.add(agent);
        if (started.size === 2) bothStarted.resolve();
        await bothStarted.promise;
        assert.equal(started.size, 2, "Both deliveries must start before either edit finishes");
        tree = rename(tree, node);
      },
    });
    assert.equal(result.status, "pass");
    assert.equal(result.completed.size, 2);
    assert.equal(participants.size, 2);
    assert.deepEqual(tree, checkpoint.expected(result.completed).tree);
    assert.ok(tree["main.cpp"].includes("int sum(double longLeft,"));
    assert.ok(tree["main.cpp"].includes('const char* text = "left";'));
  },
);

await test(
  "an incomplete conditional peer does not revoke a correct binding and receives one repair",
  { timeout: 5_000 },
  async () => {
    const { initial, nodes, checkpoint } = fixture();
    let tree = initial;
    const read = async () => ({ ...tree });
    const started = new Set();
    const bothStarted = deferred();
    const partialWritten = deferred();
    const calls = [];
    const first = await runAtomicStream(nodes, {
      agents: 2,
      ...gates(checkpoint, read),
      execute: async (node) => {
        calls.push(node.id);
        started.add(node.id);
        if (started.size === 2) bothStarted.resolve();
        await bothStarted.promise;
        if (node.id === "right-binding") {
          tree = rename(tree, node, true);
          partialWritten.resolve();
        } else {
          await partialWritten.promise;
          tree = rename(tree, node);
        }
      },
    });
    assert.equal(first.status, "blocked");
    assert.deepEqual([...first.completed], ["left-binding"]);
    assert.ok(tree["main.cpp"].includes("return longLeft + right"));
    const retained = checkpoint.revalidate(tree, {
      completed: first.completed,
      started: first.started,
    });
    assert.deepEqual([...retained.completed], ["left-binding"]);
    const repaired = await runAtomicStream(nodes, {
      agents: 2,
      completed: retained.completed,
      started: first.started,
      owners: first.owners,
      rotation: first.rotation,
      ...gates(checkpoint, read),
      execute: async (node) => {
        calls.push(node.id);
        tree = rename(tree, node);
      },
    });
    assert.equal(repaired.status, "pass");
    assert.equal(calls.filter((id) => id === "left-binding").length, 1);
    assert.equal(calls.filter((id) => id === "right-binding").length, 2);
    assert.deepEqual(tree, checkpoint.expected(repaired.completed).tree);
  },
);

await test("the combined stream and retained checkpoint reject corrupted inactive conditional syntax", async () => {
  const { initial, nodes, checkpoint } = fixture();
  let tree = initial;
  const read = async () => ({ ...tree });
  const result = await runAtomicStream(nodes, {
    agents: 2,
    ...gates(checkpoint, read),
    execute: async (node) => {
      tree = rename(tree, node);
    },
  });
  assert.equal(result.status, "pass");
  assert.equal(
    checkpoint.revalidate(tree, { completed: result.completed, started: result.started }).completed
      .size,
    2,
  );
  tree = { "main.cpp": tree["main.cpp"].replace("double longLeft", "float longLeft") };
  const retained = checkpoint.revalidate(tree, {
    completed: result.completed,
    started: result.started,
  });
  assert.equal(
    retained.completed.size,
    0,
    "An unchanged trusted frontier must reread candidate syntax",
  );
  const blocked = await runAtomicStream(nodes, {
    agents: 2,
    started: result.started,
    owners: result.owners,
    ...gates(checkpoint, read),
    execute: async () => assert.fail("Corrupted protected inputs must block before dispatch"),
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.completed.size, 0);
});
