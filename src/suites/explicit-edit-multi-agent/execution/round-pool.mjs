import assert from "node:assert/strict";
import { setMaxListeners } from "node:events";
import { atomicOrder } from "../tasks/atomic-effects.mjs";

export const ROUND_POOL_POLICY = Object.freeze({
  version: "renderer-round-pool-v3",
  providerFailure: "stop-new-deliveries-and-drain-inflight-without-peer-abort",
  initializationConcurrency: 8,
  assignment: "first-ready-work-conserving",
  dependencyCompletion: "returned-packet-or-earlier-in-same-packet",
  lifecycle: "reuse-ready-worker-terminate-otherwise",
  occupancy: "starting-running-and-closing-processes",
});

/** Notification hooks can complete synchronously or return a promise.
 * @returns {void | Promise<void>}
 */
const ignoreNotification = (_record) => {};
/** Run one editing wave. The caller owns prompts and grading; this scheduler only
 * releases dependencies when a packet returns. Factories must clean up resources
 * they create but never return, and should pass their supplied signal to startup.
 * All returned drivers remain owned until their shutdown is confirmed. An
 * executor must settle when its signal aborts or its driver closes. Notification
 * hooks may be asynchronous; their failures abort the wave and their completion
 * is awaited. Extensible thrown errors retain private records at error.roundPool.
 */
