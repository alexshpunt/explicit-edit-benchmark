import assert from "node:assert/strict";
import { test } from "node:test";

const modulePath = "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
const { runAtomicStream } = await import(modulePath);
const node = (id, dependencies = []) => ({ id, dependencies });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an input check without a delivery does not consume participant rotation", async () => {
  const result = await runAtomicStream([node("not-ready")], {
    agents: 2,
    rotation: 1,
    checkInputs: async () => false,
    execute: async () => assert.fail("An unmet input cannot dispatch"),
    verify: async () => true,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.rotation, 1);
});

test("writer startup wakes a deferred peer input before the writer finishes", async () => {
  const allowWriter = deferred();
  const writerStarted = deferred();
  const releaseWriter = deferred();
  let peerInputs = 0;
  let peerStarted = false;
  const run = runAtomicStream([node("writer"), node("peer")], {
    agents: 2,
    checkInputs: async (item) => {
      if (item.id === "writer") {
        await allowWriter.promise;
        return true;
      }
      if (++peerInputs === 1) {
        allowWriter.resolve();
        await writerStarted.promise;
        return "pending";
      }
      return true;
    },
    execute: async (item) => {
      if (item.id === "writer") {
        writerStarted.resolve();
        await releaseWriter.promise;
      } else peerStarted = true;
    },
    verify: async () => true,
  });
  await writerStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(
      peerStarted,
      true,
      "Independent input must retry at writer startup, not settlement",
    );
  } finally {
    releaseWriter.resolve();
    await run;
  }
});

test("a free participant receives the next ready edit while its peer is still busy", async () => {
  const releaseSlow = deferred();
  const thirdStarted = deferred();
  const active = new Set();
  const assignments = [];
  const run = runAtomicStream([node("slow"), node("fast"), node("next")], {
    agents: 2,
    async execute(item, agent) {
      assert.ok(!active.has(agent), "a participant cannot execute two edits at once");
      active.add(agent);
      assignments.push([item.id, agent]);
      if (item.id === "slow") await releaseSlow.promise;
      if (item.id === "next") thirdStarted.resolve();
      active.delete(agent);
    },
    verify: async () => true,
  });
  await thirdStarted.promise;
  assert.deepEqual(assignments, [
    ["slow", 0],
    ["fast", 1],
    ["next", 1],
  ]);
  assert.deepEqual([...active], [0]);
  releaseSlow.resolve();
  const result = await run;
  assert.equal(result.status, "pass");
  assert.deepEqual([...result.completed].sort(), ["fast", "next", "slow"]);
});

test("a settled response does not release successors until its structural gate passes", async () => {
  const gate = deferred();
  const entered = deferred();
  const assigned = [];
  const run = runAtomicStream([node("first"), node("second", ["first"])], {
    agents: 2,
    execute: async (item) => {
      assigned.push(item.id);
    },
    async verify(item) {
      if (item.id === "first") {
        entered.resolve();
        await gate.promise;
      }
      return true;
    },
  });
  await entered.promise;
  assert.deepEqual(assigned, ["first"]);
  gate.resolve();
  assert.equal((await run).status, "pass");
  assert.deepEqual(assigned, ["first", "second"]);
});

test("a failed gate stops new dispatch, drains active peers and does not release a dependent edit", async () => {
  const peerStarted = deferred();
  const peerRelease = deferred();
  const failed = deferred();
  const assigned = [];
  const run = runAtomicStream(
    [node("wrong"), node("peer"), node("dependent", ["wrong"]), node("later")],
    {
      agents: 2,
      async execute(item) {
        assigned.push(item.id);
        if (item.id === "peer") {
          peerStarted.resolve();
          await peerRelease.promise;
        }
        if (item.id === "wrong") await peerStarted.promise;
      },
      async verify(item) {
        if (item.id === "wrong") {
          failed.resolve();
          return false;
        }
        return true;
      },
    },
  );
  await failed.promise;
  peerRelease.resolve();
  const result = await run;
  assert.equal(result.status, "blocked");
  assert.deepEqual(assigned, ["wrong", "peer"]);
  assert.deepEqual([...result.completed], ["peer"]);
  assert.deepEqual(result.failed, ["wrong"]);
});

test("repair retains verified edits and rotates the next delivery without silently retrying", async () => {
  const assigned = [];
  const completed = new Set(["retained"]);
  const result = await runAtomicStream([node("retained"), node("repair", ["retained"])], {
    agents: 3,
    completed,
    rotation: 2,
    execute: async (item, agent) => {
      assigned.push([item.id, agent]);
    },
    verify: async () => true,
  });
  assert.equal(result.status, "pass");
  assert.deepEqual(assigned, [["repair", 2]]);
  assert.deepEqual([...completed], ["retained"], "input completion evidence is not mutated");
});

test("driver failure aborts active deliveries and waits for their settlement", async () => {
  const started = deferred();
  const failure = Object.assign(Error("native turn failed"), { category: "driver_exit" });
  let peerClosed = false;
  const run = runAtomicStream([node("bad-driver"), node("peer"), node("never")], {
    agents: 2,
    async execute(item, _agent, signal) {
      if (item.id === "bad-driver") {
        await started.promise;
        throw failure;
      }
      assert.equal(item.id, "peer");
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
        started.resolve();
      });
      await Promise.resolve();
      peerClosed = true;
      signal.throwIfAborted();
    },
    verify: async () => true,
  });
  await assert.rejects(run, (error) => error === failure);
  assert.equal(peerClosed, true);
});

