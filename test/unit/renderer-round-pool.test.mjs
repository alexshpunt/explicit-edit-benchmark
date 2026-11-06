import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { runRoundPool } from "../../src/suites/explicit-edit-multi-agent/execution/round-pool.mjs";

const options = { timeout: 10000 };
const node = (id, dependencies = []) => ({ id, dependencies });
const gate = () => Promise.withResolvers();

function fixture(overrides = {}) {
  const created = [];
  let live = 0;
  let peak = 0;
  const createDriver = async (agent, session) => {
    live++;
    peak = Math.max(peak, live);
    const driver = {
      agent,
      session,
      closed: false,
      history: [],
      checks: 0,
      terminations: 0,
      async assertIdle() {
        this.checks++;
        assert.equal(this.checks, 1);
        return { sessionId: `session-${session}`, lifetime: `life-${session}`, messageCount: 0 };
      },
      async terminate() {
        this.terminations++;
        if (!this.closed) {
          this.closed = true;
          live--;
        }
      },
    };
    created.push(driver);
    await overrides.setup?.(driver);
    return driver;
  };
  const executeBatch = async (driver, members) => {
    driver.history.push(...members.map(({ id }) => id));
    return { history: [...driver.history] };
  };
  return {
    created,
    createDriver,
    get live() {
      return live;
    },
    get peak() {
      return peak;
    },
    run(nodes, extra = {}) {
      return runRoundPool(nodes, {
        maxAgents: 2,
        batchSize: 1,
        createDriver,
        executeBatch,
        ...extra,
      });
    },
  };
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test(
  "a round reuses a process for ready packets and closes it before returning",
  options,
  async () => {
    const f = fixture();
    const result = await f.run([node("a"), node("b"), node("c")], {
      maxAgents: 1,
      usage: (driver) => ({ deliveries: driver.history.length }),
    });
    assert.equal(result.status, "drained");
    assert.deepEqual(result.delivered, ["a", "b", "c"]);
    assert.equal(f.created.length, 1);
    assert.deepEqual(f.created[0].history, ["a", "b", "c"]);
    assert.equal(f.created[0].checks, 1);
    assert.equal(f.created[0].terminations, 1);
    assert.equal(f.live, 0);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].closed, true);
    assert.deepEqual(result.records[0].usage, { deliveries: 3 });
    assert.equal(Object.hasOwn(result.records[0], "driver"), false);
    assert.deepEqual(
      result.deliveries.map(({ ids }) => ids),
      [["a"], ["b"], ["c"]],
    );
    assert.ok(result.deliveries.every(({ status }) => status === "settled"));
  },
);

test(
  "packets are bounded and dependency chains can run in order inside one packet",
  options,
  async () => {
    const f = fixture();
    const result = await f.run([node("c", ["b"]), node("b", ["a"]), node("a")], {
      maxAgents: 1,
      batchSize: 2,
    });
    assert.deepEqual(
      result.deliveries.map(({ ids }) => ids),
      [["a", "b"], ["c"]],
    );
    assert.deepEqual(f.created[0].history, ["a", "b", "c"]);
    assert.equal(f.live, 0);
  },
);

test("an in-flight prerequisite is not released to another worker", options, async () => {
  const f = fixture();
  const aStarted = gate();
  const xStarted = gate();
  const bStarted = gate();
  const aClosed = gate();
  const releaseA = gate();
  const releaseX = gate();
  let completedA = false;
  const running = f.run([node("a"), node("x"), node("b", ["a"])], {
    async executeBatch(driver, members) {
      const id = members[0].id;
      driver.history.push(id);
      if (id === "a") {
        aStarted.resolve();
        await releaseA.promise;
        completedA = true;
      } else if (id === "x") {
        xStarted.resolve();
        await releaseX.promise;
      } else {
        assert.equal(completedA, true);
        bStarted.resolve();
      }
    },
    onClosed(record) {
      if (record.session === 0) aClosed.resolve();
    },
  });
  try {
    await Promise.all([aStarted.promise, xStarted.promise]);
    assert.equal(f.created.length, 2);
    assert.ok(f.created.every(({ history }) => !history.includes("b")));
    releaseA.resolve();
    await bStarted.promise;
    await aClosed.promise;
    assert.equal(f.created[0].closed, true);
    assert.equal(f.created[1].closed, false);
  } finally {
    releaseA.resolve();
    releaseX.resolve();
  }
  const result = await running;
  assert.deepEqual(f.created[0].history, ["a", "b"]);
  assert.ok(result.records.every(({ closed }) => closed));
});

