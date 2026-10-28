import assert from "node:assert/strict";

/** Slots bound live processes, not graph width or total session count. A fresh
 * original delivery replaces its slot's prior session only after verified idle
 * and shutdown. Recovery keeps that slot's current round-local context. Retired
 * drivers are released; their identities, closure and usage evidence remain.
 */
export function createDeliveryPool({
  size,
  agentLifecycle,
  createDriver,
  onParticipant = () => {},
  usage = () => null,
}) {
  assert.ok(Number.isSafeInteger(size) && size > 0, "Invalid participant capacity");
  assert.ok(["persistent", "per-delivery"].includes(agentLifecycle), "Invalid agent lifecycle");
  const records = [];
  const current = Array.from({ length: size });
  const busy = new Set();
  const identities = { lifetime: new Set(), sessionId: new Set() };

  async function retire(agent, inspect) {
    const record = current[agent];
    if (!record?.driver) return;
    const driver = record.driver;
    let failure;
    if (inspect) {
      try {
        await driver.assertIdle();
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error("Participant idle check failed", { cause: error });
      }
    }
    try {
      await driver.close();
      assert.equal(driver.closed, true, "Participant shutdown did not finish");
    } catch (error) {
      record.closeFailed = true;
      failure ??=
        error instanceof Error ? error : new Error("Participant shutdown failed", { cause: error });
    } finally {
      record.usage = usage(driver);
      record.closed = driver.closed === true && !record.closeFailed;
      if (driver.closed === true) {
        record.driver = undefined;
        current[agent] = undefined;
      }
    }
    if (failure) throw failure;
  }

  async function closeSlots(inspect) {
    const results = await Promise.allSettled(current.map((_, agent) => retire(agent, inspect)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  const drivers = current.map((_, agent) => ({
    async assertIdle() {
      assert.equal(busy.has(agent), false, "Participant delivery is still active");
      return current[agent]?.driver ? current[agent].driver.assertIdle() : { inactive: true };
    },
    close: () => retire(agent, false),
  }));

  return {
    drivers,
    records,
    async execute(agent, repair, operation) {
      assert.ok(Number.isSafeInteger(agent) && agent >= 0 && agent < size);
      assert.equal(busy.has(agent), false, "Overlapping participant deliveries");
      busy.add(agent);
      try {
        if (agentLifecycle === "per-delivery" && !repair) await retire(agent, true);
        if (!current[agent]) {
          const record = { agent, session: records.length, closed: false };
          records.push(record);
          current[agent] = record;
          record.driver = await createDriver(agent, record.session);
          await record.driver.ready;
          record.participant = await record.driver.assertIdle();
          if (agentLifecycle === "per-delivery" && record.participant.messageCount !== undefined)
            assert.equal(record.participant.messageCount, 0, "New delivery inherited history");
          for (const field of Object.keys(identities)) {
            const value = record.participant[field];
            if (value === undefined) continue;
            assert.equal(identities[field].has(value), false, "Participant identity was reused");
            identities[field].add(value);
          }
          await onParticipant(record);
        }
        return await operation(current[agent].driver, current[agent]);
      } finally {
        busy.delete(agent);
      }
    },
    async closeRound() {
      if (agentLifecycle === "per-delivery") {
        assert.equal(busy.size, 0, "Round has active deliveries");
        await closeSlots(true);
      }
    },
    close: () => closeSlots(false),
  };
}
