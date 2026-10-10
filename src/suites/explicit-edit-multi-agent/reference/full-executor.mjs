import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Stage only editing code for the isolated worker. Reference sources and planning
 * records are not part of this allowlist and cannot be read through the executor mount.
 */
export async function prepareFullExecutor(directory) {
  await mkdir(directory);
  for (const name of [
    "reference/full-worker.mjs",
    "reference/full-structure-edit.mjs",
    "reference/implementation-edit.mjs",
    "cpp/cpp-structure.mjs",
    "cpp/cpp-tokens.mjs",
    "cpp/cpp-offsets.mjs",
    "reference/scripted-worker.mjs",
    "generation/generator.mjs",
    "generation/origin-markers.mjs",
    "cpp/scoped-names.mjs",
    "cpp/joined-project.mjs",
    "generation/semantic-names.mjs",
    "cpp/clangd-renames.mjs",
    "cpp/compiler-ast.mjs",
    "generation/name-vocabulary.mjs",
  ]) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await copyFile(
      fileURLToPath(new URL("../" + name, import.meta.url)),
      path.join(directory, name),
    );
  }
}

/** Start one isolated current-workspace executor per batch. Deliver only the current
 * public request. Closing or aborting kills the namespace and its compiler children.
 */
export function fullExecutor(workspace, executor, { signal } = {}) {
  const child = spawn(
    "/usr/bin/bwrap",
    [
      "--unshare-all",
      "--new-session",
      "--die-with-parent",
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/etc/ld.so.cache",
      "/etc/ld.so.cache",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      path.resolve(executor),
      "/executor",
      "--bind",
      path.resolve(workspace),
      "/workspace",
      "--chdir",
      "/workspace",
      process.execPath,
      "/executor/reference/full-worker.mjs",
      "/workspace",
    ],
    { env: {}, signal },
  );
  let pending,
    stderr = "",
    closed = false;
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!pending) return;
    const receipt = pending;
    pending = null;
    try {
      const result = JSON.parse(line);
      if (result.status !== "edited") throw Error(result.error ?? "Isolated edit failed");
      receipt.resolve(result);
    } catch (error) {
      receipt.reject(error);
    }
  });
  const fail = (error) => {
    closed = true;
    pending?.reject(error);
    pending = null;
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(stderr || `Isolated worker exited ${code}`)));
  return {
    deliver(request) {
      if (closed || pending) throw Error("Executor closed or concurrent delivery");
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        child.stdin.write(JSON.stringify(request) + "\n");
      });
    },
    close() {
      child.kill("SIGKILL");
      lines.close();
    },
  };
}
