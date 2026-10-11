import { createInterface } from "node:readline";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { readTree, treeIdentity } from "../generation/generator.mjs";
import { applyCoherentStructure } from "./coherent-edit.mjs";
import { scopedNamingSession, applyScopedNamePlan } from "../cpp/scoped-names.mjs";

// Only a delivered task enters this process. Each operation writes its edits now,
// so a later rejected owner cannot erase earlier completed work in the same task.
async function worker(workspace) {
  await mkdir("/tmp/current-analysis");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let session;
    try {
      const task = JSON.parse(line);
      if (!Array.isArray(task.operations) || !task.operations.length)
        throw Error("Missing current task targets");
      const applied = [];
      let edited = 0;
      for (const request of task.operations) {
        const tree = await readTree(workspace);
        let next;
        if (request.phase === "names") {
          session ??= await scopedNamingSession(tree, "/tmp/current-analysis", {
            file: request.category === "helpers" ? request.file : undefined,
          });
          const plan = await session.plan(request);
          next = applyScopedNamePlan(tree, plan, applied);
          applied.push(plan);
        } else next = applyCoherentStructure(tree, request);
        for (const file of Object.keys(next))
          if (
            !/^[A-Za-z0-9_./-]+\.(?:cpp|h)$/.test(file) ||
            file.startsWith("/") ||
            file.split("/").includes("..")
          )
            throw Error("Unsafe current source path");
        for (const [file, source] of Object.entries(next)) {
          if (source === tree[file]) continue;
          await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
          await writeFile(path.join(workspace, file), source, { flag: file in tree ? "w" : "wx" });
        }
        for (const file of Object.keys(tree))
          if (!(file in next)) await unlink(path.join(workspace, file));
        edited++;
      }
      process.stdout.write(
        JSON.stringify({
          status: "edited",
          id: task.id,
          targetRows: edited,
          identity: treeIdentity(await readTree(workspace)),
        }) + "\n",
      );
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: "fail", error: error.message }) + "\n");
      process.exitCode = 1;
      break;
    } finally {
      session?.close();
    }
  }
}
worker(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
