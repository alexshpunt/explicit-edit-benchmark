import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { treeIdentity } from "../generation/generator.mjs";
import { commitSnapshot, readSharedSnapshot } from "./concurrent-commit.mjs";
import { applyCoherentStructure } from "./coherent-edit.mjs";

// Persistent isolated participant. A naming RPC delegates only its current public
// task to the separately isolated shared compiler service. It cannot see the
// service's snapshot ledger, future tasks, grading contracts or prepared answers.
async function worker(workspace) {
  const lifetime = randomUUID();
  await mkdir("/tmp/current-analysis");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let delivered = 0,
    request = 0,
    pending,
    busy = false;
  const names = (task) =>
    new Promise((resolve, reject) => {
      const requestId = ++request;
      pending = { requestId, resolve, reject };
      process.stdout.write(JSON.stringify({ type: "name-request", requestId, task }) + "\n");
    });
  const execute = async (task) => {
    let conflicts = 0,
      attempts = 0;
    try {
      if (!task.operations?.length) throw Error("Missing current task targets");
      const naming = task.operations.every((operation) => operation.phase === "names");
      if (!naming && task.operations.some((operation) => operation.phase === "names"))
        throw Error("Mixed structural and naming reference task");
      let receipt;
      if (naming) receipt = await names(task);
      else
        for (;;) {
          attempts++;
          const before = await readSharedSnapshot(workspace);
          const after = task.operations.reduce(applyCoherentStructure, before);
          if (await commitSnapshot(workspace, before, after)) {
            receipt = {
              before: treeIdentity(before),
              committed: treeIdentity(after),
              attempts,
              conflicts,
            };
            break;
          }
          conflicts++;
        }
      process.stdout.write(
        JSON.stringify({
          ...receipt,
          status: "edited",
          id: task.id,
          lifetime,
          delivered: ++delivered,
          pid: process.pid,
        }) + "\n",
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          status: "fail",
          id: task.id,
          error: error.message,
          conflicts,
          attempts,
          lifetime,
        }) + "\n",
      );
    } finally {
      busy = false;
    }
  };
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "name-result") {
      if (!pending || pending.requestId !== message.requestId)
        throw Error("Unmatched reference naming response");
      const response = pending;
      pending = undefined;
      if (message.error) response.reject(Error(message.error));
      else response.resolve(message.receipt);
      return;
    }
    if (busy) throw Error("Concurrent reference participant delivery");
    busy = true;
    void execute(message);
  });
}
worker(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
