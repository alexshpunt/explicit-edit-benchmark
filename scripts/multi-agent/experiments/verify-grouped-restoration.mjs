import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTree,
  writeTree,
  treeIdentity,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  groupedRequests,
  runGroupedRequestChain,
  GROUPED_PROMPT_BYTES,
} from "./grouped-requests.mjs";
import {
  fullExecutor,
  prepareFullExecutor,
} from "../../../src/suites/explicit-edit-multi-agent/reference/full-executor.mjs";
import { assertFullEndpoint } from "../../../src/suites/explicit-edit-multi-agent/grading/full-grade.mjs";
import { buildAndRender } from "../../../src/suites/explicit-edit-multi-agent/generation/run.mjs";
import { GradeFailure } from "../../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import {
  overallDeadline,
  abortStatus,
} from "../../../src/suites/explicit-edit-multi-agent/execution/overall-deadline.mjs";

/** Reapply the complete grouped workload without models or saved-answer edits.
 * The executor receives only the current list's public operations. Trusted old
 * checkpoints are read only by the grader after each new complete list endpoint.
 * Every endpoint gets a fresh build and both exact scenes rendered twice.
 */
export async function verifyGroupedRestoration(
  proofPath,
  outputPath,
  { signal: externalSignal } = {},
) {
  const proof = path.resolve(proofPath),
    output = path.resolve(outputPath);
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  const audit = await json(path.join(proof, "audit.json"));
  assert.equal(audit.status, "pass");
  assert.equal((await json(path.join(proof, "report.json"))).status, "pass");
  const bytes = await readFile(path.join(proof, "requests.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), audit.requestsSha256);
  const requests = JSON.parse(bytes),
    lists = groupedRequests(requests);
  assert.equal(requests.length, 2930);
  assert.deepEqual(
    lists.flatMap((list) => list.requests.map((request) => request.id)),
    requests.map((request) => request.id),
  );
  await mkdir(output, { mode: 0o700 });
  const workspace = path.join(output, "workspace"),
    executorDirectory = path.join(output, "executor");
  const initial = await readTree(path.join(proof, "checks/initial/source"));
  assert.equal(treeIdentity(initial), audit.initial);
  await writeTree(workspace, initial);
  await prepareFullExecutor(executorDirectory);
  await writeFile(path.join(output, "requests.json"), bytes);
  await writeFile(path.join(output, "lists.json"), JSON.stringify(lists, null, 2) + "\n");
  const report = {
    version: "renderer-full-grouped-scripted-v1",
    profile: "grouped-hour",
    status: "running",
    initial: audit.initial,
    requestsSha256: audit.requestsSha256,
    requests: requests.length,
    lists: lists.length,
    promptBytes: GROUPED_PROMPT_BYTES,
    policy: { trialTimeoutMs: 3600000, batchAttemptTimeoutMs: 1800000 },
    checks: [],
    chain: null,
  };
  const save = () =>
    writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const started = performance.now(),
    deadline = overallDeadline(externalSignal);
  const signal = deadline.signal;
  let executor;
  async function check(label, expected, currentSignal) {
    currentSignal.throwIfAborted();
    const tree = await readTree(workspace),
      directory = path.join(output, "checks", label);
    await mkdir(directory, { recursive: true });
    await writeTree(path.join(directory, "source"), tree);
    const item = { label, identity: treeIdentity(tree), status: "running" };
    report.checks.push(item);
    await save();
    try {
      assertFullEndpoint(tree, expected);
      console.log(`BUILD ${label}: fresh project, two scenes, repeated render`);
      const pixels = await buildAndRender(
        workspace,
        path.join(directory, "build"),
        tree,
        "clang++",
        { signal: currentSignal },
      );
      assert.deepEqual(pixels, audit.pixels);
      currentSignal.throwIfAborted();
      Object.assign(item, { status: "pass", pixels });
      await rm(path.join(directory, "build/renderer"));
      console.log(`PASS ${label}`);
      return { status: "pass", pixels, identity: item.identity };
    } catch (error) {
      Object.assign(item, { status: "fail", error: error.message });
      throw new GradeFailure(error.cmd ? "build" : "structure", error.message);
    } finally {
      await save();
    }
  }
  try {
    await check("initial", initial, signal);
    report.chain = await runGroupedRequestChain(lists, {
      signal,
      oracleRecoveries: 3,
      feedbackMode: "coarse",
      trialTimeoutMs: null,
      attemptTimeoutMs: 1800000,
      identity: async () => treeIdentity(await readTree(workspace)),
      execute: async ({ list, repair, signal: currentSignal }) => {
        if (repair)
          throw Error("Scripted verification cannot repair a failed list; state retained");
        executor = fullExecutor(workspace, executorDirectory, { signal: currentSignal });
        try {
          for (const request of list.requests) {
            const receipt = await executor.deliver(request);
            await writeFile(path.join(output, "edits.jsonl"), JSON.stringify(receipt) + "\n", {
              flag: "a",
            });
          }
          return { operationsApplied: list.requests.length };
        } finally {
          executor.close();
          executor = null;
        }
      },
      grade: async ({ list, attempt, signal: currentSignal }) =>
        check(
          `${list.id}-attempt-${attempt}`,
          await readTree(
            path.join(proof, "checks", `${list.referenceBatchId}-attempt-1`, "source"),
          ),
          currentSignal,
        ),
      save: async (chain) => {
        report.chain = chain;
        await save();
      },
      log: console.log,
    });
    report.status = report.chain.status;
    if (report.status === "pass") {
      assert.equal(report.chain.passedRequests, 2930);
      assert.equal(report.checks.length, lists.length + 1);
      assertFullEndpoint(
        await readTree(workspace),
        await readTree(path.join(proof, "checks/batch-155-attempt-1/source")),
      );
    }
  } catch (error) {
    report.status = signal.aborted ? abortStatus(signal) : "fail";
    report.error = error.message;
  } finally {
    executor?.close();
    deadline.close();
    report.elapsedMs = performance.now() - started;
    report.final = treeIdentity(await readTree(workspace));
    await save();
  }
  console.log(
    `${report.status.toUpperCase()}: ${report.chain?.passedRequests ?? 0}/${requests.length} operations, ${report.chain?.passedBatches ?? 0}/${lists.length} lists; independent isolated edits, exact repeated renders`,
  );
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyGroupedRestoration(process.argv[2], process.argv[3]);
  process.exitCode = report.status === "pass" ? 0 : 1;
}
