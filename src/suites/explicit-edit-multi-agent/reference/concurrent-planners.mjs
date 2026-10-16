import path from "node:path";
import { referenceChannel } from "./concurrent-channel.mjs";

/** One shared compiler-planning slot per reference workspace, not a live-agent cap. */
export const REFERENCE_PLANNER_SLOTS = 1;
const services = new Map();

/** Acquire a current-task-only isolated planning service for one shared project.
 * Requests queue only after public dispatch. No future work, grading state or
 * prepared plans enter this transport. The last participant closes the service;
 * cancellation of active work closes its namespace before participant settlement.
 */
export function sharedReferencePlanner(workspace, tools) {
  const key = JSON.stringify([path.resolve(workspace), path.resolve(tools)]);
  let entry = services.get(key);
  if (!entry) {
    entry = { references: 0, channel: undefined, queue: Promise.resolve(), closing: undefined };
    services.set(key, entry);
  }
  entry.references++;
  const close = () => {
    if (!entry.closing) {
      entry.closing = entry.channel?.close() ?? Promise.resolve();
      if (services.get(key) === entry) services.delete(key);
    }
    return entry.closing;
  };
  return {
    execute(task) {
      const deliver = async () => {
        if (entry.closing) throw Error("Shared reference planner closed");
        entry.channel ??= referenceChannel(workspace, tools, "current-naming-worker.mjs");
        return entry.channel.deliver(task);
      };
      const result = entry.queue.then(deliver);
      entry.queue = result.catch(() => {});
      return result;
    },
    close,
    release() {
      return --entry.references === 0 ? close() : Promise.resolve();
    },
  };
}
