import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { setImmediate as checkpoint } from "node:timers/promises";
import { runRoundPool } from "../../src/suites/explicit-edit-multi-agent/execution/round-pool.mjs";
import {
  PROVIDER_RECOVERY_POLICY,
  admitProviderDelivery,
  createProviderRecovery,
} from "../../src/suites/explicit-edit-multi-agent/execution/provider-recovery.mjs";

const options = { timeout: 10000 };

function fixture(t, extra = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = [];
  const recovery = createProviderRecovery({ onEvent: (event) => events.push(event), ...extra });
  const request = (sessionId, signal = controller.signal) =>
    recovery.wait({ sessionId, lifetime: `life-${sessionId}`, reason: "fixture-limit", signal });
  return { ...recovery, request, controller, events };
}

function tracked(promise) {
  let state = "pending";
  const result = promise.then(
    (value) => {
      state = "resolved";
      return value;
    },
    (error) => {
      state = "rejected";
      throw error;
    },
  );
  result.catch(() => {});
  return {
    promise: result,
    get state() {
      return state;
    },
  };
}

test(
  "held admission cannot inherit the failed native participant's execution receipt",
  options,
  async (t) => {
    const f = fixture(t);
    const origin = new Error("fixture-native-provider-failure");
    origin.category = "provider_failure";
    const receipt = { sessionId: "session-A", lifetime: "life-A", toolCalls: 7 };
    const nativeStarted = Promise.withResolvers();
    const admissionHeld = Promise.withResolvers();
    const nativeFailure = Promise.withResolvers();
    const drivers = [];
    const deliverySignals = [];
    let paused;
    let held;
    t.after(() => {
      f.stop(origin);
      nativeFailure.reject(origin);
    });
    const running = runRoundPool(
      ["a", "b"].map((id) => ({ id, dependencies: [] })),
      {
        maxAgents: 2,
        batchSize: 1,
        createDriver: async (agent) => {
          const driver = {
            agent,
            closed: false,
            nativeCalls: 0,
            async assertIdle() {
              return {
                sessionId: agent === 0 ? "session-A" : "session-B",
                lifetime: agent === 0 ? "life-A" : "life-B",
                messageCount: 0,
              };
            },
            async execute({ signal }) {
              this.nativeCalls++;
              assert.equal(agent, 0);
              paused = tracked(
                f.wait({ sessionId: receipt.sessionId, lifetime: receipt.lifetime, signal }),
              );
              nativeStarted.resolve();
              try {
                await nativeFailure.promise;
              } catch (error) {
                // The native driver adds its receipt after notifying the shared coordinator.
                error.execution = receipt;
                throw error;
              }
            },
            async terminate() {
              this.closed = true;
            },
          };
          drivers.push(driver);
          return driver;
        },
        onParticipant: async ({ agent }) => {
          if (agent === 1) await nativeStarted.promise;
        },
        executeBatch: async (driver, _members, { signal }) => {
          deliverySignals.push(signal);
          const admitted = tracked(admitProviderDelivery(f, { signal }));
          if (driver.agent === 1) {
            held = admitted;
            admissionHeld.resolve();
          }
          await admitted.promise;
          return driver.execute({ signal });
        },
      },
    );
    running.catch(() => {});
    await admissionHeld.promise;
    assert.equal(held.state, "pending");
    assert.equal(paused.state, "pending");
    assert.deepEqual(
      drivers.map(({ nativeCalls }) => nativeCalls),
      [1, 0],
    );

    f.stop(origin);
    nativeFailure.reject(origin);
    let failure;
    await assert.rejects(running, (error) => {
      failure = error;
      return error.category === origin.category;
    });
    await assert.rejects(paused.promise, (error) => error === origin);
    assert.deepEqual(
      drivers.map(({ nativeCalls }) => nativeCalls),
      [1, 0],
    );
    assert.ok(drivers.every(({ closed }) => closed));
    assert.ok(deliverySignals.every((signal) => !signal.aborted));
    const { records, deliveries } = failure.roundPool;
    assert.equal(records.length, 2);
    assert.ok(records.every(({ closed }) => closed));
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every(({ status }) => status === "error"));
    const source = deliveries.find(({ ids }) => ids.includes("a"));
    const unaccepted = deliveries.find(({ ids }) => ids.includes("b"));
    assert.equal(origin.execution, receipt);
    assert.equal(source.receipt, receipt);
    assert.equal(Object.hasOwn(unaccepted, "receipt"), false);
    assert.equal(unaccepted.receipt, undefined);
  },
);

