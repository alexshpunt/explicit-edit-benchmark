import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { treeIdentity } from "../generation/generator.mjs";
import { commitSnapshot, readSharedSnapshot } from "./concurrent-commit.mjs";
import { planCurrentNames, withReferencePlanner } from "./concurrent-planners.mjs";
import { applyCoherentStructure } from "./coherent-edit.mjs";

// Persistent, isolated reference editor. Receives only the current public task.
// No contract, expected source, future task or host path is mounted here.
async function worker(workspace) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const lifetime = randomUUID();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  await mkdir("/tmp/current-analysis");
  let delivered = 0;
  for await (const line of input) {
    let conflicts = 0,
      attempts = 0;
    try {
      const task = JSON.parse(line);
      if (!task.operations?.length) throw Error("Missing current task targets");
      const names = task.operations.every((op) => op.phase === "names");
      if (!names && task.operations.some((op) => op.phase === "names"))
        throw Error("Mixed structural and naming reference task");
      const execute = async () => {
        for (;;) {
          controller.signal.throwIfAborted();
          attempts++;
          const before = await readSharedSnapshot(workspace, { signal: controller.signal });
          const after = names
            ? await planCurrentNames(before, task, controller.signal)
            : task.operations.reduce(applyCoherentStructure, before);
          if (await commitSnapshot(workspace, before, after, { signal: controller.signal })) {
            return {
              status: "edited",
              id: task.id,
              lifetime,
              delivered: ++delivered,
              attempts,
              conflicts,
              before: treeIdentity(before),
              committed: treeIdentity(after),
              pid: process.pid,
            };
          }
          conflicts++;
        }
      };
      const receipt = names
        ? await withReferencePlanner(workspace, controller.signal, execute)
        : await execute();
      // Settled means publication and owned resource cleanup have both finished.
      process.stdout.write(JSON.stringify(receipt) + "\n");
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          status: "fail",
          id: null,
          error: error.message,
          conflicts,
          attempts,
          lifetime,
        }) + "\n",
      );
      process.exitCode = 1;
      break;
    }
  }
}
worker(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
