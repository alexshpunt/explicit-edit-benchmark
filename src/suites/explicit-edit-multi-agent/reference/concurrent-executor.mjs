import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFullExecutor, fullExecutor } from "./full-executor.mjs";

/** Stage only the reference editor and its parser/compiler helpers. */
export async function prepareConcurrentExecutor(directory) {
  await prepareFullExecutor(directory);
  await copyFile(
    fileURLToPath(new URL("coherent-edit.mjs", import.meta.url)),
    path.join(directory, "reference/coherent-edit.mjs"),
  );
  await copyFile(
    fileURLToPath(new URL("concurrent-worker.mjs", import.meta.url)),
    path.join(directory, "reference/full-worker.mjs"),
  );
  await copyFile(
    fileURLToPath(new URL("concurrent-commit.mjs", import.meta.url)),
    path.join(directory, "reference/concurrent-commit.mjs"),
  );
  for (const name of ["concurrent-plan.mjs", "concurrent-planners.mjs"])
    await copyFile(
      fileURLToPath(new URL(name, import.meta.url)),
      path.join(directory, "reference", name),
    );
}

/** Keep one reference process per agent across rounds. Only current public tasks
 * are delivered, and every process binds the same writable workspace directory.
 */
export function concurrentExecutor(workspace, tools, { signal } = {}) {
  const executor = fullExecutor(workspace, tools, { signal });
  return {
    execute: (task) => executor.deliver(task),
    close: () => executor.close(),
  };
}