test(
  "the first available worker takes remaining ready work instead of a fixed queue",
  options,
  async () => {
    const f = fixture();
    const slow = gate();
    const reachedLast = gate();
    const running = f.run([node("a"), node("b"), node("c"), node("d")], {
      async executeBatch(driver, members) {
        const id = members[0].id;
        driver.history.push(id);
        if (id === "a") await slow.promise;
        if (id === "d") reachedLast.resolve();
      },
    });
    try {
      await reachedLast.promise;
      assert.deepEqual(f.created[0].history, ["a"]);
      assert.deepEqual(f.created[1].history, ["b", "c", "d"]);
    } finally {
      slow.resolve();
    }
    await running;
    assert.equal(f.peak, 2);
    assert.equal(f.live, 0);
  },
);

test("closing processes occupy capacity until shutdown is verified", options, async () => {
  const closing = gate();
  const releaseClose = gate();
  const releaseB = gate();
  const cStarted = gate();
  const releaseC = gate();
  const dStarted = gate();
  const f = fixture({
    setup(driver) {
      if (driver.session !== 0) return;
      const terminate = driver.terminate.bind(driver);
      driver.terminate = async () => {
        closing.resolve();
        await releaseClose.promise;
        await terminate();
      };
    },
  });
  const running = f.run([node("a"), node("b"), node("c", ["b"]), node("d", ["b"])], {
    async executeBatch(driver, members) {
      const id = members[0].id;
      driver.history.push(id);
      if (id === "b") await releaseB.promise;
      if (id === "c") {
        cStarted.resolve();
        await releaseC.promise;
      }
      if (id === "d") dStarted.resolve();
    },
  });
  try {
    await closing.promise;
    releaseB.resolve();
    await cStarted.promise;
    assert.equal(f.created.length, 2);
    assert.equal(f.live, 2);
    releaseClose.resolve();
    await dStarted.promise;
    assert.equal(f.created.length, 3);
    assert.equal(f.created[2].agent, 0);
    assert.equal(f.peak, 2);
  } finally {
    releaseB.resolve();
    releaseClose.resolve();
    releaseC.resolve();
  }
  const result = await running;
  assert.ok(result.records.every(({ closed }) => closed));
  assert.equal(f.live, 0);
});

test(
  "enough ready work fills the configured capacity without extra live processes",
  options,
  async () => {
    const f = fixture();
    const started = gate();
    const release = gate();
    let active = 0;
    const running = f.run(
      Array.from({ length: 90 }, (_, index) => node(`item-${index}`)),
      {
        maxAgents: 30,
        async executeBatch() {
          if (++active === 30) started.resolve();
          await release.promise;
        },
      },
    );
    try {
      await started.promise;
      assert.equal(f.created.length, 30);
      assert.equal(f.peak, 30);
    } finally {
      release.resolve();
    }
    const result = await running;
    assert.equal(result.delivered.length, 90);
    assert.equal(result.deliveries.length, 90);
    assert.equal(f.peak, 30);
    assert.equal(f.live, 0);
  },
);

test(
  "a timed-out packet retires its worker and releases dependents to a fresh worker",
  options,
  async () => {
    const f = fixture();
    const executeBatch = async (driver, members) => {
      driver.history.push(...members.map(({ id }) => id));
      if (members.some(({ id }) => id === "slow")) {
        await driver.terminate();
        return { timedOut: true };
      }
      return { history: [...driver.history] };
    };
    const result = await f.run([node("slow"), node("after", ["slow"])], {
      maxAgents: 1,
      executeBatch,
    });
    assert.deepEqual(
      result.deliveries.map(({ ids, status }) => [ids.join(), status]),
      [
        ["slow", "timed-out"],
        ["after", "settled"],
      ],
    );
    assert.equal(f.created.length, 2);
    assert.deepEqual(f.created[1].history, ["after"]);
    assert.equal(f.live, 0);
  },
);

test("graph validation happens before any process is created", options, async () => {
  const invalid = [
    [node("a"), node("a")],
    [node("a", ["missing"])],
    [node("a", ["b"]), node("b", ["a"])],
    [node("a", ["a"])],
    [node("a", ["b", "b"]), node("b")],
    [{ id: "a" }],
    [node("")],
  ];
  for (const nodes of invalid) {
    const f = fixture();
    await assert.rejects(f.run(nodes), { code: "ERR_ASSERTION" });
    assert.equal(f.created.length, 0);
  }
});

