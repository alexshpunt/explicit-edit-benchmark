import assert from "node:assert/strict";
import { runRoundPool } from "../execution/round-pool.mjs";

/** @returns {void | Promise<void>} */
const ignoreNotification = (_record) => {};

/** @typedef {Error & {category?: string, execution?: unknown, receipt?: unknown}} WaveError */

/** Release fixed whole-file queues after every fresh participant is ready.
 * The existing pool owns cancellation and confirmed process shutdown. Files
 * remain separate deliveries; no failed or unstarted file is reassigned.
 */
export async function runExtractionWave(
  tasks,
  {
    agents = Math.min(tasks?.length ?? 0, 10),
    createDriver,
    execute,
    onParticipant = ignoreNotification,
    onClosed = ignoreNotification,
    onDelivery = ignoreNotification,
    ...options
  } = {},
) {
  assert.ok(Array.isArray(tasks) && tasks.length > 0);
  assert.ok(Number.isSafeInteger(agents) && agents > 0 && agents <= 10 && agents <= tasks.length);
  assert.ok(tasks.every((task) => task && typeof task.id === "string" && task.id.length > 0));
  assert.equal(new Set(tasks.map(({ id }) => id)).size, tasks.length);
  for (const callback of [createDriver, execute, onParticipant, onClosed, onDelivery])
    assert.equal(typeof callback, "function");

  const groups = Array.from({ length: agents }, (_, agent) => ({
    id: tasks[agent].id,
    agent,
    tasks: tasks.filter((_task, index) => index % agents === agent),
  }));
  const byGroup = new Map(groups.map((group) => [group.id, group]));
  const deliveries = [];
  const completed = new Set();
  /** @type {{error: WaveError | null}} */
  const failureState = { error: null };
  const assertAdmissionOpen = () => {
    if (failureState.error !== null) throw failureState.error;
  };
  /** @returns {WaveError} */
  const asError = (reason) =>
    reason instanceof Error ? reason : new Error("A file assignment failed", { cause: reason });
  const delivered = () => tasks.filter(({ id }) => completed.has(id)).map(({ id }) => id);
  const gate = Promise.withResolvers();
  // Startup can fail before another participant reaches its wait.
  void gate.promise.catch(() => {});
  let registered = 0,
    released = false;

  try {
    const result = await runRoundPool(
      groups.map(({ id }) => ({ id, dependencies: [] })),
      {
        ...options,
        maxAgents: agents,
        maxStartingAgents: agents,
        batchSize: 1,
        createDriver,
        async onParticipant(record) {
          await onParticipant(record);
          registered++;
          if (registered === agents) {
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
          const group = byGroup.get(members[0].id);
          assert.ok(group);
          assert.equal(group.agent, context.agent);
          for (const task of group.tasks) {
            context.signal.throwIfAborted();
            assertAdmissionOpen();
            const delivery = {
              index: deliveries.length,
              agent: context.agent,
              session: context.session,
              ids: [task.id],
              status: "running",
            };
            deliveries.push(delivery);
            /** @type {WaveError | undefined} */
            let failure;
            try {
              await onDelivery({ event: "start", ...delivery });
              context.signal.throwIfAborted();
              assertAdmissionOpen();
              delivery.receipt = await execute(driver, task, context);
              context.signal.throwIfAborted();
              delivery.status = "settled";
              completed.add(task.id);
            } catch (reason) {
              failure = asError(reason);
              failureState.error ??= failure;
              delivery.status = context.signal.aborted ? "cancelled" : "error";
              delivery.failure = {
                name: failure.name,
                category:
                  failure.category ?? (context.signal.aborted ? "cancelled" : "infrastructure"),
                message: failure.message,
              };
              if (failure.execution !== undefined) delivery.receipt = failure.execution;
              else if (failure.receipt !== undefined) delivery.receipt = failure.receipt;
            }
            try {
              await onDelivery({ event: "end", ...delivery });
            } catch (reason) {
              // Preserve a native failure and its receipt if reporting also fails.
              failure ??= asError(reason);
              failureState.error ??= failure;
            }
            if (failure) throw failure;
          }
        },
      },
    );
    return { ...result, delivered: delivered(), deliveries };
  } catch (error) {
    if (error?.roundPool) {
      error.roundPool.deliveries = deliveries;
      error.roundPool.delivered = delivered();
    }
    throw error;
  }
}
