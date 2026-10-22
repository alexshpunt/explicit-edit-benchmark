import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { treeIdentity } from "../generation/generator.mjs";
import { currentNamingPlanner } from "./current-naming-service.mjs";
import { commitSnapshot, readSharedSnapshot } from "./concurrent-commit.mjs";

// One isolated shared planning cache. Input contains only a worker's already
// dispatched current public task, never a preparation batch or expected tree.
async function worker(workspace) {
  await mkdir("/tmp/current-analysis");
  const planner = currentNamingPlanner("/tmp/current-analysis");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      const task = JSON.parse(line);
      let attempts = 0,
        conflicts = 0;
      try {
        for (;;) {
          attempts++;
          const before = await readSharedSnapshot(workspace);
          const planned = await planner.plan(before, task, () => readSharedSnapshot(workspace));
          if (!planned) {
            conflicts++;
            continue;
          }
          const { after, statistics } = planned;
          if (await commitSnapshot(workspace, before, after)) {
            planner.acknowledge(before, after);
            process.stdout.write(
              JSON.stringify({
                status: "edited",
                id: task.id,
                attempts,
                conflicts,
                before: treeIdentity(before),
                committed: treeIdentity(after),
                plannerPid: process.pid,
                planner: statistics,
              }) + "\n",
            );
            break;
          }
          conflicts++;
        }
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            status: "fail",
            id: task.id,
            error: error.message,
            attempts,
            conflicts,
          }) + "\n",
        );
      }
    }
  } finally {
    planner.close();
  }
}
worker(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
