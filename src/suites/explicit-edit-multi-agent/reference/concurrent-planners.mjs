import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
/** Maximum overlapping compiler lifetimes in the model-free reference editor. */
export const REFERENCE_PLANNER_SLOTS = 2;

/** Bound reference compiler memory, not the benchmark team or live tools.
 * Two compiler jobs may overlap. Persistent agents keep separate identities;
 * this resource pool neither changes the task DAG nor grants source ownership.
 * A fresh child releases its full-project AST after each planning attempt.
 */
export async function withReferencePlanner(workspace, signal, action) {
  let owned;
  try {
    while (!owned) {
      signal?.throwIfAborted();
      for (let slot = 0; slot < REFERENCE_PLANNER_SLOTS; slot++) {
        const directory = path.join(workspace, `.renderer-planner-${slot}`);
        try {
          await mkdir(directory);
          owned = directory;
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      if (!owned) await delay(10, undefined, { signal });
    }
    signal?.throwIfAborted();
    return await action();
  } finally {
    if (owned) await rm(owned, { recursive: true });
  }
}

/** Compute only current public naming operations in a disposable compiler process. */
export function planCurrentNames(before, task, signal) {
  signal?.throwIfAborted();
  const child = spawn(
    process.execPath,
    [new URL("./concurrent-plan.mjs", import.meta.url).pathname],
    {
      signal,
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.stdin.on("error", () => {});
  return new Promise((resolve, reject) => {
    let failure;
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      if (failure) return reject(failure);
      if (code !== 0) return reject(Error(stderr || `Reference planner exited ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ before, task }));
  });
}