test(
  "future admission preserves a provider failure without claiming its earlier native receipt",
  options,
  async (t) => {
    const f = fixture(t);
    const origin = new Error("fixture-earlier-provider-failure");
    origin.name = "FixtureProviderFailure";
    origin.category = "provider_failure";
    const execution = { sessionId: "session-A", lifetime: "life-A", toolCalls: 7 };
    const receipt = { sessionId: "session-A", lifetime: "life-A", toolCalls: 9 };
    origin.execution = execution;
    origin.receipt = receipt;
    f.stop(origin);
    await assert.rejects(admitProviderDelivery(f, { signal: f.controller.signal }), (error) => {
      assert.equal(Object.hasOwn(error, "execution"), false);
      assert.equal(Object.hasOwn(error, "receipt"), false);
      assert.notEqual(error, origin);
      assert.equal(error.cause, origin);
      assert.equal(error.name, origin.name);
      assert.equal(error.category, origin.category);
      assert.equal(error.message, origin.message);
      return true;
    });
    assert.equal(origin.execution, execution);
    assert.equal(origin.receipt, receipt);
    await assert.rejects(f.admit(), (error) => error === origin);
    assert.equal(f.controller.signal.aborted, false);
  },
);

test("delivery admission preserves cancellation without a native receipt", options, async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new DOMException("fixture-admission-cancelled", "AbortError");
  const execution = { sessionId: "session-A", lifetime: "life-A", toolCalls: 7 };
  reason.execution = execution;
  controller.abort(reason);
  await assert.rejects(admitProviderDelivery(f, { signal: controller.signal }), (error) => {
    assert.equal(Object.hasOwn(error, "execution"), false);
    assert.equal(Object.hasOwn(error, "receipt"), false);
    assert.notEqual(error, reason);
    assert.equal(error.cause, reason);
    assert.equal(error.name, reason.name);
    assert.equal(error.category, reason.category);
    assert.equal(error.message, reason.message);
    return true;
  });
  assert.equal(reason.execution, execution);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await f.admit({ signal: f.controller.signal });
});

test(
  "a terminal provider failure rejects held and future requests without aborting healthy work",
  options,
  async (t) => {
    const f = fixture(t);
    const reason = new Error("fixture-permanent-refusal");
    const held = tracked(f.request("a"));
    const admitted = tracked(f.admit({ signal: f.controller.signal }));
    f.stop(reason);
    await assert.rejects(held.promise, (error) => error === reason);
    await assert.rejects(admitted.promise, (error) => error === reason);
    await assert.rejects(f.request("b"), (error) => error === reason);
    await assert.rejects(f.admit(), (error) => error === reason);
    assert.equal(f.controller.signal.aborted, false);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
    t.mock.timers.tick(60000);
    await checkpoint();
    assert.deepEqual(
      f.events.map(({ type }) => type),
      ["provider_recovery_cooldown", "provider_recovery_stopped"],
    );
  },
);

test(
  "a completed probe cannot reopen admission after another participant reports a terminal failure",
  options,
  async (t) => {
    const f = fixture(t);
    const first = f.request("a");
    t.mock.timers.tick(60000);
    const lease = await first;
    const held = tracked(f.request("b"));
    const admitted = tracked(f.admit());
    const reason = new Error("fixture-permanent-refusal");
    f.stop(reason);
    lease.complete(true);
    await assert.rejects(held.promise, (error) => error === reason);
    await assert.rejects(admitted.promise, (error) => error === reason);
    await assert.rejects(f.admit(), (error) => error === reason);
    assert.equal(f.controller.signal.aborted, false);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
    assert.equal(f.events.filter(({ type }) => type === "provider_recovery_ready").length, 0);
  },
);