test("a pre-cancelled stream neither dispatches nor structurally verifies an edit", async () => {
  const controller = new AbortController();
  controller.abort(Error("cancelled"));
  await assert.rejects(
    runAtomicStream([node("first")], {
      agents: 2,
      signal: controller.signal,
      execute: async () => assert.fail("unexpected delivery"),
      verify: async () => assert.fail("unexpected gate"),
    }),
    /cancelled/,
  );
});

test("a participant with a pending gate can take unrelated work while its peer is still writing", async () => {
  const releasePeer = deferred();
  let nextStarted = false;
  const assigned = [];
  const result = await runAtomicStream(
    [node("waiting-gate"), node("peer"), node("independent"), node("successor", ["waiting-gate"])],
    {
      agents: 2,
      async execute(item, _agent, signal) {
        assigned.push(item.id);
        if (item.id === "peer")
          await Promise.race([
            releasePeer.promise,
            new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
          ]);
        if (item.id === "independent") {
          nextStarted = true;
          releasePeer.resolve();
        }
        if (item.id === "successor") assert.equal(nextStarted, true);
      },
      async verify(item) {
        return item.id === "waiting-gate" && !nextStarted ? "pending" : true;
      },
    },
  );
  assert.equal(result.status, "pass");
  assert.ok(assigned.indexOf("independent") < assigned.indexOf("successor"));
});

test("a regressed prerequisite is checked again before its successor receives a delivery", async () => {
  const assigned = [];
  const result = await runAtomicStream([node("first"), node("dependent", ["first"])], {
    agents: 2,
    execute: async (item) => {
      assigned.push(item.id);
    },
    verify: async () => true,
    checkInputs: async (item) => item.id !== "dependent",
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(assigned, ["first"]);
  assert.deepEqual(result.failed, ["dependent"]);
});
test("settled peer edits select provisional gate context without releasing their dependents", async () => {
  const held = deferred();
  const verified = deferred();
  let peerObserved = false;
  const dispatched = [];
  const run = runAtomicStream(
    [
      { id: "first", dependencies: [] },
      { id: "peer", dependencies: [] },
      { id: "dependent", dependencies: ["peer"] },
    ],
    {
      agents: 2,
      execute: async (node) => {
        dispatched.push(node.id);
        if (node.id === "first") await held.promise;
        return node.id;
      },
      verify: async (node, _signal, _receipt, context) => {
        if (node.id === "peer") {
          held.resolve();
          await verified.promise;
        }
        if (node.id === "first") {
          await held.promise;
          peerObserved = context.settled.has("peer");
          assert.equal(context.completed.has("peer"), false);
        }
        return true;
      },
    },
  );
  await held.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, ["first", "peer"]);
  verified.resolve();
  assert.equal((await run).status, "pass");
  assert.equal(peerObserved, true);
});
test("asynchronous observations read current writer and settled-peer state", async () => {
  const observing = deferred();
  const peerAtGate = deferred();
  const result = await runAtomicStream([node("first"), node("peer")], {
    agents: 2,
    execute: async (item) => {
      if (item.id === "peer") await observing.promise;
    },
    verify: async (item, _signal, _receipt, context) => {
      if (item.id === "first") {
        observing.resolve();
        await peerAtGate.promise;
        assert.equal(context.settled.has("peer"), true);
        assert.equal(context.activeWrites, false);
      } else peerAtGate.resolve();
      return true;
    },
  });
  assert.equal(result.status, "pass");
});
test("cancellation during structural observation settles it before returning and never starts a successor", async () => {
  const controller = new AbortController();
  const entered = deferred();
  const events = [];
  const run = runAtomicStream([node("first"), node("dependent", ["first"])], {
    agents: 1,
    signal: controller.signal,
    execute: async (item) => {
      events.push(item.id);
    },
    verify: async (_node, signal) => {
      entered.resolve();
      try {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        signal.throwIfAborted();
      } finally {
        events.push("observation-closed");
      }
    },
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(run, { name: "AbortError" });
  assert.deepEqual(events, ["first", "observation-closed"]);
});
test("dispatch exposes actual current writers for participant notices and peer masks", async () => {
  const release = deferred();
  const fastStarted = deferred();
  const snapshots = [];
  const run = runAtomicStream([node("slow"), node("fast")], {
    agents: 2,
    execute: async (item, _agent, _signal, context) => {
      snapshots.push([item.id, [...context.writers].sort()]);
      if (item.id === "slow") await release.promise;
      else fastStarted.resolve();
    },
    verify: async (_item, _signal, _receipt, context) => {
      assert.ok(!context.writers.has("fast"));
      return true;
    },
  });
  await fastStarted.promise;
  release.resolve();
  assert.equal((await run).status, "pass");
  assert.deepEqual(snapshots, [
    ["slow", ["slow"]],
    ["fast", ["fast", "slow"]],
  ]);
});
test("a drained unchanged pending observation blocks without a hidden delivery retry", async () => {
  let deliveries = 0;
  let observations = 0;
  const result = await runAtomicStream([node("uncertain"), node("dependent", ["uncertain"])], {
    agents: 15,
    execute: async () => {
      deliveries++;
    },
    verify: async () => {
      observations++;
      return "pending";
    },
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.failed, ["uncertain"]);
  assert.equal(result.completed.size, 0);
  assert.equal(deliveries, 1);
  assert.equal(observations, 1);
});
test("duplicate IDs, missing prerequisites and cycles are rejected before any delivery", async () => {
  for (const nodes of [
    [node("same"), node("same")],
    [node("first", ["missing"])],
    [node("first", ["second"]), node("second", ["first"])],
  ])
    await assert.rejects(
      runAtomicStream(nodes, {
        agents: 2,
        execute: async () => assert.fail("invalid graph dispatched work"),
        verify: async () => true,
      }),
      /atomic|prerequisite|cycle/i,
    );
});
