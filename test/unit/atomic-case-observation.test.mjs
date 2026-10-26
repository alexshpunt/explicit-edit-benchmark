import assert from "node:assert/strict";
import { test } from "node:test";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

const node = (id, dependencies = []) => ({ id, dependencies });

test("cancellation closes a delivery observation only after its writer settles", async () => {
  const events = [];
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  let closed = false;
  const run = runAtomicStream([node("cancelled")], {
    agents: 1,
    batchSize: 1,
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
  });
  await entered.promise;
  controller.abort(Error("case deadline"));
  await assert.rejects(run, (error) => error === controller.signal.reason);
  assert.equal(closed, true);
  assert.deepEqual(events, [
    { event: "case-start", id: "cancelled", phase: "delivery" },
    { event: "case-end", id: "cancelled", phase: "delivery", status: "cancelled" },
  ]);
});

test("case observations record deliveries without inventing per-edit acceptance", async () => {
  const events = [];
  const result = await runAtomicStream([node("first"), node("second", ["first"])], {
    agents: 2,
    batchSize: 1,
    onCase: (event) => events.push(event),
    execute: async () => {},
  });
  assert.equal(result.status, "drained");
  assert.deepEqual(events, [
    { event: "case-start", id: "first", phase: "delivery" },
    { event: "case-end", id: "first", phase: "delivery", status: "settled" },
    { event: "case-start", id: "second", phase: "delivery" },
    { event: "case-end", id: "second", phase: "delivery", status: "settled" },
  ]);
});
