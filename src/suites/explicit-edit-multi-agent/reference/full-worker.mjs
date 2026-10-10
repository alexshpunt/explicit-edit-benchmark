import { createInterface } from "node:readline";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { readTree, treeIdentity } from "../generation/generator.mjs";
import { applyFullStructure } from "./full-structure-edit.mjs";
import { scopedNamingSession, applyScopedNamePlan } from "../cpp/scoped-names.mjs";

/** Execute only delivered public requests in one isolated evolving workspace.
 * The compiler cache contains the current batch start, not future requests or reference records.
 */
async function worker(workspace) {
  let session;
  const applied = [];
  await mkdir("/tmp/current-analysis");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      try {
        const request = JSON.parse(line);
        const tree = await readTree(workspace);
        let next;
        if (request.phase === "names") {
          session ??= await scopedNamingSession(tree, "/tmp/current-analysis", {
            file: request.category === "helpers" ? request.file : undefined,
          });
          const plan = await session.plan(request);
          next = applyScopedNamePlan(tree, plan, applied);
          applied.push(plan);
        } else next = applyFullStructure(tree, request);
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
        process.stdout.write(
          JSON.stringify({ status: "edited", id: request.id, identity: treeIdentity(next) }) + "\n",
        );
      } catch (error) {
        process.stdout.write(JSON.stringify({ status: "fail", error: error.message }) + "\n");
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    session?.close();
  }
}
worker(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
