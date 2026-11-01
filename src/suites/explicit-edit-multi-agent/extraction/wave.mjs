import assert from "node:assert/strict";
import { runRoundPool } from "../execution/round-pool.mjs";

/** @returns {void | Promise<void>} */
const ignoreNotification = (_record) => {};

/** Release one whole-module assignment per participant after every fresh worker
 * is ready. The existing pool owns cancellation and confirmed process shutdown.
 * A startup failure must also release the waiting peers into shutdown.
 */
export async function runExtractionWave(
  tasks,
  {
    createDriver,
    execute,
    onParticipant = ignoreNotification,
    onClosed = ignoreNotification,
    ...options
  } = {},
) {
  assert.ok(Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 10);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  assert.equal(byId.size, tasks.length);
  const gate = Promise.withResolvers();
  // Startup can fail before another participant reaches its wait.
  void gate.promise.catch(() => {});
  let registered = 0,
    released = false;
  return runRoundPool(
    tasks.map(({ id }) => ({ id, dependencies: [] })),
    {
      ...options,
      maxAgents: tasks.length,
      maxStartingAgents: tasks.length,
      batchSize: 1,
      createDriver,
      async onParticipant(record) {
        await onParticipant(record);
        registered++;
        if (registered === tasks.length) {
          released = true;
          gate.resolve();
        }
        await gate.promise;
      },
      async onClosed(record) {
        if (!released) gate.reject(new Error("A participant closed before wave release"));
        await onClosed(record);
      },
      async executeBatch(driver, members, context) {
        assert.equal(members.length, 1);
        return execute(driver, byId.get(members[0].id), context);
      },
    },
  );
}
