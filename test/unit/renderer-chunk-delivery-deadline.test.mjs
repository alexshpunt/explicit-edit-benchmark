import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { executeChunkDelivery } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-delivery-deadline.mjs";

function driver(work) {
  return {
    closed: false,
    async execute(prompt, options) {
      return work(prompt, options);
    },
    async terminate() {
      this.closed = true;
    },
  };
}

test("a completed delivery returns its receipt without stopping its participant", async () => {
  const participant = driver(async () => ({ count: 4 }));
  const result = await executeChunkDelivery(participant, "assignment", { timeoutMs: 1000 });
  assert.deepEqual(result, { status: "settled", receipt: { count: 4 } });
  assert.equal(participant.closed, false);
});

test("a timed-out delivery confirms shutdown before reporting timeout", async () => {
  const participant = driver(
    (_prompt, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  );
  participant.terminate = async function () {
    await delay(15);
    this.closed = true;
  };
  const result = await executeChunkDelivery(participant, "assignment", { timeoutMs: 20 });
  assert.deepEqual(result, { status: "timed-out" });
  assert.equal(participant.closed, true);
});

test("barrier-owned participants use their explicit retirement capability", async () => {
  const participant = driver(
    (_prompt, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  );
  participant.terminate = async () => {
    throw Error("barrier-owned shutdown was called");
  };
  const result = await executeChunkDelivery(participant, "assignment", {
    timeoutMs: 20,
    retire: async () => {
      participant.closed = true;
    },
  });
  assert.equal(result.status, "timed-out");
  assert.equal(participant.closed, true);
});
test("external cancellation stays cancellation and confirms shutdown", async () => {
  const controller = new AbortController();
  const participant = driver(
    (_prompt, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  );
  const error = Error("external");
  const pending = executeChunkDelivery(participant, "assignment", {
    timeoutMs: 1000,
    signal: controller.signal,
  });
  await delay(5);
  controller.abort(error);
  await assert.rejects(pending, (actual) => actual === error);
  assert.equal(participant.closed, true);
});

test("a pre-cancelled delivery never starts the participant", async () => {
  const controller = new AbortController();
  const error = Error("pre-cancelled");
  controller.abort(error);
  let started = false;
  const participant = driver(async () => {
    started = true;
  });
  await assert.rejects(
    executeChunkDelivery(participant, "assignment", { timeoutMs: 1000, signal: controller.signal }),
    (actual) => actual === error,
  );
  assert.equal(started, false);
  assert.equal(participant.closed, false);
});
test("provider failures are propagated without becoming timeouts", async () => {
  const error = Error("provider");
  const participant = driver(async () => {
    throw error;
  });
  await assert.rejects(
    executeChunkDelivery(participant, "assignment", { timeoutMs: 1000 }),
    (actual) => actual === error,
  );
  assert.equal(participant.closed, false);
});

test("a participant whose shutdown is unconfirmed is not reported as a timeout", async () => {
  const participant = driver(
    (_prompt, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  );
  participant.terminate = async () => {};
  await assert.rejects(executeChunkDelivery(participant, "assignment", { timeoutMs: 20 }), {
    code: "CHUNK_SHUTDOWN_UNCONFIRMED",
  });
});
