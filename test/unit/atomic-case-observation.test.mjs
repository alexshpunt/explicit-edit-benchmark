import assert from "node:assert/strict";
import { test } from "node:test";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

const node = (id, dependencies = []) => ({ id, dependencies });

test("cancellation closes an observed case only after its writer has settled", async () => {
  const events = [];
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  let closed = false;
  const run = runAtomicStream([node("cancelled")], {
    agents: 1,
    signal: controller.signal,
    onCase: (event) => events.push(event),
    execute: async (_item, _agent, signal) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            closed = true;
            reject(signal.reason);
          },
          { once: true },
        );
        entered.resolve();
      });
    },
    verify: async () => assert.fail("Cancelled writer cannot receive credit"),
  });
  await entered.promise;
  controller.abort(Error("case deadline"));
  await assert.rejects(run, /case deadline/);
  assert.equal(closed, true);
  assert.deepEqual(events, [
    { event: "case-start", id: "cancelled", phase: "atomic" },
    { event: "case-end", id: "cancelled", phase: "atomic", status: "error" },
  ]);
});

test("case lifetimes span deferred input and output checks instead of resetting on retries", async () => {
  const events = [];
  const releasePeer = Promise.withResolvers();
  let inputs = 0;
  let outputs = 0;
  const result = await runAtomicStream([node("first"), node("peer")], {
    agents: 2,
    onCase: (event) => events.push(event),
    checkInputs: async (item) => (item.id === "first" && ++inputs === 1 ? "pending" : true),
    execute: async (item) => {
      if (item.id === "peer") await releasePeer.promise;
    },
    verify: async (item) => {
      if (item.id === "first" && ++outputs === 1) {
        setImmediate(() => releasePeer.resolve());
        return "pending";
      }
      return true;
    },
  });
  assert.equal(result.status, "pass");
  assert.ok(inputs >= 2 && outputs >= 2);
  for (const id of ["first", "peer"]) {
    assert.deepEqual(
      events.filter((event) => event.id === id),
      [
        { event: "case-start", id, phase: "atomic" },
        { event: "case-end", id, phase: "atomic", status: "pass" },
      ],
    );
  }
});

test("case observers do not invent starts for retained work or blocked successors", async () => {
  const events = [];
  const result = await runAtomicStream(
    [node("retained"), node("rejected"), node("dependent", ["rejected"])],
    {
      agents: 2,
      completed: new Set(["retained"]),
      onCase: (event) => events.push(event),
      checkInputs: async () => false,
      execute: async () => assert.fail("Rejected input cannot dispatch"),
      verify: async () => true,
    },
  );
  assert.equal(result.status, "blocked");
  assert.deepEqual(events, [
    { event: "case-start", id: "rejected", phase: "atomic" },
    { event: "case-end", id: "rejected", phase: "atomic", status: "fail" },
  ]);
});
