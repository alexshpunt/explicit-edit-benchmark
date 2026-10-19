import assert from "node:assert/strict";
/** Versioned dispatch semantics bound into preparation and reference proofs.
 * Participant count and correction budget remain separate suite/run policies.
 */
export const ATOMIC_DISPATCH_POLICY = Object.freeze({
  version: "renderer-atomic-stream-v1",
  assignment: "next-free-rotating",
  unit: "certified-binding-or-inseparable-overload-group-or-structural-unit",
  dependencyCompletion: "verified-output",
  checkpoints: "drained-parent-barriers",
  barrierRecovery: "single-global-delivery",
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

/** Dispatch one ready edit to each free persistent participant. Successors unlock
 * only after a structural gate passes. Pending observations release participants
 * for unrelated work and are reconsidered after a delivery changes source.
 * Editing failure drains peers; operational failure aborts and awaits them.
 * The caller owns corrections and current-workspace completion revalidation.
 * execute(node, agent, signal, context) performs one delivery. verify(node, signal, receipt,
 * context) and optional checkInputs(node, signal, context) return true, false or
 * "pending". Context getters expose current writer state and copied sets:
 * completed alone unlocks successors; settled also includes unverified peer
 * effects for reconstructing expected context, never for prerequisite credit.
 * started retains dispatched IDs across barrier corrections. It reserves their
 * certified partial-write slots while they await repair, not prerequisite credit.
 * Return started together with completed when continuing the same barrier.
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
    rotation = 0,
    signal,
    execute,
    verify,
    checkInputs = async () => true,
    onCase,
  },
) {
  assert.ok(Number.isInteger(agents) && agents > 0, "Invalid atomic participant pool");
  assert.ok(Number.isInteger(rotation) && rotation >= 0, "Invalid atomic rotation");
  assert.ok(onCase === undefined || typeof onCase === "function", "Invalid case observer");
  const done = new Set(completed);
  const dispatched = new Set([...started, ...completed]);
  const { byId, successors } = graphState(nodes, done);
  for (const id of dispatched) assert.ok(byId.has(id), "Unknown started atomic node");
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
    get activeWrites() {
      return writers.size > 0;
    },
    get writers() {
      return new Set(writers.values());
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
  function launch(id, agent) {
    const node = byId.get(id);
    const delivery = (async () => {
      startCase(id);
      const inputEpoch = epoch;
      const inputs = outcome(await checkInputs(node, controller.signal, context()));
      controller.signal.throwIfAborted();
      if (inputs !== true) return { id, agent, passed: inputs, stage: "input", epoch: inputEpoch };
      dispatched.add(id);
      writers.set(agent, id);
      cursor = (agent + 1) % agents;
      advance();
      let receipt;
      try {
        receipt = await execute(node, agent, controller.signal, context());
      } finally {
        writers.delete(agent);
      }
      controller.signal.throwIfAborted();
      settled.add(id);
      advance();
      const outputEpoch = epoch;
      const passed = outcome(await verify(node, controller.signal, receipt, context()));
      controller.signal.throwIfAborted();
      return { id, agent, passed, receipt, stage: "output", epoch: outputEpoch };
    })().catch((error) => caught(id, agent, error));
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
      while (ready.length && active.size < agents && !failed.length && !controller.signal.aborted) {
        let agent = cursor;
        while (active.has(agent)) agent = (agent + 1) % agents;
        launch(ready.shift(), agent);
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
        endCase(result.id, "error");
        fatal ??= controller.signal.reason ?? result.error;
      } else if (result.passed === "pending") {
        // A deferred check may already be stale when its promise is consumed.
        // Only a drained, unchanged frontier can turn pending into a block.
        if (
          !active.size &&
          !checking.size &&
          (!ready.length || failed.length) &&
          result.epoch === epoch
        )
          failed.push(result.id);
        else
          pending.set(result.id, {
            receipt: result.receipt,
            stage: result.stage,
            epoch: result.epoch,
          });
      } else if (!result.passed) {
        endCase(result.id, "fail");
        failed.push(result.id);
      } else {
        endCase(result.id, "pass");
        done.add(result.id);
        advance();
        for (const next of successors.get(result.id)) {
          const count = remaining.get(next) - 1;
          remaining.set(next, count);
          if (!count) ready.push(next);
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
      failed,
      rotation: cursor,
    };
  } finally {
    await Promise.allSettled([...active.values(), ...checking.values()]);
    for (const id of caseIds) endCase(id, controller.signal.aborted ? "cancelled" : "blocked");
    signal?.removeEventListener("abort", abort);
  }
}
