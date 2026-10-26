import { createHash, randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { treeIdentity } from "../generation/generator.mjs";
import { readSharedSource } from "./concurrent-commit.mjs";
import { applyCurrentStructure } from "./coherent-edit.mjs";
import { currentNamingPlanner } from "./current-naming-service.mjs";
import { editCurrentProblems } from "./problem-edit.mjs";
import { projectEdits, publishEdits } from "./ordinary-edit.mjs";

const unpack = (bytes) => JSON.parse(inflateRawSync(bytes).toString("utf8"));
const pack = ({ before, after, statistics }) => {
  const changed = Object.keys(after).filter((file) => before[file] !== after[file]);
  return deflateRawSync(
    Buffer.from(
      JSON.stringify({
        before: Object.fromEntries(
          changed.filter((file) => before[file] !== undefined).map((file) => [file, before[file]]),
        ),
        after: Object.fromEntries(changed.map((file) => [file, after[file]])),
        statistics,
      }),
    ),
  );
};

// One private compiler, edit history and planning buffer per participant. Only
// the current delivered batch enters the buffer; it is not a shared transaction.
async function worker(workspace) {
  if (typeof globalThis.gc !== "function")
    throw Error("Independent reference editor requires --expose-gc");
  const lifetime = process.env.REFERENCE_EXECUTOR_ID ?? randomUUID();
  const analysis = await mkdtemp(path.join(tmpdir(), "current-analysis-"));
  const planner = currentNamingPlanner(analysis, { maxViews: 1 });
  const historyDirectory = process.argv[3] ?? path.join(analysis, "history");
  await mkdir(historyDirectory, { recursive: true });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let delivered = 0;
  const cleanupTask = (task) =>
    task.operations.every((operation) =>
      ["remove-generated-declaration", "remove-declaration"].includes(operation.action),
    );
  const repairTask = (task) => task.operations.every((operation) => operation.phase === "repair");
  const namingTask = (task) => task.operations.every((operation) => operation.phase === "names");
  const historyFile = (task) =>
    !cleanupTask(task) &&
    !repairTask(task) &&
    path.join(historyDirectory, createHash("sha256").update(task.id).digest("hex"));
  const trace = () => {
    const events = [];
    const event = (phase, file) =>
      events.push({ phase, file, at: Number(process.hrtime.bigint()) / 1e6 });
    event("execute-start");
    return { events, event };
  };
  async function structure(before, operations, id) {
    if (operations.every((operation) => operation.phase === "repair"))
      return editCurrentProblems(before, operations, planner, id);
    let after = before,
      statistics;
    for (const operation of operations) {
      const implementation = await planner.implementation(after, operation);
      after = applyCurrentStructure(after, operation, { implementation });
      if (implementation) statistics = implementation.statistics;
    }
    return { after, statistics };
  }
  async function prepare(task, record, projected, ignoreSaved = false) {
    const { event } = record;
    if (!task.operations?.length) throw Error("Missing current task targets");
    const naming = namingTask(task);
    if (
      !naming &&
      !repairTask(task) &&
      task.operations.some((operation) => ["names", "repair"].includes(operation.phase))
    )
      throw Error("Mixed structural and naming reference task");
    const saved = historyFile(task);
    if (saved && !ignoreSaved) {
      try {
        return { ...unpack(readFileSync(saved)), fresh: false };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    for (;;) {
      event("snapshot-start");
      const before = projected ?? (await readSharedSource(workspace));
      event("snapshot-end");
      event("plan-start");
      let after, statistics;
      try {
        if (naming) {
          const result = await planner.plan(
            before,
            task,
            projected ? undefined : () => readSharedSource(workspace),
          );
          if (!result) {
            event("plan-end");
            continue;
          }
          ({ after, statistics } = result);
          // This acknowledges this actor's private buffer, not acceptance or
          // publication. Unknown live bytes still invalidate its compiler view.
          planner.acknowledge(before, after);
        } else ({ after, statistics } = await structure(before, task.operations, task.id));
      } catch (error) {
        event("plan-end");
        if (!projected && treeIdentity(await readSharedSource(workspace)) !== treeIdentity(before))
          continue;
        throw error;
      }
      event("plan-end");
      const result = { before, after, statistics, fresh: true };
      if (saved && Object.keys(after).some((file) => before[file] !== after[file]))
        writeFileSync(saved, pack(result));
      return result;
    }
  }
  process.stdout.write(JSON.stringify({ type: "ready", lifetime }) + "\n");
  try {
    for await (const line of input) {
      const request = JSON.parse(line);
      const batch = Array.isArray(request) ? request : [request];
      const receipts = [];
      const prepared = [];
      const directory = await mkdtemp(path.join(analysis, "delivery-"));
      let task = batch[0],
        record;
      try {
        if (!batch.length || new Set(batch.map((item) => item.id)).size !== batch.length)
          throw Error("Invalid current reference batch");
        // Plan the admitted batch privately. A genuine current-source compiler
        // diagnostic blocks new plans, but must not prevent this actor's already
        // retained corrections in the SAME delivery from being published.
        for (;;) {
          const initial = await readSharedSource(workspace);
          let projected = initial;
          prepared.length = 0;
          try {
            for (task of batch) {
              globalThis.gc();
              record = trace();
              let result;
              try {
                result = await prepare(task, record, projected);
              } catch (error) {
                if (!repairTask(task) || (!error.repairConflict && !error.compilerSourceFailure))
                  throw error;
                prepared.push({
                  record,
                  sourceFailure: {
                    task: task.id,
                    message: error.message,
                    exitCode: error.compilerExitCode,
                    signal: error.compilerSignal,
                  },
                });
                // Another fresh problem in this delivery may repair the source
                // that prevented this compiler-based edit. Keep planning it.
                continue;
              }
              if (result.fresh) projected = result.after;
              else {
                try {
                  projected = projectEdits(result.before, result.after, projected);
                } catch (error) {
                  if (error.message !== "Retained edit conflicts with private planning buffer")
                    throw error;
                  // A peer may already have moved the selected source. Re-read
                  // this public request against our current private buffer.
                  result = await prepare(task, record, projected, true);
                  projected = result.after;
                }
              }
              const file = path.join(directory, String(prepared.length));
              writeFileSync(file, pack(result));
              prepared.push({ file, record, fresh: result.fresh });
            }
            break;
          } catch (error) {
            if (treeIdentity(await readSharedSource(workspace)) !== treeIdentity(initial)) continue;
            // Shared source may be invalid between turns, including this
            // executor's first turn. Retain the compiler diagnostic as an editing
            // conflict; only the drained barrier decides acceptance.
            if (!error.compilerSourceFailure) throw error;
            const failedTask = task.id;
            const failedRecord = record;
            for (let index = prepared.length; index < batch.length; index++) {
              task = batch[index];
              record = task.id === failedTask ? failedRecord : trace();
              const sourceFailure = {
                task: failedTask,
                message: error.message,
                exitCode: error.compilerExitCode,
                signal: error.compilerSignal,
              };
              const saved = historyFile(task);
              let retained;
              if (saved) {
                try {
                  retained = readFileSync(saved);
                } catch (readError) {
                  if (readError.code !== "ENOENT") throw readError;
                }
              }
              if (retained) {
                const file = path.join(directory, String(index));
                writeFileSync(file, retained);
                prepared.push({ file, record, fresh: false });
              } else prepared.push({ record, sourceFailure });
            }
            break;
          }
        }
        for (const [index, current] of batch.entries()) {
          task = current;
          globalThis.gc();
          record = prepared[index].record;
          const { event, events } = record;
          if (prepared[index].sourceFailure) {
            event("execute-end");
            receipts.push({
              status: "conflict",
              id: task.id,
              lifetime,
              delivered: ++delivered,
              pid: process.pid,
              attempts: 0,
              conflicts: 1,
              written: [],
              sourceFailure: prepared[index].sourceFailure,
              memory: process.memoryUsage(),
              events,
            });
            continue;
          }
          const plan = {
            ...unpack(readFileSync(prepared[index].file)),
            fresh: prepared[index].fresh,
          };
          let { before, after } = plan;
          const cleanup = cleanupTask(task);
          if (!plan.fresh) await delay(20 + Math.random() * 1000);
          const published = new Set();
          let result,
            sourceFailure,
            statistics = plan.statistics,
            attempts = 0;
          for (let retry = 0; retry < 8; retry++) {
            if (cleanup) {
              event("snapshot-start");
              before = await readSharedSource(workspace);
              event("snapshot-end");
              event("plan-start");
              try {
                ({ after } = await structure(before, task.operations, task.id));
              } catch (error) {
                if (!repairTask(task) || (!error.repairConflict && !error.compilerSourceFailure))
                  throw error;
                result = {
                  written: [],
                  conflicts: [{ reason: "current-repair-source", message: error.message }],
                };
                event("plan-end");
                break;
              }
              event("plan-end");
            }
            attempts++;
            event("publish-start");
            result = publishEdits(workspace, before, after, { onEvent: event });
            event("publish-end");
            for (const file of result.written) published.add(file);
            if (!result.conflicts.length || retry === 7) break;
            await delay(5 + Math.random() * 30);
            if (!cleanup) {
              // The original delivery is still active. A stale textual plan
              // cannot resolve a structural peer change by being replayed.
              // Re-select only this public request against the actual source.
              try {
                const current = await prepare(task, record, undefined, true);
                ({ before, after, statistics } = current);
              } catch (error) {
                if (!error.compilerSourceFailure && !error.repairConflict) throw error;
                sourceFailure = {
                  task: task.id,
                  message: error.message,
                  exitCode: error.compilerExitCode,
                  signal: error.compilerSignal,
                };
                result.conflicts = [{ reason: "current-source", message: error.message }];
                break;
              }
            }
          }
          event("execute-end");
          receipts.push({
            status: result.conflicts.length ? "conflict" : "edited",
            id: task.id,
            lifetime,
            delivered: ++delivered,
            pid: process.pid,
            before: treeIdentity(before),
            committed: treeIdentity(await readSharedSource(workspace)),
            attempts,
            conflicts: result.conflicts.length,
            written: [...published],
            ...(sourceFailure ? { sourceFailure } : {}),
            planner: statistics,
            memory: process.memoryUsage(),
            events,
          });
        }
        process.stdout.write(
          JSON.stringify(
            Array.isArray(request)
              ? {
                  status: receipts.some((receipt) => receipt.status === "conflict")
                    ? "conflict"
                    : "edited",
                  receipts,
                }
              : receipts[0],
          ) + "\n",
        );
      } catch (error) {
        if (record) record.event("execute-end");
        process.stdout.write(
          JSON.stringify({
            status: "fail",
            id: task?.id,
            error: error.message,
            memory: process.memoryUsage(),
            lifetime,
            events: record?.events,
          }) + "\n",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  } finally {
    planner.close();
    await rm(analysis, { recursive: true, force: true });
  }
}
worker(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
