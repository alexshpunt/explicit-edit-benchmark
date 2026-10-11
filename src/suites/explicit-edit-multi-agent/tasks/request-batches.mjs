import { runRequestChain } from "../execution/request-chain.mjs";

/** Group consecutive related requests without reordering, dropping targets or mixing phases.
 * The approved full-workload limit is twenty. This does not change the eleven-step pilot.
 */
export function batchRequests(steps, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Batch limit must be between 1 and 20");
  if (!Array.isArray(steps) || !steps.length) throw new Error("Missing batch requests");
  const batches = [];
  const seen = new Set();
  let naming = false;
  for (const step of steps) {
    if (typeof step.id !== "string" || !step.id || seen.has(step.id))
      throw new Error("Missing or duplicate request id");
    if (typeof step.group !== "string" || !step.group.trim())
      throw new Error("Missing related request group");
    if (!["structure", "names"].includes(step.phase) || (naming && step.phase === "structure"))
      throw new Error("Requests must keep structure before the naming phase");
    if (typeof step.prompt !== "string" || !step.prompt.trim())
      throw new Error("Missing request prompt");
    for (const dependency of step.dependsOn ?? [])
      if (!seen.has(dependency)) throw new Error("Missing or reordered request dependency");
    seen.add(step.id);
    naming ||= step.phase === "names";
    let batch = batches.at(-1);
    if (
      !batch ||
      batch.phase !== step.phase ||
      batch.group !== step.group ||
      batch.requests.length === limit
    ) {
      batch = {
        id: `batch-${String(batches.length + 1).padStart(3, "0")}`,
        phase: step.phase,
        group: step.group,
        requests: [],
      };
      batches.push(batch);
    }
    batch.requests.push(step);
  }
  return batches;
}

/** Deliver short requests sequentially, but grade only the completed batch boundary.
 * The caller verifies the initial workspace. The existing chain owns timeouts and
 * configured repair policy. Repairs edit the retained batch state, never replay
 * successful moves. Reports distinguish edited requests from accepted batches and
 * retain per-delivery source identities. Trusted callbacks still own isolation.
 */
export async function runBatchedRequestChain(
  steps,
  { execute, grade, identity, save = async () => {}, batchSize = 20, ...options },
) {
  const batches = batchRequests(steps, batchSize);
  const requestStates = steps.map((step) => ({ id: step.id, status: "unattempted" }));
  const indices = new Map(steps.map((step, index) => [step.id, index]));
  const deliveries = [];
  let latest;
  const snapshot = (report) => {
    const accepted = new Set(
      batches
        .slice(0, report.passedPrefix)
        .flatMap((batch) => batch.requests.map((step) => step.id)),
    );
    return {
      version: "renderer-batched-request-chain-v1",
      status: report.status,
      passedBatches: report.passedPrefix,
      passedRequests: accepted.size,
      requests: requestStates.map((item) => ({
        ...item,
        status: accepted.has(item.id) ? "pass" : item.status,
      })),
      deliveries,
      batchReport: report,
    };
  };
  const deliver = async (prompt, index, batchIndex, attempt, repair, signal) => {
    signal.throwIfAborted();
    const record = {
      id: steps[index].id,
      index,
      batchIndex,
      attempt,
      repair,
      prompt,
      status: "running",
      before: await identity(),
    };
    deliveries.push(record);
    if (!repair) requestStates[index].status = "editing";
    await save(snapshot(latest));
    const started = performance.now();
    try {
      record.execution = await execute({ prompt, index, batchIndex, attempt, repair, signal });
      signal.throwIfAborted();
      record.status = "edited";
      if (!repair) requestStates[index].status = "edited";
    } catch (error) {
      record.status = "failed";
      throw error;
    } finally {
      record.executeMs = performance.now() - started;
      record.after = await identity();
      await save(snapshot(latest));
    }
  };
  const report = await runRequestChain(
    batches.map((batch) => ({
      id: batch.id,
      prompt: `Repair the current workspace for ${batch.id}. Satisfy all ${batch.requests.length} requests already delivered in this batch. Do not undo earlier batches or replay completed moves.`,
    })),
    {
      ...options,
      identity,
      save: async (report) => {
        latest = report;
        await save(snapshot(report));
      },
      execute: async ({ prompt, index, attempt, signal }) => {
        const batch = batches[index];
        if (attempt === 1) {
          for (const step of batch.requests)
            await deliver(step.prompt, indices.get(step.id), index, attempt, false, signal);
        } else {
          await deliver(
            prompt,
            indices.get(batch.requests.at(-1).id),
            index,
            attempt,
            true,
            signal,
          );
        }
        return {
          requestsDelivered: attempt === 1 ? batch.requests.length : 0,
          repair: attempt > 1,
        };
      },
      grade: ({ index, attempt, signal }) =>
        grade({ index, batch: batches[index], attempt, signal }),
    },
  );
  return snapshot(report);
}
