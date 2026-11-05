import assert from "node:assert/strict";
import { runRoundPool } from "./round-pool.mjs";

// Ten persistent workers share the batches of exactly one task at a time.
// Scaffolds are created before any worker starts.
// Optional onDrained runs once with all surviving drivers retained. Its
// participants record claimed task IDs, not proof of successful edits. The
// callback must settle on abort. After a delivery has finished, participant.retire()
// may stop that driver inside the barrier; otherwise the pool owns shutdown.
// An execute receipt with timedOut:true retires that worker only after confirmed
// shutdown. Returned timeout and unissued lists describe incomplete work.
export async function runChunkTeam(
  tasks,
  { agents = 10, createDriver, execute, onDrained, signal, ...options },
) {
  assert.ok(tasks.length && tasks.every((t) => t.id && t.batches.length));
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  assert.equal(typeof createDriver, "function");
  assert.equal(typeof execute, "function");
  assert.ok(onDrained === undefined || typeof onDrained === "function");
  assert.ok(options.onDelivery === undefined || typeof options.onDelivery === "function");
  const participants = new Map();
  const rawDrivers = new WeakMap();
  const timeouts = [];
  const deferred = new Map(tasks.map((task) => [task.id, []]));
  const deferredCount = new Map(tasks.map((task) => [task.id, 0]));
  const barrier = Promise.withResolvers();
  // A cancellation may leave no worker waiting for the callback's failure.
  barrier.promise.catch(() => {});
  let barrierStarted = false;
  let taskIndex = 0,
    nextBatch = 0,
    active = 0,
    failure,
    changed = Promise.withResolvers();
  const notify = () => {
    const old = changed;
    changed = Promise.withResolvers();
    old.resolve();
  };
  async function wait(promise, abortSignal) {
    const cancelled = Promise.withResolvers();
    const abort = () => cancelled.reject(abortSignal.reason);
    abortSignal.addEventListener("abort", abort, { once: true });
    if (abortSignal.aborted) abort();
    try {
      await Promise.race([promise, cancelled.promise]);
    } finally {
      abortSignal.removeEventListener("abort", abort);
    }
  }
  async function claim(abortSignal) {
    for (;;) {
      abortSignal.throwIfAborted();
      if (failure) throw failure;
      if (taskIndex === tasks.length) return null;
      const task = tasks[taskIndex];
      const pendingSplit = deferred.get(task.id).shift();
      if (pendingSplit) {
        active++;
        return { task, ...pendingSplit };
      }
      if (nextBatch < task.batches.length) {
        const index = nextBatch++;
        active++;
        return { task, index, batch: task.batches[index] };
      }
      if (active === 0 && nextBatch === task.batches.length) {
        taskIndex++;
        nextBatch = 0;
        notify();
        continue;
      }
      const event = changed.promise;
      await wait(event, abortSignal);
    }
  }
  function startBarrier(context) {
    if (
      !onDrained ||
      barrierStarted ||
      participants.size !== agents ||
      ![...participants.values()].every((participant) => participant.drained || participant.retired)
    )
      return;
    barrierStarted = true;
    const retained = [...participants.values()]
      .filter((participant) => !participant.retired)
      .sort((a, b) => a.agent - b.agent)
      .map((participant) => ({
        agent: participant.agent,
        session: participant.session,
        driver: participant.driver,
        tasks: [...participant.tasks],
        async retire() {
          const raw = rawDrivers.get(participant.driver);
          assert.ok(raw, "Participant is not owned by this team");
          if (!raw.closed) {
            const stop = raw.terminate ?? raw.close;
            assert.equal(typeof stop, "function");
            await stop.call(raw);
          }
          assert.equal(raw.closed, true, "Participant shutdown did not finish");
          participant.retired = true;
        },
      }));
    void Promise.resolve()
      .then(() => onDrained({ participants: retained, signal: context.signal }))
      .then(barrier.resolve, barrier.reject);
  }
  async function drainBarrier(context) {
    startBarrier(context);
    if (!onDrained) return;
    try {
      await wait(barrier.promise, context.signal);
    } catch (error) {
      if (barrierStarted) await barrier.promise.catch(() => {});
      throw error;
    }
  }
  const groups = Array.from({ length: agents }, (_, i) => ({
    id: `worker-${i}`,
    dependencies: [],
  }));
  const result = await runRoundPool(groups, {
    ...options,
    onDelivery(event) {
      const row =
        event.event === "end" && event.receipt?.timedOut === true
          ? { ...event, status: "timed-out" }
          : event;
      return options.onDelivery?.(row);
    },
    maxAgents: agents,
    async createDriver(agent, session, context) {
      const driver = await createDriver(agent, session, context);
      if (!driver || typeof driver !== "object") return driver;
      const proxy = new Proxy(driver, {
        get(target, key) {
          const value = target[key];
          if (typeof value !== "function") return value;
          if (key === "terminate" || key === "close")
            return async (...args) => {
              if (target.closed === true) return;
              if (barrierStarted) await barrier.promise.catch(() => {});
              if (target.closed === true) return;
              return value.apply(target, args);
            };
          return value.bind(target);
        },
      });
      rawDrivers.set(proxy, driver);
      return proxy;
    },
    maxStartingAgents: agents,
    batchSize: 1,
    signal,
    async executeBatch(driver, packet, context) {
      assert.equal(packet.length, 1);
      let count = 0;
      const participant = {
        agent: context.agent,
        session: context.session,
        driver,
        tasks: new Set(),
      };
      participants.set(context.agent, participant);
      for (;;) {
        const item = await claim(context.signal);
        if (!item) {
          participant.drained = true;
          await drainBarrier(context);
          return { count };
        }
        let timedOut = false;
        let itemActive = true;
        try {
          participant.tasks.add(item.task.id);
          const receipt = await execute(driver, item.batch, {
            ...context,
            task: item.task.id,
            index: item.index,
            group: packet[0].id,
            defer(batch) {
              assert.ok(
                itemActive &&
                  batch &&
                  batch.taskId === item.task.id &&
                  typeof batch.id === "string",
              );
              const count = deferredCount.get(item.task.id);
              deferredCount.set(item.task.id, count + 1);
              deferred.get(item.task.id).push({ batch, index: item.task.batches.length + count });
              notify();
            },
          });
          if (receipt?.timedOut === true) {
            assert.equal(driver.closed, true, "Timed-out participant remains active");
            participant.retired = true;
            timedOut = true;
            timeouts.push({
              task: item.task.id,
              index: item.index,
              batchId: item.batch?.id ?? null,
              agent: context.agent,
              session: context.session,
            });
          } else count++;
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          itemActive = false;
          active--;
          notify();
        }
        if (timedOut) {
          startBarrier(context);
          if (barrierStarted) await drainBarrier(context);
          return { count, timedOut: true };
        }
      }
    },
  });
  const unissued = [];
  for (let i = taskIndex; i < tasks.length; i++) {
    const task = tasks[i];
    for (const item of deferred.get(task.id))
      unissued.push({ task: task.id, index: item.index, batchId: item.batch.id });
    for (let index = i === taskIndex ? nextBatch : 0; index < task.batches.length; index++)
      unissued.push({ task: task.id, index, batchId: task.batches[index]?.id ?? null });
  }
  timeouts.sort(
    (a, b) =>
      tasks.findIndex((task) => task.id === a.task) -
        tasks.findIndex((task) => task.id === b.task) || a.index - b.index,
  );
  const timedOutGroups = new Set(
    result.deliveries.filter((item) => item.receipt?.timedOut === true).flatMap((item) => item.ids),
  );
  const deliveries = result.deliveries.map((item) =>
    item.receipt?.timedOut === true ? { ...item, status: "timed-out" } : item,
  );
  return {
    ...result,
    status: timeouts.length || unissued.length ? "partial" : result.status,
    delivered: result.delivered.filter((id) => !timedOutGroups.has(id)),
    deliveries,
    timeouts,
    unissued,
  };
}
