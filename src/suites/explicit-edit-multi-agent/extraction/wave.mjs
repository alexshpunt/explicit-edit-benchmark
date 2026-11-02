import assert from "node:assert/strict";
import { runRoundPool } from "../execution/round-pool.mjs";

/** @returns {void | Promise<void>} */
const ignoreNotification = (_record) => {};
/** @typedef {Error & {category?: string, execution?: unknown, receipt?: unknown}} WaveError */

/** Release fixed whole-file queues after every fresh participant is ready.
 * An optional shared barrier retains the original drivers for owner recovery.
 * The existing pool still owns cancellation and confirmed process shutdown.
 */
export async function runExtractionWave(
  tasks,
  {
    agents = Math.min(tasks?.length ?? 0, 10),
    createDriver,
    execute,
    afterOriginal = ignoreNotification,
    beforeRound,
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
  for (const callback of [
    createDriver,
    execute,
    afterOriginal,
    onParticipant,
    onClosed,
    onDelivery,
  ])
    assert.equal(typeof callback, "function");
  const groups = Array.from({ length: agents }, (_, agent) => ({
    id: tasks[agent].id,
    agent,
    tasks: tasks.filter((_task, index) => index % agents === agent),
  }));
  if (beforeRound !== undefined) assert.equal(typeof beforeRound, "function");
  const roundCount = beforeRound
    ? tasks.length
    : Math.max(...groups.map((group) => group.tasks.length));
  const rounds = beforeRound
    ? Array.from({ length: roundCount }, () => ({ arrived: 0, gate: Promise.withResolvers() }))
    : [];
  for (const round of rounds) void round.gate.promise.catch(() => {});
  const rejectRounds = (reason) => {
    for (const round of rounds) round.gate.reject(reason);
  };
  const byGroup = new Map(groups.map((group) => [group.id, group]));
  const owners = new Map(tasks.map((task, index) => [task.id, index % agents]));
  const held = new Map();
  const identities = new Map();
  const used = new Set(),
    busy = new Set();
  const deliveries = [],
    completed = new Set();
  /** @type {{error: WaveError | null}} */
  const failureState = { error: null };
  const asError = (reason) =>
    reason instanceof Error ? reason : new Error("A file assignment failed", { cause: reason });
  const assertAdmissionOpen = () => {
    if (failureState.error !== null) throw failureState.error;
  };
  const delivered = () => tasks.filter(({ id }) => completed.has(id)).map(({ id }) => id);
  const gate = Promise.withResolvers(),
    barrier = Promise.withResolvers();
  void gate.promise.catch(() => {});
  void barrier.promise.catch(() => {});
  let registered = 0,
    released = false,
    finished = 0;
  let verification = Promise.resolve();

  async function deliver(driver, task, context) {
    context.signal.throwIfAborted();
    assertAdmissionOpen();
    const stage = task.recovery?.stage ?? "original";
    const delivery = {
      index: deliveries.length,
      agent: context.agent,
      session: context.session,
      stage,
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
      delivery.receipt = await execute(driver, task, { ...context, stage });
      if (stage === "original") completed.add(task.id);
      delivery.status = "settled";
    } catch (reason) {
      failure = asError(reason);
      failureState.error ??= failure;
      delivery.status = context.signal.aborted ? "cancelled" : "error";
      delivery.failure = {
        name: failure.name,
        category: failure.category ?? (context.signal.aborted ? "cancelled" : "infrastructure"),
        message: failure.message,
      };
      if (failure.execution !== undefined) delivery.receipt = failure.execution;
      else if (failure.receipt !== undefined) delivery.receipt = failure.receipt;
    }
    try {
      await onDelivery({ event: "end", ...delivery });
    } catch (reason) {
      failure ??= asError(reason);
      failureState.error ??= failure;
    }
    if (failure) {
      // Original peers may already be waiting. Recovery peers must first drain
      // their current batch; the barrier callback owns that all-settled join.
      if (stage === "original") {
        rejectRounds(failure);
        barrier.reject(failure);
      }
      throw failure;
    }
    return delivery.receipt;
  }

  async function idleParticipants() {
    return Promise.all(
      groups.map(async ({ agent }) => {
        const { driver, context } = held.get(agent);
        context.signal.throwIfAborted();
        assert.equal(driver.closed, false);
        const participant = await driver.assertIdle();
        const initial = identities.get(agent);
        for (const key of ["sessionId", "lifetime"])
          if (initial[key] !== undefined) assert.equal(participant[key], initial[key]);
        return { agent, session: context.session, participant };
      }),
    );
  }

  async function inspectionRound(index, context) {
    const round = rounds[index];
    round.arrived++;
    if (round.arrived === agents) {
      // The callback receives only idle, live participants. Its signal lets the
      // controller interrupt approval without leaving a worker stuck forever.
      Promise.resolve()
        .then(async () => {
          context.signal.throwIfAborted();
          assertAdmissionOpen();
          const participants = await idleParticipants();
          await beforeRound({
            round: index,
            participants,
            ids: [tasks[index].id],
            assertIdle: idleParticipants,
            signal: context.signal,
          });
          context.signal.throwIfAborted();
          assertAdmissionOpen();
          await idleParticipants();
        })
        .then(round.gate.resolve, (reason) => {
          const failure = asError(reason);
          failureState.error ??= failure;
          rejectRounds(failure);
          barrier.reject(failure);
        });
    }
    await round.gate.promise;
  }
  async function recover(owner, task) {
    assert.ok(Number.isSafeInteger(owner) && held.has(owner));
    assert.equal(task.recovery?.stage, "structural-correction");
    if (task.kind === "main-recovery") assert.equal(task.id, "repair-shared-project");
    else {
      assert.equal(owners.get(task.id), owner, "Recovery must retain the original owner");
      assert.equal(task.file, tasks.find(({ id }) => id === task.id).file);
    }
    assert.equal(used.has(task.id), false, "A file has already spent its recovery");
    assert.equal(busy.has(owner), false, "A participant already has an active recovery");
    assertAdmissionOpen();
    used.add(task.id);
    busy.add(owner);
    const { driver, context } = held.get(owner);
    try {
      assert.equal(driver.closed, false);
      await driver.assertIdle();
      return await deliver(driver, task, context);
    } finally {
      busy.delete(owner);
    }
  }

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
          identities.set(record.agent, record.participant);
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
          held.set(context.agent, { driver, context });
          const abort = () => {
            rejectRounds(context.signal.reason);
            barrier.reject(context.signal.reason);
          };
          context.signal.addEventListener("abort", abort, { once: true });
          try {
            if (beforeRound) {
              for (let index = 0; index < rounds.length; index++) {
                await inspectionRound(index, context);
                if (owners.get(tasks[index].id) === group.agent)
                  await deliver(driver, tasks[index], context);
              }
            } else {
              for (const task of group.tasks) await deliver(driver, task, context);
            }
            if (afterOriginal !== ignoreNotification) {
              finished++;
              if (finished === agents) {
                verification = Promise.resolve()
                  .then(async () => {
                    context.signal.throwIfAborted();
                    assertAdmissionOpen();
                    const participants = await idleParticipants();
                    await afterOriginal({
                      participants,
                      recover,
                      assertIdle: idleParticipants,
                      signal: context.signal,
                    });
                    assertAdmissionOpen();
                  })
                  .then(barrier.resolve, barrier.reject);
              }
              await barrier.promise;
            }
          } finally {
            context.signal.removeEventListener("abort", abort);
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
  } finally {
    // A cancelled measurement must finish its own subprocess cleanup as well.
    await verification;
  }
}
