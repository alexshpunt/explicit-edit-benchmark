import assert from "node:assert/strict";
import { runRoundPool } from "./round-pool.mjs";

// Ten persistent workers share the batches of exactly one task at a time.
// Scaffolds are created before any worker starts.
export async function runChunkTeam(tasks, { agents = 10, execute, signal, ...options }) {
  assert.ok(tasks.length && tasks.every((t) => t.id && t.batches.length));
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  assert.equal(typeof execute, "function");
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
    maxStartingAgents: agents,
    batchSize: 1,
    signal,
    async executeBatch(driver, packet, context) {
      assert.equal(packet.length, 1);
      let count = 0;
      for (;;) {
        const item = await claim(context.signal);
        if (!item) return { count };
        try {
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
