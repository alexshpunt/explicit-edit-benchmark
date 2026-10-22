import assert from "node:assert/strict";
import { TASK_CONSTRAINTS_VERSION } from "../tasks/task-constraints.mjs";
/** Versioned dispatch semantics bound into preparation and reference proofs.
 * Participant count and correction budget remain separate suite/run policies.
 */
export const ATOMIC_DISPATCH_POLICY = Object.freeze({
  version: "renderer-atomic-stream-v1",
  assignment: "next-free-rotating",
  unit: "certified-binding-or-inseparable-overload-group-or-structural-unit",
  dependencyCompletion: "verified-output",
  checkpoints: "drained-parent-barriers",
  correctionAssignment: "original-atomic-executor",
  feedback: "task-scoped-observed-diagnostics-v1",
  barrierRecovery: "unique-task-attribution-or-infrastructure",
  taskConstraints: TASK_CONSTRAINTS_VERSION,
  environment: "shared-project-facts-v1",
  maxBatchSize: 50,
});

function graphState(nodes, completed) {
  const byId = new Map();
  for (const node of nodes) {
    assert.ok(typeof node.id === "string" && !byId.has(node.id), "Duplicate atomic node ID");
    assert.ok(Array.isArray(node.dependencies), "Missing atomic prerequisites");
    assert.equal(new Set(node.dependencies).size, node.dependencies.length);
    byId.set(node.id, node);
  }
  const successors = new Map(nodes.map((node) => [node.id, []]));
  const counts = new Map();
  for (const node of nodes) {
    for (const prerequisite of node.dependencies) {
      assert.ok(byId.has(prerequisite), "Unknown atomic prerequisite");
      successors.get(prerequisite).push(node.id);
    }
    counts.set(node.id, node.dependencies.length);
  }
  const ready = nodes.filter((node) => !counts.get(node.id)).map((node) => node.id);
  for (let index = 0; index < ready.length; index++)
    for (const next of successors.get(ready[index])) {
      const count = counts.get(next) - 1;
      counts.set(next, count);
      if (!count) ready.push(next);
    }
  assert.equal(ready.length, nodes.length, "Atomic dependency cycle");
  for (const id of completed) {
    assert.ok(byId.has(id), "Unknown completed atomic node");
    assert.ok(
      byId.get(id).dependencies.every((item) => completed.has(item)),
      "Completed atomic node has an incomplete prerequisite",
    );
  }
  return { byId, successors };
}

/** Dispatch batches of independently ready edits to free persistent participants. Successors unlock
 * only after a structural gate passes. Pending observations release participants
 * for unrelated work and are reconsidered after a delivery changes source.
 * Admission permits one look-ahead delivery beyond the participant pool while
 * outputs await verification; a bounded backlog must drain before more writes
 * can continually invalidate the same stable-source observations.
 * Editing failure drains peers; operational failure aborts and awaits them.
 * The caller owns corrections and current-workspace completion revalidation.
 * executeBatch(nodes, agent, signal, context) performs one native delivery for up to
 * batchSize edits (default 1, maximum 50). A small ready frontier is spread across
 * free participants before filling batches. The singleton execute(node, ...) callback
 * is available only with batchSize 1. verify(node, signal, receipt,
 * context) and optional checkInputs(node, signal, context) return true, false or
 * "pending". Context getters expose current writer state and copied sets:
 * completed alone unlocks successors; settled also includes unverified peer
 * effects for reconstructing expected context, never for prerequisite credit.
 * started retains dispatched IDs across barrier corrections. It reserves their
 * certified partial-write slots while they await repair, not prerequisite credit.
 * Return started, owners and completed when continuing the same barrier.
 * owners maps each actually delivered atom to its first participant. Repairs stay
 * in that participant's retained conversation; a busy owner does not reserve other
 * free participants or accept atoms owned by another participant.
 * Read context again after asynchronous observations. There are no timer-based
 * retries or extra model calls.
 * Writer startup also advances/wakes the frontier so invalidated input checks
 * do not wait for an unrelated long delivery. Only actual dispatch rotates agents.
 * Optional synchronous onCase(event) observes one lifetime from first input check
 * through verified completion, failure or teardown; pending retries do not reset
 * it. A private external watchdog can enforce deadlines without granting credit.
 */