test(
  "bounded initialization still fills every active slot and reuses ready workers",
  options,
  async () => {
    const f = fixture();
    const allActive = gate();
    let starting = 0,
      peakStarting = 0,
      arrivals = 0;
    const result = await f.run(
      Array.from({ length: 12 }, (_, index) => node(String(index))),
      {
        maxAgents: 10,
        maxStartingAgents: 2,
        async createDriver(agent, session) {
          starting++;
          peakStarting = Math.max(peakStarting, starting);
          try {
            await new Promise((resolve) => setImmediate(resolve));
            return await f.createDriver(agent, session);
          } finally {
            starting--;
          }
        },
        async executeBatch(driver, members) {
          if (++arrivals === 10) allActive.resolve();
          await allActive.promise;
          driver.history.push(...members.map(({ id }) => id));
        },
      },
    );
    assert.equal(peakStarting, 2);
    assert.equal(starting, 0);
    assert.equal(f.peak, 10);
    assert.equal(result.records.length, 10);
    assert.equal(result.deliveries.length, 12);
    assert.ok(result.deliveries.every(({ ids }) => ids.length === 1));
    assert.ok(f.created.some(({ history }) => history.length > 1));
    assert.ok(result.records.every(({ closed }) => closed));
    assert.equal(f.live, 0);
  },
);

test("cancelling bounded initialization never launches queued workers", options, async () => {
  const f = fixture();
  const entered = gate();
  const controller = new AbortController();
  const failure = new Error("fixture-cancel-bounded-start");
  let calls = 0;
  const running = f.run(
    Array.from({ length: 10 }, (_, index) => node(String(index))),
    {
      maxAgents: 10,
      maxStartingAgents: 2,
      signal: controller.signal,
      async createDriver(_agent, _session, { signal }) {
        if (++calls === 2) entered.resolve();
        await waitForAbort(signal);
      },
    },
  );
  running.catch(() => {});
  await entered.promise;
  controller.abort(failure);
  await assert.rejects(running, (error) => error === failure);
  assert.equal(calls, 2);
  assert.equal(f.live, 0);
});

test("invalid capacities and callbacks cannot start workers", options, async () => {
  for (const extra of [
    { maxAgents: 0 },
    { maxAgents: 1.5 },
    { batchSize: 0 },
    { maxStartingAgents: 0 },
    { maxStartingAgents: 1.5 },
    { maxStartingAgents: 3 },
    { executeBatch: undefined },
    { createDriver: undefined },
    { onDelivery: 1 },
  ]) {
    const f = fixture();
    await assert.rejects(f.run([node("a")], extra), { code: "ERR_ASSERTION" });
    assert.equal(f.created.length, 0);
  }
});

test("successful waves release their internal and external abort listeners", options, async () => {
  const f = fixture();
  const controller = new AbortController();
  let ownedSignal;
  await f.run([node("a"), node("b"), node("c")], {
    signal: controller.signal,
    async executeBatch(_driver, _members, { signal }) {
      ownedSignal = signal;
    },
  });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(getEventListeners(ownedSignal, "abort").length, 0);
  assert.equal(f.live, 0);
});
test("an empty round creates no process", options, async () => {
  const f = fixture();
  const result = await f.run([]);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.deliveries, []);
  assert.deepEqual(result.delivered, []);
  assert.equal(f.created.length, 0);
});

test("already cancelled work does not create a process", options, async () => {
  const f = fixture();
  const controller = new AbortController();
  const failure = new Error("fixture-cancel-before-start");
  controller.abort(failure);
  await assert.rejects(
    f.run([node("a")], { signal: controller.signal }),
    (error) => error === failure,
  );
  assert.equal(f.created.length, 0);
});

test("cancellation aborts active work and awaits every owned shutdown", options, async () => {
  const f = fixture();
  const controller = new AbortController();
  const started = gate();
  const failure = new Error("fixture-cancel-active");
  let deliveries = 0;
  const running = f.run([node("a"), node("b"), node("c")], {
    signal: controller.signal,
    async executeBatch(_driver, _members, { signal }) {
      if (++deliveries === 2) started.resolve();
      await waitForAbort(signal);
    },
  });
  running.catch(() => {});
  await started.promise;
  controller.abort(failure);
  await assert.rejects(running, (error) => {
    assert.equal(error, failure);
    assert.equal(error.roundPool.records.length, 2);
    assert.ok(error.roundPool.records.every(({ closed }) => closed));
    return true;
  });
  assert.equal(f.created.length, 2);
  assert.equal(f.live, 0);
  assert.ok(f.created.every(({ terminations }) => terminations === 1));
});

