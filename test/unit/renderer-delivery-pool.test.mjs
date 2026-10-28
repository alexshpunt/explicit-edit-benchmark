import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryPool } from "../../src/suites/explicit-edit-multi-agent/execution/delivery-pool.mjs";

function fixture(agentLifecycle = "per-delivery", options = {}) {
  const created = [];
  const pool = createDeliveryPool({
    size: 2,
    agentLifecycle,
    async createDriver(agent, session) {
      const driver = {
        closed: false,
        history: [],
        async assertIdle() {
          assert.equal(this.closed, false);
          return {
            sessionId: `session-${session}`,
            lifetime: `life-${session}`,
            messageCount: this.history.length,
          };
        },
        async close() {
          this.closed = true;
        },
      };
      created.push(driver);
      return driver;
    },
    ...options,
  });
  const deliver = (agent, repair, text) =>
    pool.execute(agent, repair, async (driver) => {
      driver.history.push(text);
      return [...driver.history];
    });
  return { pool, created, deliver };
}

test("each original packet starts empty while recovery retains only its current context", async () => {
  const { pool, created, deliver } = fixture();
  try {
    assert.deepEqual(await deliver(0, false, "first"), ["first"]);
    assert.deepEqual(await deliver(0, false, "second"), ["second"]);
    assert.equal(created[0].closed, true);
    assert.deepEqual(await deliver(0, true, "repair"), ["second", "repair"]);
    assert.equal(created.length, 2);
    await pool.closeRound();
    assert.equal(created[1].closed, true);
    assert.deepEqual(await deliver(0, false, "next-round"), ["next-round"]);
  } finally {
    await pool.close();
  }
  assert.ok(created.every((driver) => driver.closed));
});

test("different slots coexist but an occupied slot cannot be replaced", async () => {
  const { pool, created, deliver } = fixture();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const active = pool.execute(0, false, async () => gate);
  try {
    await deliver(1, false, "peer");
    assert.equal(created.filter((driver) => !driver.closed).length, 2);
    await assert.rejects(deliver(0, false, "overlap"));
    assert.equal(created[0].closed, false);
  } finally {
    release();
    await active;
    await pool.close();
  }
});

test("idle verification failures still close every owned driver and prevent replacement", async () => {
  const { pool, created, deliver } = fixture();
  await deliver(0, false, "first");
  await deliver(1, false, "peer");
  const failure = new Error("idle-failure-fixture");
  created[0].assertIdle = async () => {
    throw failure;
  };
  await assert.rejects(deliver(0, false, "second"), (error) => error === failure);
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  await pool.close();
  assert.ok(created.every((driver) => driver.closed));
});

test("a failed shutdown cannot be hidden by a new process", async () => {
  const { pool, created, deliver } = fixture();
  await deliver(0, false, "first");
  const failure = new Error("shutdown-failure-fixture");
  created[0].close = async () => {
    throw failure;
  };
  await assert.rejects(deliver(0, false, "second"), (error) => error === failure);
  assert.equal(created.length, 1);
  assert.equal(pool.records[0].closed, false);
  created[0].close = async () => {
    created[0].closed = true;
  };
  await pool.close();
  assert.equal(created[0].closed, true);
  assert.equal(pool.records[0].closed, false);
});

test("startup validation rejects inherited history and still drains the process", async () => {
  const driver = {
    closed: false,
    history: ["prior"],
    assertIdle: async () => ({ messageCount: 1 }),
    async close() {
      this.closed = true;
    },
  };
  const { pool, deliver } = fixture("per-delivery", { createDriver: () => driver });
  try {
    await assert.rejects(deliver(0, false, "original"));
  } finally {
    await pool.close();
  }
  assert.equal(driver.closed, true);
});

test("reused native identities are rejected before delivering another packet", async () => {
  const created = [];
  const { pool, deliver } = fixture("per-delivery", {
    createDriver() {
      const driver = {
        history: [],
        closed: false,
        assertIdle: async () => ({
          lifetime: "same-life",
          sessionId: "same-session",
          messageCount: 0,
        }),
        async close() {
          this.closed = true;
        },
      };
      created.push(driver);
      return driver;
    },
  });
  try {
    await deliver(0, false, "first");
    await assert.rejects(deliver(1, false, "second"));
  } finally {
    await pool.close();
  }
  assert.ok(created.every(({ closed }) => closed));
});

test("a process which fails readiness remains owned until final cleanup", async () => {
  const failure = new Error("readiness-fixture");
  const driver = {
    closed: false,
    get ready() {
      return Promise.reject(failure);
    },
    async close() {
      this.closed = true;
    },
  };
  const { pool, deliver } = fixture("per-delivery", { createDriver: () => driver });
  try {
    await assert.rejects(deliver(0, false, "original"), (error) => error === failure);
  } finally {
    await pool.close();
  }
  assert.equal(driver.closed, true);
  assert.equal(pool.records[0].closed, true);
});

test("persistent mode keeps its session across ordinary packets and rounds", async () => {
  const { pool, created, deliver } = fixture("persistent");
  try {
    await deliver(0, false, "first");
    await pool.closeRound();
    assert.deepEqual(await deliver(0, false, "second"), ["first", "second"]);
    assert.equal(created.length, 1);
  } finally {
    await pool.close();
  }
});