test("a provider failure pauses admission until one delayed probe succeeds", options, async (t) => {
  const f = fixture(t);
  await f.admit({ signal: f.controller.signal });
  const existing = Promise.resolve("fixture-already-in-flight");
  const first = tracked(f.request("a"));
  const admitted = tracked(f.admit({ signal: f.controller.signal }));
  assert.equal(await existing, "fixture-already-in-flight");
  await checkpoint();
  assert.equal(first.state, "pending");
  assert.equal(admitted.state, "pending");
  t.mock.timers.tick(59999);
  await checkpoint();
  assert.equal(first.state, "pending");
  t.mock.timers.tick(1);
  const lease = await first.promise;
  assert.equal(admitted.state, "pending");
  lease.complete(true);
  await admitted.promise;
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  assert.deepEqual(
    f.events.map(({ type }) => type),
    ["provider_recovery_cooldown", "provider_recovery_probe", "provider_recovery_ready"],
  );
});

test(
  "new waiters do not reset cooldown and one successful probe releases the queue",
  options,
  async (t) => {
    const f = fixture(t, { cooldownMs: 100 });
    const a = tracked(f.request("a"));
    t.mock.timers.tick(60);
    const b = tracked(f.request("b"));
    const c = tracked(f.request("c"));
    const admitted = tracked(f.admit({ signal: f.controller.signal }));
    t.mock.timers.tick(40);
    const lease = await a.promise;
    await checkpoint();
    assert.equal(b.state, "pending");
    assert.equal(c.state, "pending");
    assert.equal(admitted.state, "pending");
    lease.complete(true);
    const [second, third] = await Promise.all([b.promise, c.promise, admitted.promise]);
    second.complete(false);
    third.complete(false);
    await f.admit({ signal: f.controller.signal });
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  },
);

test(
  "a failed probe cools down again and rejoins behind other paused sessions",
  options,
  async (t) => {
    const f = fixture(t, { cooldownMs: 100 });
    const a = f.request("a");
    const b = tracked(f.request("b"));
    const admission = tracked(f.admit({ signal: f.controller.signal }));
    t.mock.timers.tick(100);
    const first = await a;
    first.complete(false);
    const aAgain = tracked(f.request("a"));
    t.mock.timers.tick(99);
    await checkpoint();
    assert.equal(b.state, "pending");
    assert.equal(admission.state, "pending");
    t.mock.timers.tick(1);
    const second = await b.promise;
    assert.equal(aAgain.state, "pending");
    first.complete(true);
    await checkpoint();
    assert.equal(admission.state, "pending");
    second.complete(true);
    await Promise.all([aAgain.promise, admission.promise]);
    assert.deepEqual(
      f.events
        .filter(({ type }) => type === "provider_recovery_probe")
        .map(({ sessionId }) => sessionId),
      ["a", "b"],
    );
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  },
);

test("an immediately requeued lone probe does not reopen admission", options, async (t) => {
  const f = fixture(t, { cooldownMs: 100 });
  const first = f.request("a");
  const admission = tracked(f.admit({ signal: f.controller.signal }));
  t.mock.timers.tick(100);
  (await first).complete(false);
  const again = tracked(f.request("a"));
  await checkpoint();
  assert.equal(admission.state, "pending");
  assert.equal(again.state, "pending");
  t.mock.timers.tick(100);
  (await again.promise).complete(true);
  await admission.promise;
});

test(
  "queued cancellation is isolated and a cancelled probe cannot open a newer cycle",
  options,
  async (t) => {
    const f = fixture(t, { cooldownMs: 100 });
    const aController = new AbortController();
    const bController = new AbortController();
    const cancelled = tracked(f.request("a", aController.signal));
    const b = tracked(f.request("b", bController.signal));
    const c = tracked(f.request("c"));
    const admission = tracked(f.admit({ signal: f.controller.signal }));
    const aReason = new Error("fixture-cancel-queued");
    aController.abort(aReason);
    await assert.rejects(cancelled.promise, (error) => error === aReason);
    t.mock.timers.tick(100);
    const stale = await b.promise;
    const bReason = new Error("fixture-cancel-probe");
    bController.abort(bReason);
    stale.complete(true);
    t.mock.timers.tick(99);
    await checkpoint();
    assert.equal(c.state, "pending");
    assert.equal(admission.state, "pending");
    t.mock.timers.tick(1);
    (await c.promise).complete(true);
    await admission.promise;
    assert.equal(getEventListeners(aController.signal, "abort").length, 0);
    assert.equal(getEventListeners(bController.signal, "abort").length, 0);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  },
);

