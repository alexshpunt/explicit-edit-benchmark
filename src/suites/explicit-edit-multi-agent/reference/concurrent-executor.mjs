import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFullExecutor } from "./full-executor.mjs";
import { referenceChannel } from "./concurrent-channel.mjs";
import { sharedReferencePlanner } from "./concurrent-planners.mjs";

/** Stage only current-task reference editing code and its compiler dependencies.
 * The shared service has exactly this same mount; no gates, prepared plans,
 * contracts, future assignments or controller directories are added.
 */
export async function prepareConcurrentExecutor(directory) {
  await prepareFullExecutor(directory);
  await copyFile(
    fileURLToPath(new URL("concurrent-worker.mjs", import.meta.url)),
    path.join(directory, "reference/full-worker.mjs"),
  );
  for (const name of [
    "coherent-edit.mjs",
    "concurrent-commit.mjs",
    "current-naming-worker.mjs",
    "current-naming-service.mjs",
  ])
    await copyFile(
      fileURLToPath(new URL(name, import.meta.url)),
      path.join(directory, "reference", name),
    );
}

/** Keep an isolated persistent process and history identity per reference agent.
 * Already dispatched naming work shares one isolated compiler service. Only its
 * planning resource is serialized; measured agents and readiness are unchanged.
 * close/abort await namespace teardown before settling, including compiler children.
 */
export function concurrentExecutor(workspace, tools, { signal } = {}) {
  signal?.throwIfAborted();
  const service = sharedReferencePlanner(workspace, tools);
  const executor = referenceChannel(workspace, tools, "full-worker.mjs", {
    naming: (task) => service.execute(task),
  });
  let busy = false,
    closure;
  const close = () => {
    if (!closure) {
      signal?.removeEventListener("abort", abort);
      closure = Promise.all([executor.close(), busy ? service.close() : Promise.resolve()]).then(
        () => service.release(),
      );
    }
    return closure;
  };
  const abort = () => {
    void close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    async execute(task) {
      if (closure || busy) throw Error("Reference participant closed or concurrent delivery");
      signal?.throwIfAborted();
      busy = true;
      try {
        return await executor.deliver(task);
      } catch (error) {
        if (closure) await closure;
        throw error;
      } finally {
        busy = false;
      }
    },
    close,
  };
}
