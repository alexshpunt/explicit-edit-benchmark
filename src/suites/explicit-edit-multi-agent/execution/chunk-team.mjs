import assert from "node:assert/strict";
import { runRoundPool } from "./round-pool.mjs";

// Ten persistent workers share the batches of exactly one task at a time.
// Scaffolds are created before any worker starts.
// Optional onDrained runs once while every driver is still owned and live. Its
// participants record claimed task IDs, not proof of successful edits. The
// callback must settle on signal abort and must not close the owned drivers:
// the pool retains them until the callback settles.
export async function runChunkTeam(
  tasks,
  { agents = 10, createDriver, execute, onDrained, signal, ...options },
) {
  assert.ok(tasks.length && tasks.every((t) => t.id && t.batches.length));
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  assert.equal(typeof createDriver, "function");
  assert.equal(typeof execute, "function");
  assert.ok(onDrained === undefined || typeof onDrained === "function");
  const participants = new Map();
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
  const groups = Array.from({ length: agents }, (_, i) => ({
    id: `worker-${i}`,
    dependencies: [],
  }));
  return runRoundPool(groups, {
    ...options,
    maxAgents: agents,
    async createDriver(agent, session, context) {
      const driver = await createDriver(agent, session, context);
      if (!onDrained || !driver || typeof driver !== "object") return driver;
      return new Proxy(driver, {
        get(target, key) {
          const value = target[key];
          if (typeof value !== "function") return value;
          if (key === "terminate" || key === "close")
            return async (...args) => {
              if (barrierStarted) await barrier.promise.catch(() => {});
              return value.apply(target, args);
            };
          return value.bind(target);
        },
      });
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
          if (onDrained) {
            participant.drained = true;
            if (
              participants.size === agents &&
              [...participants.values()].every((p) => p.drained)
            ) {
              barrierStarted = true;
              const retained = [...participants.values()]
                .sort((a, b) => a.agent - b.agent)
                .map(({ agent, session, driver, tasks }) => ({
                  agent,
                  session,
                  driver,
                  tasks: [...tasks],
                }));
              void Promise.resolve()
                .then(() => onDrained({ participants: retained, signal: context.signal }))
                .then(barrier.resolve, barrier.reject);
            }
            try {
              await wait(barrier.promise, context.signal);
            } catch (error) {
              // Do not close drivers while a started recovery callback can still write.
              if (barrierStarted) await barrier.promise.catch(() => {});
              throw error;
            }
          }
          return { count };
        }
        try {
          participant.tasks.add(item.task.id);
          await execute(driver, item.batch, {
            ...context,
            task: item.task.id,
            index: item.index,
            group: packet[0].id,
          });
          count++;
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          active--;
          notify();
        }
      }
    },
  });
}
