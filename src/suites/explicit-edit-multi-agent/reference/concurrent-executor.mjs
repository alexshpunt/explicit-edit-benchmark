import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFullExecutor } from "./full-executor.mjs";
import { referenceChannel } from "./concurrent-channel.mjs";
import { publicReferenceTask } from "./current-task.mjs";

/** Stage only public-task editing code, never grading contracts or answers. */
export async function prepareConcurrentExecutor(directory) {
  await prepareFullExecutor(directory);
  await copyFile(
    fileURLToPath(new URL("concurrent-worker.mjs", import.meta.url)),
    path.join(directory, "reference/full-worker.mjs"),
  );
  for (const name of [
    "coherent-edit.mjs",
    "concurrent-commit.mjs",
    "ordinary-edit.mjs",
    "current-naming-service.mjs",
  ])
    await copyFile(
      fileURLToPath(new URL(name, import.meta.url)),
      path.join(directory, "reference", name),
    );
}

/** Each participant owns its compiler and ordinary filesystem edits.
 * No planning queue or shared publication service coordinates participants.
 */
export function concurrentExecutor(workspace, tools, { signal } = {}) {
  const channel = referenceChannel(workspace, tools, "full-worker.mjs", { signal });
  return {
    ready: channel.ready,
    execute: (task) => channel.deliver(publicReferenceTask(task)),
    async executeBatch(tasks) {
      const result = await channel.deliver(tasks.map(publicReferenceTask));
      return result.receipts;
    },
    close: channel.close,
  };
}
