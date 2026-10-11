import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Stage only the slice editor and lexer, keeping their source-relative layout.
 * An explicit alternate executor supplies the same two paths, never an answer tree.
 */
export async function prepareScriptedExecutor(directory, alternate) {
  await mkdir(directory);
  for (const name of ["reference/scripted-worker.mjs", "cpp/cpp-tokens.mjs"]) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await copyFile(
      alternate
        ? path.join(alternate, name)
        : fileURLToPath(
            new URL("../../../src/suites/explicit-edit-multi-agent/" + name, import.meta.url),
          ),
      path.join(directory, name),
    );
  }
}