test(
  "cancelling the last paused session releases admission and removes the timer",
  options,
  async (t) => {
    const f = fixture(t, { cooldownMs: 100 });
    const controller = new AbortController();
    const paused = tracked(f.request("a", controller.signal));
    const admission = f.admit({ signal: f.controller.signal });
    const reason = new Error("fixture-last-cancel");
    controller.abort(reason);
    await assert.rejects(paused.promise, (error) => error === reason);
    await admission;
    t.mock.timers.tick(1000);
    await checkpoint();
    assert.equal(f.events.filter(({ type }) => type === "provider_recovery_probe").length, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  },
);

test("cancelling admission does not cancel the provider probe", options, async (t) => {
  const f = fixture(t, { cooldownMs: 100 });
  const controller = new AbortController();
  const paused = f.request("a");
  const admission = tracked(f.admit({ signal: controller.signal }));
  const reason = new Error("fixture-admission-cancel");
  controller.abort(reason);
  await assert.rejects(admission.promise, (error) => error === reason);
  t.mock.timers.tick(100);
  (await paused).complete(true);
  await f.admit();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
});

test(
  "observer failures reject their owned waits instead of leaving a paused circuit",
  options,
  async (t) => {
    const failure = new Error("fixture-observer-failure");
    const f = fixture(t, {
      onEvent() {
        throw failure;
      },
    });
    await assert.rejects(f.request("a"), (error) => error === failure);
    await assert.rejects(f.admit(), (error) => error === failure);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  },
);

test(
  "an ended lone probe releases admission without leaving a cooldown timer",
  options,
  async (t) => {
    const f = fixture(t, { cooldownMs: 100 });
    const paused = f.request("a");
    const admission = f.admit({ signal: f.controller.signal });
    t.mock.timers.tick(100);
    const lease = await paused;
    lease.complete(false);
    await admission;
    lease.complete(true);
    t.mock.timers.tick(1000);
    await checkpoint();
    assert.equal(f.events.filter(({ type }) => type === "provider_recovery_probe").length, 1);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  },
);

test(
  "a probe observer failure rejects the selected session and pending admission",
  options,
  async (t) => {
    const failure = new Error("fixture-probe-observer-failure");
    const f = fixture(t, {
      cooldownMs: 100,
      onEvent(event) {
        if (event.type === "provider_recovery_probe") throw failure;
      },
    });
    const paused = tracked(f.request("a"));
    const admission = tracked(f.admit({ signal: f.controller.signal }));
    t.mock.timers.tick(100);
    await assert.rejects(paused.promise, (error) => error === failure);
    await assert.rejects(admission.promise, (error) => error === failure);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  },
);

test(
  "a ready observer failure cannot release paused sessions as successful",
  options,
  async (t) => {
    const failure = new Error("fixture-ready-observer-failure");
    const f = fixture(t, {
      cooldownMs: 100,
      onEvent(event) {
        if (event.type === "provider_recovery_ready") throw failure;
      },
    });
    const paused = f.request("a");
    const waiting = tracked(f.request("b"));
    const admission = tracked(f.admit({ signal: f.controller.signal }));
    t.mock.timers.tick(100);
    const lease = await paused;
    assert.throws(
      () => lease.complete(true),
      (error) => error === failure,
    );
    await assert.rejects(waiting.promise, (error) => error === failure);
    await assert.rejects(admission.promise, (error) => error === failure);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  },
);

test("already cancelled callers cannot pause or enter the provider", options, async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error("fixture-pre-cancelled");
  controller.abort(reason);
  await assert.rejects(f.request("a", controller.signal), (error) => error === reason);
  await assert.rejects(f.admit({ signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(f.events, []);
  await f.admit({ signal: f.controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("invalid cooldowns and callbacks cannot create a recovery coordinator", options, () => {
  assert.equal(Object.isFrozen(PROVIDER_RECOVERY_POLICY), true);
  assert.equal(PROVIDER_RECOVERY_POLICY.version, "renderer-provider-recovery-v1");
  assert.equal(PROVIDER_RECOVERY_POLICY.cooldownMs, 60000);
  for (const cooldownMs of [0, -1, 0.5, NaN, Infinity, 2 ** 31])
    assert.throws(() => createProviderRecovery({ cooldownMs }));
  for (const onEvent of [null, false, "fixture-invalid"])
    assert.throws(() => createProviderRecovery({ onEvent }));
});
