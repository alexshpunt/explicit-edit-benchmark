import { batchRequests } from "../../../src/suites/explicit-edit-multi-agent/tasks/request-batches.mjs";
import { runRequestChain } from "../../../src/suites/explicit-edit-multi-agent/execution/request-chain.mjs";

export const GROUPED_PROMPT_BYTES = 98_304;

function listPrompt(requests) {
  return `Complete this ordered list in the current project. Apply every operation in order, retaining earlier work. The verifier runs only after the whole list. Do not add comments or change unrelated code.\n\n${requests.map((request, index) => `## Operation ${index + 1}: ${request.id}\n\n${request.prompt}`).join("\n\n")}`;
}

/** Combine consecutive related control batches into one model request per list.
 * Atomic instructions and their order stay unchanged. Endpoints match existing
 * trusted boundaries; their identities are never included in the agent prompt.
 * The UTF-8 budget bounds each complete prompt, not a truncated instruction.
 */
export function groupedRequests(requests, promptBytes = GROUPED_PROMPT_BYTES) {
  if (!Number.isSafeInteger(promptBytes) || promptBytes < 1)
    throw Error("Expected a positive prompt size budget");
  const lists = [];
  for (const batch of batchRequests(requests)) {
    if (Buffer.byteLength(listPrompt(batch.requests)) > promptBytes)
      throw Error(`Control batch ${batch.id} does not fit the prompt size budget`);
    let list = lists.at(-1);
    const combined = list ? [...list.requests, ...batch.requests] : batch.requests;
    if (
      !list ||
      list.phase !== batch.phase ||
      list.group !== batch.group ||
      Buffer.byteLength(listPrompt(combined)) > promptBytes
    ) {
      list = {
        id: `list-${String(lists.length + 1).padStart(3, "0")}`,
        phase: batch.phase,
        group: batch.group,
        requests: [],
        referenceBatchId: batch.id,
        prompt: "",
      };
      lists.push(list);
    }
    list.requests.push(...batch.requests);
    list.referenceBatchId = batch.id;
    list.prompt = listPrompt(list.requests);
  }
  return lists;
}

/** Deliver a whole ordered list in one call, with grading only at list endpoints.
 * Corrections contain only a coarse verdict and edit the retained current state.
 * Accepted atomic operations, list attempts and model deliveries are counted separately.
 */
export async function runGroupedRequestChain(
  lists,
  { execute, grade, identity, save = async () => {}, ...options },
) {
  const deliveries = [];
  let latest;
  const snapshot = (report) => {
    const passedRequests = lists
      .slice(0, report.passedPrefix)
      .reduce((sum, list) => sum + list.requests.length, 0);
    return {
      version: "renderer-grouped-request-chain-v1",
      status: report.status,
      passedBatches: report.passedPrefix,
      passedRequests,
      requests: lists.flatMap((list, index) =>
        list.requests.map((request) => ({
          id: request.id,
          listId: list.id,
          status: index < report.passedPrefix ? "pass" : report.steps[index].status,
        })),
      ),
      deliveries,
      batchReport: report,
    };
  };
  const report = await runRequestChain(
    lists.map((list) => ({
      id: list.id,
      prompt: `Repair the current workspace for ${list.id}. Satisfy all ${list.requests.length} operations already delivered in this list. Do not undo earlier lists or replay completed moves.`,
    })),
    {
      ...options,
      identity,
      save: async (report) => {
        latest = report;
        await save(snapshot(report));
      },
      execute: async ({ index, attempt, prompt, signal }) => {
        const list = lists[index],
          repair = attempt > 1;
        signal.throwIfAborted();
        const record = {
          id: list.id,
          batchIndex: index,
          attempt,
          repair,
          requestIds: repair ? [] : list.requests.map((request) => request.id),
          prompt: repair ? prompt : list.prompt,
          status: "running",
          before: await identity(),
        };
        deliveries.push(record);
        await save(snapshot(latest));
        const started = performance.now();
        try {
          signal.throwIfAborted();
          record.execution = await execute({
            list,
            prompt: record.prompt,
            index,
            batchIndex: index,
            attempt,
            repair,
            signal,
          });
          signal.throwIfAborted();
          record.status = "edited";
          return record.execution;
        } catch (error) {
          if (error.execution) record.execution = error.execution;
          record.status = "failed";
          throw error;
        } finally {
          record.executeMs = performance.now() - started;
          record.after = await identity();
          await save(snapshot(latest));
        }
      },
      grade: ({ index, attempt, signal }) =>
        grade({ index, batch: lists[index], list: lists[index], attempt, signal }),
    },
  );
  return snapshot(report);
}
