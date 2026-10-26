import assert from "node:assert/strict";
import { atomicOrder } from "../tasks/atomic-effects.mjs";
import { TASK_CONSTRAINTS_VERSION } from "../tasks/task-constraints.mjs";

/** Preparation and proofs bind the scheduling semantics, independently of message size. */
export const ATOMIC_DISPATCH_POLICY = Object.freeze({
  version: "renderer-atomic-stream-v2",
  assignment: "balanced-team-dependency-components",
  unit: "public-atomic-request",
  dependencyCompletion: "ordered-same-participant-turns",
  checkpoints: "drained-parent-barriers",
  correctionAssignment: "balanced-team-by-file",
  feedback: "public-prompts-then-compiler-then-pixels-v1",
  barrierRecovery: "whole-team-no-executor-attribution",
  taskConstraints: TASK_CONSTRAINTS_VERSION,
  environment: "shared-project-facts-v1",
  /** @type {number} */
  defaultBatchSize: 50,
});

/** Divide whole connected dependency components by atom count. Each queue is
 * topological; independent atoms differ by at most one when no chains constrain
 * the split. Long chains remain indivisible even when that leaves agents idle.
 */
export function partitionAtomicQueues(nodes, agents, rotation = 0) {
  assert.ok(Number.isInteger(agents) && agents > 0, "Invalid atomic participant pool");
  assert.ok(Number.isInteger(rotation) && rotation >= 0, "Invalid atomic rotation");
  const ordered = atomicOrder(nodes);
  const parents = new Map(ordered.map((node) => [node.id, node.id]));
  function root(id) {
    let current = id;
    while (parents.get(current) !== current) current = parents.get(current);
    while (parents.get(id) !== id) {
      const next = parents.get(id);
      parents.set(id, current);
      id = next;
    }
    return current;
  }
  for (const node of ordered)
    for (const dependency of node.dependencies) parents.set(root(node.id), root(dependency));
  const components = new Map();
  for (const node of ordered) {
    const id = root(node.id);
    if (!components.has(id)) components.set(id, []);
    components.get(id).push(node);
  }
  const queues = Array.from({ length: agents }, () => []);
  const position = new Map(ordered.map((node, index) => [node.id, index]));
  for (const component of [...components.values()].sort((a, b) => b.length - a.length)) {
    let selected = rotation % agents;
    for (let offset = 1; offset < agents; offset++) {
      const agent = (rotation + offset) % agents;
      if (queues[agent].length < queues[selected].length) selected = agent;
    }
    queues[selected].push(...component);
  }
  for (const queue of queues) queue.sort((a, b) => position.get(a.id) - position.get(b.id));
  return queues;
}

/** Harness control return advances one participant's fixed queue. There are no
 * source observations, reply-text signals or edit credits between barriers.
 * Only an operational failure aborts peers; teardown awaits every active turn.
 */
export async function runAtomicStream(
  nodes,
  {
    agents,
    rotation = 0,
    signal,
    execute,
    executeBatch,
    batchSize = ATOMIC_DISPATCH_POLICY.defaultBatchSize,
    onCase,
  },
) {
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, "Invalid atomic batch size");
  assert.ok(
    typeof executeBatch === "function" || (batchSize === 1 && typeof execute === "function"),
    "Missing atomic batch executor",
  );
  assert.ok(onCase === undefined || typeof onCase === "function", "Invalid case observer");
  const queues = partitionAtomicQueues(nodes, agents, rotation);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const delivered = new Set();
  const writers = new Map();
  const context = {
    assignedParticipants: queues.filter((queue) => queue.length).length,
    get activeDeliveries() {
      return writers.size;
    },
    get writers() {
      return new Set([...writers.values()].flat());
    },
  };
  try {
    controller.signal.throwIfAborted();
    await Promise.allSettled(
      queues.map(async (queue, agent) => {
        try {
          for (let offset = 0; offset < queue.length; offset += batchSize) {
            controller.signal.throwIfAborted();
            const batch = queue.slice(offset, offset + batchSize);
            writers.set(
              agent,
              batch.map((node) => node.id),
            );
            for (const node of batch)
              onCase?.({ event: "case-start", id: node.id, phase: "delivery" });
            let status = "settled";
            try {
              if (executeBatch) await executeBatch(batch, agent, controller.signal, context);
              else await execute(batch[0], agent, controller.signal, context);
              controller.signal.throwIfAborted();
              for (const node of batch) delivered.add(node.id);
            } catch (error) {
              status = controller.signal.aborted ? "cancelled" : "error";
              throw error;
            } finally {
              writers.delete(agent);
              for (const node of batch)
                onCase?.({ event: "case-end", id: node.id, phase: "delivery", status });
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) controller.abort(error);
        }
      }),
    );
    controller.signal.throwIfAborted();
    return {
      status: "drained",
      delivered,
      queues: queues.map((queue) => queue.map((node) => node.id)),
      rotation: (rotation + 1) % agents,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