export async function runAtomicStream(
  nodes,
  {
    agents,
    completed = new Set(),
    started = new Set(completed),
    owners = new Map(),
    rotation = 0,
    signal,
    execute,
    executeBatch,
    batchSize = 1,
    verify,
    checkInputs = async () => true,
    onCase,
  },
) {
  assert.ok(Number.isInteger(agents) && agents > 0, "Invalid atomic participant pool");
  assert.ok(Number.isInteger(rotation) && rotation >= 0, "Invalid atomic rotation");
  assert.ok(
    Number.isInteger(batchSize) &&
      batchSize > 0 &&
      batchSize <= ATOMIC_DISPATCH_POLICY.maxBatchSize,
    "Invalid atomic batch size",
  );
  assert.ok(
    typeof executeBatch === "function" || (batchSize === 1 && typeof execute === "function"),
    "Missing atomic batch executor",
  );
  assert.ok(onCase === undefined || typeof onCase === "function", "Invalid case observer");
  const done = new Set(completed);
  const dispatched = new Set([...started, ...completed]);
  const { byId, successors } = graphState(nodes, done);
  for (const id of dispatched) assert.ok(byId.has(id), "Unknown started atomic node");
  const assigned = new Map(owners);
  for (const [id, agent] of assigned) {
    assert.ok(byId.has(id) && dispatched.has(id), "Owner without an actual atomic delivery");
    assert.ok(Number.isInteger(agent) && agent >= 0 && agent < agents, "Invalid atomic owner");
  }
  for (const id of dispatched)
    if (!done.has(id))
      assert.ok(assigned.has(id), "Missing original atomic executor for correction");
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const remaining = new Map(
    nodes.map((node) => [node.id, node.dependencies.filter((id) => !done.has(id)).length]),
  );
  const ready = nodes
    .filter((node) => !done.has(node.id) && !remaining.get(node.id))
    .map((node) => node.id);
  const active = new Map();
  const checking = new Map();
  const pending = new Map();
  const writers = new Map();
  const failed = [];
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let cursor = rotation % agents;
  let fatal;
  let epoch = 0;
  let changed = Promise.withResolvers();
  function advance() {
    epoch++;
    const previous = changed;
    changed = Promise.withResolvers();
    previous.resolve({ stage: "frontier" });
  }
  const settled = new Set(done);
  const caseIds = new Set();
  function startCase(id) {
    if (!onCase || caseIds.has(id)) return;
    caseIds.add(id);
    onCase({ event: "case-start", id, phase: "atomic" });
  }
  function endCase(id, status) {
    if (!caseIds.delete(id)) return;
    onCase({ event: "case-end", id, phase: "atomic", status });
  }
  const context = () => ({
    get activeDeliveries() {
      return writers.size;
    },
    get activeWrites() {
      return writers.size > 0;
    },
    get writers() {
      return new Set([...writers.values()].flat());
    },
    get started() {
      return new Set(dispatched);
    },
    get completed() {
      return new Set(done);
    },
    get settled() {
      return new Set(settled);
    },
  });
  const outcome = (value) => {
    assert.ok(
      value === true || value === false || value === "pending",
      "Atomic gate must return true, false or pending",
    );
    return value;
  };
  const caught = (id, agent, error) => {
    if (!controller.signal.aborted) controller.abort(error);
    return { id, agent, error };
  };
  function launch(ids, agent) {
    const delivery = (async () => {
      const results = [];
      const selected = [];
      for (const id of ids) {
        startCase(id);
        const inputEpoch = epoch;
        const inputs = outcome(await checkInputs(byId.get(id), controller.signal, context()));
        controller.signal.throwIfAborted();
        if (inputs === true) selected.push(byId.get(id));
        else results.push({ id, passed: inputs, stage: "input", epoch: inputEpoch });
      }
      if (selected.length) {
        for (const node of selected) {
          dispatched.add(node.id);
          assigned.set(node.id, agent);
        }
        writers.set(
          agent,
          selected.map((node) => node.id),
        );
        cursor = (agent + 1) % agents;
        advance();
        let receipt;
        try {
          receipt = executeBatch
            ? await executeBatch(selected, agent, controller.signal, context())
            : await execute(selected[0], agent, controller.signal, context());
        } finally {
          writers.delete(agent);
        }
        controller.signal.throwIfAborted();
        for (const node of selected) settled.add(node.id);
        advance();
        for (const node of selected) {
          const outputEpoch = epoch;
          const passed = outcome(await verify(node, controller.signal, receipt, context()));
          controller.signal.throwIfAborted();
          results.push({ id: node.id, passed, receipt, stage: "output", epoch: outputEpoch });
        }
      }
      return { agent, results };
    })().catch((error) => ({ ...caught(undefined, agent, error), ids }));
    active.set(agent, delivery);
  }
  function reconsider(id, waiting) {
    const check = (async () => {
      const outputEpoch = epoch;
      const passed = outcome(
        await verify(byId.get(id), controller.signal, waiting.receipt, context()),
      );
      controller.signal.throwIfAborted();
      return { id, passed, receipt: waiting.receipt, stage: "output", epoch: outputEpoch };
    })().catch((error) => caught(id, undefined, error));
    pending.delete(id);
    checking.set(id, check);
  }
  try {
    controller.signal.throwIfAborted();
    while (ready.length || active.size || pending.size || checking.size) {
      for (const [id, waiting] of pending)
        if (
          waiting.stage === "input" &&
          (waiting.epoch < epoch || (!active.size && !checking.size))
        ) {
          pending.delete(id);
          ready.push(id);
        }
      ready.sort((a, b) => order.get(a) - order.get(b));
      // Reusing a free participant must not build an unbounded verification
      // queue. One look-ahead slot preserves unrelated work behind a deferred
      // gate; once full, existing writers/observers advance before new delivery.
      const deferredOutputs =
        checking.size + [...pending.values()].filter((item) => item.stage === "output").length;
      while (
        ready.length &&
        active.size < agents &&
        active.size + Math.ceil(deferredOutputs / batchSize) < agents + 1 &&
        !failed.length &&
        !controller.signal.aborted
      ) {
        const first = ready.findIndex((id) => !active.has(assigned.get(id)));
        if (first < 0) break;
        let agent = assigned.get(ready[first]);
        if (agent === undefined) {
          agent = cursor;
          while (active.has(agent)) agent = (agent + 1) % agents;
        }
        const eligible = ready.filter((id) => !assigned.has(id) || assigned.get(id) === agent);
        const count = Math.min(batchSize, Math.ceil(ready.length / (agents - active.size)));
        const ids = eligible.slice(0, count);
        for (const id of ids) ready.splice(ready.indexOf(id), 1);
        launch(ids, agent);
      }
      if (!controller.signal.aborted)
        for (const [id, waiting] of pending)
          if (
            waiting.stage === "output" &&
            (waiting.epoch < epoch || (!active.size && !checking.size))
          )
            reconsider(id, waiting);
      if (!active.size && !checking.size) break;
      const result = await Promise.race([
        ...active.values(),
        ...checking.values(),
        changed.promise,
      ]);
      if (result.stage === "frontier") continue;
      if (result.agent === undefined) checking.delete(result.id);
      else active.delete(result.agent);
      if (result.error) {
        for (const id of result.ids ?? [result.id]) endCase(id, "error");
        fatal ??= controller.signal.reason ?? result.error;
      } else {
        // Accept successful peers first: their newly verified frontier may make a
        // pending observation retryable even after the whole batch has drained.
        const results = result.results ?? [result];
        results.sort((left, right) => Number(right.passed === true) - Number(left.passed === true));
        for (const item of results) {
          if (item.passed === "pending") {
            if (
              !active.size &&
              !checking.size &&
              (!ready.length || failed.length || item.stage === "output") &&
              item.epoch === epoch
            )
              failed.push(item.id);
            else
              pending.set(item.id, {
                receipt: item.receipt,
                stage: item.stage,
                epoch: item.epoch,
              });
          } else if (!item.passed) {
            endCase(item.id, "fail");
            failed.push(item.id);
          } else {
            endCase(item.id, "pass");
            done.add(item.id);
            advance();
            for (const next of successors.get(item.id)) {
              const count = remaining.get(next) - 1;
              remaining.set(next, count);
              if (!count) ready.push(next);
            }
          }
        }
      }
    }
    if (fatal) throw fatal;
    controller.signal.throwIfAborted();
    assert.ok(failed.length || done.size === nodes.length, "Blocked atomic prerequisites");
    return {
      status: failed.length ? "blocked" : "pass",
      completed: done,
      started: dispatched,
      owners: assigned,
      failed,
      rotation: cursor,
    };
  } finally {
    await Promise.allSettled([...active.values(), ...checking.values()]);
    for (const id of caseIds) endCase(id, controller.signal.aborted ? "cancelled" : "blocked");
    signal?.removeEventListener("abort", abort);
  }
}
