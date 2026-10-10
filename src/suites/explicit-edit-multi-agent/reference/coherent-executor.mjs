import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFullExecutor } from "./full-executor.mjs";

/** Stage the current-task editor in its own allowlisted runtime. Reuse the pinned
 * namespace launcher, but never stage preparation, contracts or future task data.
 */
export async function prepareCoherentExecutor(directory) {
  await prepareFullExecutor(directory);
  await copyFile(
    fileURLToPath(new URL("coherent-worker.mjs", import.meta.url)),
    path.join(directory, "reference/full-worker.mjs"),
  );
  await copyFile(
    fileURLToPath(new URL("coherent-edit.mjs", import.meta.url)),
    path.join(directory, "reference/coherent-edit.mjs"),
  );
}