test("a factory failure still terminates a peer already executing", options, async () => {
  const f = fixture();
  const started = gate();
  const failure = new Error("fixture-create-failure");
  const running = f.run([node("a"), node("b")], {
    async createDriver(agent, session, context) {
      if (session === 1) {
        await started.promise;
        throw failure;
      }
      assert.equal(context.signal.aborted, false);
      return f.createDriver(agent, session);
    },
    async executeBatch(_driver, _members, { signal }) {
      started.resolve();
      await waitForAbort(signal);
    },
  });
  await assert.rejects(running, (error) => error === failure);
  assert.equal(f.created.length, 1);
  assert.equal(f.live, 0);
});

test(
  "failed readiness and inherited history are cleaned up before rejection",
  options,
  async () => {
    for (const setup of [
      (driver) => {
        driver.ready = Promise.reject(new Error("fixture-readiness-failure"));
        driver.ready.catch(() => {});
      },
      (driver) => {
        driver.assertIdle = async () => ({ messageCount: 1 });
      },
    ]) {
      const f = fixture({ setup });
      await assert.rejects(f.run([node("a")]));
      assert.equal(f.live, 0);
      assert.equal(f.created[0].terminations, 1);
    }
  },
);

test("cancellation does not wait for a never-ready owned process", options, async () => {
  const created = gate();
  const controller = new AbortController();
  const failure = new Error("fixture-cancel-readiness");
  const f = fixture({
    setup(driver) {
      driver.ready = new Promise(() => {});
      created.resolve();
    },
  });
  const running = f.run([node("a")], { signal: controller.signal });
  running.catch(() => {});
  await created.promise;
  controller.abort(failure);
  await assert.rejects(running, (error) => error === failure);
  assert.equal(f.live, 0);
  assert.equal(f.created[0].checks, 0);
});

test("a factory returning after cancellation is still drained", options, async () => {
  const entered = gate();
  const release = gate();
  const controller = new AbortController();
  const failure = new Error("fixture-cancel-factory");
  const f = fixture();
  const running = f.run([node("a")], {
    signal: controller.signal,
    async createDriver(agent, session, { signal }) {
      entered.resolve();
      await release.promise;
      assert.equal(signal.aborted, true);
      return f.createDriver(agent, session);
    },
  });
  running.catch(() => {});
  await entered.promise;
  controller.abort(failure);
  release.resolve();
  await assert.rejects(running, (error) => error === failure);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].closed, true);
  assert.equal(f.created[0].checks, 0);
});
test("fresh processes cannot reuse a native lifetime or session identity", options, async () => {
  for (const field of ["lifetime", "sessionId"]) {
    const f = fixture({
      setup(driver) {
        const assertIdle = driver.assertIdle.bind(driver);
        driver.assertIdle = async () => ({ ...(await assertIdle()), [field]: "same" });
      },
    });
    await assert.rejects(f.run([node("a"), node("b")]), { code: "ERR_ASSERTION" });
    assert.equal(f.created.length, 2);
    assert.equal(f.live, 0);
  }
});

test(
  "a provider failure drains in-flight work without aborting peers or submitting new work",
  options,
  async () => {
    const f = fixture();
    const peerStarted = gate();
    const failed = gate();
    const failure = Object.assign(new Error("fixture-provider-refusal"), {
      category: "provider_failure",
    });
    let peerSignal;
    const running = f.run([node("a"), node("b"), node("c", ["b"]), node("blocked", ["a"])], {
      async executeBatch(driver, [member], { signal }) {
        driver.history.push(member.id);
        if (member.id === "a") {
          await peerStarted.promise;
          throw failure;
        }
        peerSignal = signal;
        if (member.id === "b") {
          peerStarted.resolve();
          await Promise.race([failed.promise, waitForAbort(signal)]);
        }
        assert.equal(signal.aborted, false);
        return { id: member.id };
      },
      onDelivery(event) {
        if (event.event === "end" && event.ids.includes("a")) failed.resolve();
      },
    });
    await assert.rejects(running, (error) => {
      assert.equal(error, failure);
      assert.equal(peerSignal.aborted, false);
      assert.deepEqual(
        error.roundPool.deliveries.map(({ ids, status }) => ({ ids, status })),
        [
          { ids: ["a"], status: "error" },
          { ids: ["b"], status: "settled" },
        ],
      );
      assert.ok(error.roundPool.records.every(({ closed }) => closed));
      return true;
    });
    assert.deepEqual(f.created.flatMap(({ history }) => history).sort(), ["a", "b"]);
    assert.equal(f.live, 0);
  },
);