export async function runRoundPool(
  nodes,
  {
    maxAgents,
    maxStartingAgents = Math.min(maxAgents, ROUND_POOL_POLICY.initializationConcurrency),
    batchSize = 10,
    createDriver,
    executeBatch,
    onParticipant = ignoreNotification,
    onDelivery = ignoreNotification,
    onClosed = ignoreNotification,
    usage = () => null,
    signal,
  } = {},
) {
  assert.ok(Number.isSafeInteger(maxAgents) && maxAgents > 0, "Invalid round participant limit");
  assert.ok(
    Number.isSafeInteger(maxStartingAgents) &&
      maxStartingAgents > 0 &&
      maxStartingAgents <= maxAgents,
    "Invalid participant initialization limit",
  );
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, "Invalid round packet size");
  for (const callback of [createDriver, executeBatch, onParticipant, onDelivery, onClosed, usage])
    assert.equal(typeof callback, "function", "Invalid round pool callback");
  assert.ok(Array.isArray(nodes), "Missing round work graph");
  for (const node of nodes)
    assert.ok(
      node && typeof node.id === "string" && node.id.length > 0 && Array.isArray(node.dependencies),
      "Invalid round work item",
    );
  const ordered = nodes.map((node) => ({ ...node, dependencies: [...node.dependencies] }));
  atomicOrder(ordered);

  const controller = new AbortController();
  const pending = new Map(ordered.map((node) => [node.id, node]));
  const completed = new Set();
  const slots = Array.from({ length: Math.min(maxAgents, ordered.length) });
  setMaxListeners(Math.max(10, slots.length * 4), controller.signal);
  const records = [];
  const deliveries = [];
  const workers = new Map();
  const owned = new Map();
  const closing = new Map();
  const starting = new Set();
  const notifications = [];
  const identities = { sessionId: new Set(), lifetime: new Set() };
  let changed = Promise.withResolvers();
  /** @type {{error: Error | null}} */
  const failureState = { error: null };
  const asError = (reason) =>
    reason instanceof Error ? reason : new Error("Round operation failed", { cause: reason });

  async function settleNotification(operation) {
    try {
      await operation;
    } catch (error) {
      fail(error);
    }
  }

  function wake() {
    const previous = changed;
    changed = Promise.withResolvers();
    previous.resolve();
  }

  function notify(callback, value) {
    try {
      const result = callback(value);
      if (result && typeof result.then === "function")
        notifications.push(settleNotification(result));
    } catch (error) {
      fail(error);
    }
  }

  function fail(error, { abortPeers = true } = {}) {
    failureState.error ??= asError(error);
    if (abortPeers && !controller.signal.aborted) controller.abort(failureState.error);
    wake();
  }

  function takePacket() {
    if (controller.signal.aborted || failureState.error !== null) return [];
    const packet = [];
    const withinPacket = new Set();
    while (packet.length < batchSize) {
      let next;
      for (const node of pending.values()) {
        if (node.dependencies.every((id) => completed.has(id) || withinPacket.has(id))) {
          next = node;
          break;
        }
      }
      if (!next) break;
      pending.delete(next.id);
      withinPacket.add(next.id);
      packet.push(next);
    }
    return packet;
  }

  function retire(record) {
    if (closing.has(record)) return closing.get(record);
    const completion = Promise.withResolvers();
    closing.set(record, completion.promise);
    const driver = owned.get(record);
    const close = async () => {
      if (!driver) {
        record.closed = !record.created;
        notify(onClosed, record);
        return;
      }
      record.status = "closing";
      /** @type {Error | undefined} */
      let failure;
      try {
        const terminate = driver.terminate ?? driver.close;
        assert.equal(typeof terminate, "function", "Participant has no shutdown operation");
        await terminate.call(driver);
        assert.equal(driver.closed, true, "Participant shutdown did not finish");
      } catch (error) {
        failure = asError(error);
        record.closeFailed = true;
        fail(error);
        if (
          driver.closed !== true &&
          typeof driver.terminate === "function" &&
          typeof driver.close === "function"
        ) {
          try {
            await driver.close();
          } catch {
            // The original shutdown failure remains the cause; cleanup is still attempted.
          }
        }
      } finally {
        record.closed = driver.closed === true && !record.closeFailed;
        record.status = failure ? "error" : "closed";
        if (driver.closed === true) owned.delete(record);
        try {
          record.usage = await Promise.resolve(usage(driver));
        } catch (error) {
          failure ??= asError(error);
          fail(failure);
        }
        notify(onClosed, record);
      }
      if (failure) throw failure;
    };
    void close().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  function abortable(operation) {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(operation)
        .then(resolve, reject)
        .finally(() => {
          controller.signal.removeEventListener("abort", abort);
        });
    });
  }

  async function runWorker(record, firstPacket) {
    let driver;
    try {
      driver = await createDriver(record.agent, record.session, { signal: controller.signal });
      assert.ok(driver && typeof driver === "object", "Missing participant driver");
      owned.set(record, driver);
      record.created = true;
      controller.signal.throwIfAborted();
      assert.ok(driver && driver.closed === false, "Participant did not start alive");
      await abortable(driver.ready);
      controller.signal.throwIfAborted();
      assert.equal(typeof driver.assertIdle, "function", "Participant cannot report initial state");
      record.participant = await abortable(driver.assertIdle());
      assert.ok(
        record.participant && typeof record.participant === "object",
        "Missing participant identity",
      );
      if (record.participant.messageCount !== undefined)
        assert.equal(record.participant.messageCount, 0, "Round participant inherited history");
      for (const field of Object.keys(identities)) {
        const value = record.participant[field];
        if (value === undefined) continue;
        assert.equal(identities[field].has(value), false, "Participant identity was reused");
        identities[field].add(value);
      }
      await abortable(onParticipant(record));
      controller.signal.throwIfAborted();
      starting.delete(record);
      wake();
      let packet = firstPacket;
      while (packet.length) {
        controller.signal.throwIfAborted();
        record.status = "running";
        const delivery = {
          index: deliveries.length,
          agent: record.agent,
          session: record.session,
          ids: packet.map(({ id }) => id),
          status: "running",
        };
        deliveries.push(delivery);
        notify(onDelivery, { event: "start", ...delivery });
        try {
          controller.signal.throwIfAborted();
          delivery.receipt = await executeBatch(driver, packet, {
            agent: record.agent,
            session: record.session,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          for (const member of packet) completed.add(member.id);
          delivery.status = "settled";
        } catch (error) {
          delivery.status = controller.signal.aborted ? "cancelled" : "error";
          delivery.failure = {
            name: error?.name ?? "Error",
            category:
              error?.category ?? (controller.signal.aborted ? "cancelled" : "infrastructure"),
            message: error?.message ?? String(error),
          };
          if (error?.execution !== undefined) delivery.receipt = error.execution;
          else if (error?.receipt !== undefined) delivery.receipt = error.receipt;
          fail(error, { abortPeers: error?.category !== "provider_failure" });
          throw error;
        } finally {
          notify(onDelivery, { event: "end", ...delivery });
        }
        packet = takePacket();
        wake();
      }
    } catch (error) {
      record.status = "error";
      fail(error, { abortPeers: error?.category !== "provider_failure" });
    } finally {
      try {
        await retire(record);
      } catch (error) {
        fail(error);
      }
    }
  }

  function launch(agent, packet) {
    const record = {
      agent,
      session: records.length,
      created: false,
      closed: false,
      status: "starting",
    };
    records.push(record);
    slots[agent] = record;
    starting.add(record);
    const task = runWorker(record, packet).finally(() => {
      workers.delete(agent);
      starting.delete(record);
      // A failed shutdown cannot free capacity for a replacement process.
      if (!owned.has(record)) slots[agent] = undefined;
      wake();
    });
    workers.set(agent, task);
  }

  const abort = () => fail(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    while (!controller.signal.aborted) {
      const progress = changed.promise;
      for (let agent = 0; agent < slots.length; agent++) {
        if (slots[agent]) continue;
        if (starting.size >= maxStartingAgents) break;
        const packet = takePacket();
        if (packet.length) launch(agent, packet);
      }
      if (!workers.size) {
        if (failureState.error === null)
          assert.equal(
            completed.size,
            ordered.length,
            "Round stopped before its work graph drained",
          );
        break;
      }
      await progress;
    }
    // The async coordinator owns shutdown promises; failure callbacks only signal it.
    for (const record of owned.keys()) void retire(record).catch(() => {});
    await Promise.allSettled([...workers.values()]);
    await Promise.allSettled([...closing.values()]);
    await Promise.allSettled(notifications);
    if (failureState.error !== null) {
      const primaryFailure = failureState.error;
      if (Object.isExtensible(primaryFailure) && !Object.hasOwn(primaryFailure, "roundPool"))
        Reflect.defineProperty(primaryFailure, "roundPool", {
          value: { records, deliveries },
          configurable: true,
        });
      throw primaryFailure;
    }
    assert.ok(
      records.every(({ closed }) => closed),
      "Round still owns an unclosed participant",
    );
    return {
      status: "drained",
      delivered: ordered.filter(({ id }) => completed.has(id)).map(({ id }) => id),
      records,
      deliveries,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