test("execution failure remains primary when cleanup also fails", options, async () => {
  const failure = new Error("fixture-execution-failure");
  failure.category = "provider_failure";
  failure.execution = { usage: null, toolCalls: 1 };
  const closeFailure = new Error("fixture-close-failure");
  const f = fixture({
    setup(driver) {
      const terminate = driver.terminate.bind(driver);
      driver.terminate = async () => {
        await terminate();
        throw closeFailure;
      };
    },
  });
  await assert.rejects(
    f.run([node("a")], {
      executeBatch: async () => {
        throw failure;
      },
    }),
    (error) => {
      assert.equal(error, failure);
      assert.equal(error.roundPool.records[0].closed, false);
      assert.equal(error.roundPool.records[0].closeFailed, true);
      assert.deepEqual(error.roundPool.deliveries[0].receipt, failure.execution);
      assert.equal(error.roundPool.deliveries[0].failure.category, "provider_failure");
      return true;
    },
  );
  assert.equal(f.live, 0);
});

test("an end observer cannot replace the preceding execution failure", options, async () => {
  const failure = new Error("fixture-execution-before-observer");
  const observerFailure = new Error("fixture-end-observer-failure");
  const f = fixture();
  await assert.rejects(
    f.run([node("a")], {
      async executeBatch() {
        throw failure;
      },
      onDelivery(event) {
        if (event.event === "end") throw observerFailure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(f.live, 0);
});

test("a closure observer cannot replace the preceding shutdown failure", options, async () => {
  const failure = new Error("fixture-close-before-observer");
  const observerFailure = new Error("fixture-close-observer-failure");
  const f = fixture({
    setup(driver) {
      const terminate = driver.terminate.bind(driver);
      driver.terminate = async () => {
        await terminate();
        throw failure;
      };
    },
  });
  await assert.rejects(
    f.run([node("a")], {
      onClosed() {
        throw observerFailure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(f.live, 0);
});
test("shutdown must actually finish before the round succeeds", options, async () => {
  let cleanup;
  const f = fixture({
    setup(driver) {
      cleanup = driver.terminate.bind(driver);
      driver.terminate = async () => {};
    },
  });
  try {
    await assert.rejects(f.run([node("a")]), { code: "ERR_ASSERTION" });
    assert.equal(f.created.length, 1);
  } finally {
    await cleanup();
  }
  assert.equal(f.live, 0);
});

test("generic drivers can close without a terminate method", options, async () => {
  const f = fixture({
    setup(driver) {
      driver.close = driver.terminate;
      delete driver.terminate;
    },
  });
  const result = await f.run([node("a")]);
  assert.equal(result.records[0].closed, true);
  assert.equal(f.live, 0);
});

test("a failed immediate shutdown still attempts owned fallback cleanup", options, async () => {
  const failure = new Error("fixture-immediate-close-failure");
  const f = fixture({
    setup(driver) {
      driver.close = driver.terminate;
      driver.terminate = async () => {
        throw failure;
      };
    },
  });
  await assert.rejects(f.run([node("a")]), (error) => error === failure);
  assert.equal(f.created[0].closed, true);
  assert.equal(f.live, 0);
});

test("a frozen execution error remains primary after cleanup", options, async () => {
  const failure = new Error("fixture-frozen-failure");
  Object.freeze(failure);
  assert.equal(Object.isFrozen(failure), true);
  const f = fixture();
  await assert.rejects(
    f.run([node("a")], {
      executeBatch: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(f.live, 0);
});
test(
  "observer failures stop work without losing cleanup or the original failure",
  options,
  async () => {
    for (const hook of ["onParticipant", "onDelivery", "onClosed", "usage"]) {
      const failure = new Error(`fixture-${hook}-failure`);
      const f = fixture();
      await assert.rejects(
        f.run([node("a"), node("b")], {
          [hook]: async () => {
            throw failure;
          },
        }),
        (error) => error === failure,
      );
      assert.equal(f.live, 0);
    }
  },
);
