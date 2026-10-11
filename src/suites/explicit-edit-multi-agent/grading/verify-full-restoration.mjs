import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readTree, writeTree, treeIdentity } from "../generation/generator.mjs";
import { prepareImplementation } from "../tasks/prepare-implementation.mjs";
import { fullRestoration } from "../tasks/full-restoration.mjs";
import { prepareNameOwners } from "../tasks/prepare-name-owners.mjs";
import { fullExecutor, prepareFullExecutor } from "../reference/full-executor.mjs";
import { batchRequests, runBatchedRequestChain } from "../tasks/request-batches.mjs";
import { referenceNameSteps } from "../generation/reference-route.mjs";
import { assertFullEndpoint } from "./full-grade.mjs";
import { buildAndRender } from "../generation/run.mjs";
import { GradeFailure } from "./failure.mjs";

/** Prove the complete public workload in an isolated evolving project, without models.
 * Each request is delivered alone, related batches contain at most twenty, and only
 * batch endpoints build/render. Retain edits, compiler failures and source checkpoints.
 */
export async function verifyFullRestoration(
  generation,
  output,
  { log = console.log, signal } = {},
) {
  generation = path.resolve(generation);
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const manifest = JSON.parse(await readFile(path.join(generation, "operations.json"), "utf8"));
  const generationReport = JSON.parse(await readFile(path.join(generation, "report.json"), "utf8"));
  if (generationReport.payload?.status !== "pass" || manifest.final !== generationReport.final)
    throw Error("Unverified generation");
  const initial = await readTree(path.join(generation, "payload"));
  const report = {
    version: "renderer-full-batch-e2e-v1",
    status: "preparing",
    initial: treeIdentity(initial),
    checks: [],
    chain: null,
  };
  const save = () =>
    writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await save();
  let executor;
  try {
    await prepareImplementation(generation, path.join(output, "preparation"));
    const implementation = JSON.parse(
      await readFile(path.join(output, "preparation/requests.json"), "utf8"),
    );
    const selectOwners = await prepareNameOwners(
      initial,
      manifest,
      path.join(output, "name-owners"),
    );
    const plan = fullRestoration(initial, manifest, implementation, { selectOwners });
    const batches = batchRequests(plan.requests);
    Object.assign(report, {
      status: "running",
      requests: plan.requests.length,
      batches: batches.length,
      structureRequests: plan.requests.filter((item) => item.phase === "structure").length,
      namingRequests: plan.requests.filter((item) => item.phase === "names").length,
    });
    await writeFile(
      path.join(output, "requests.json"),
      JSON.stringify(plan.requests, null, 2) + "\n",
    );
    const workspace = path.join(output, "workspace"),
      tools = path.join(output, "executor");
    await writeTree(workspace, initial);
    await prepareFullExecutor(tools);
    const identity = async () => treeIdentity(await readTree(workspace));
    const nameStates = referenceNameSteps(initial, manifest);
    let currentBatch = -1;
    async function check(label, expected) {
      const tree = await readTree(workspace);
      const item = { label, identity: treeIdentity(tree), status: "running" };
      report.checks.push(item);
      await save();
      const directory = path.join(output, "checks", label);
      await mkdir(directory, { recursive: true });
      await writeTree(path.join(directory, "source"), tree);
      try {
        if (expected) assertFullEndpoint(tree, expected);
        log(`BUILD ${label}: fresh project, two scenes, repeated render`);
        const pixels = await buildAndRender(
          workspace,
          path.join(directory, "build"),
          tree,
          "clang++",
        );
        assert.deepEqual(pixels, generationReport.payload.pixels, "Rendered pixels differ");
        Object.assign(item, { status: "pass", pixels });
        await save();
        await rm(path.join(directory, "build/renderer"));
        log(`PASS ${label}`);
        return { status: "pass", pixels };
      } catch (error) {
        Object.assign(item, { status: "fail", error: error.message });
        await save();
        throw new GradeFailure(error.cmd ? "build" : "structure", error.message);
      }
    }
    await check("initial");
    const journal = path.join(output, "edits.jsonl");
    report.chain = await runBatchedRequestChain(plan.requests, {
      signal,
      identity,
      attemptTimeoutMs: 1_800_000,
      trialTimeoutMs: 43_200_000,
      execute: async ({ index, batchIndex, repair, signal }) => {
        if (repair)
          throw Error("Scripted executor has no English repair strategy; failed state retained");
        if (currentBatch !== batchIndex) {
          executor?.close();
          executor = fullExecutor(workspace, tools, { signal });
          currentBatch = batchIndex;
        }
        const request = plan.requests[index];
        const before = await readTree(workspace);
        const receipt = await executor.deliver(request);
        const after = await readTree(workspace);
        const changed = Object.entries(after).filter(([file, source]) => before[file] !== source);
        await writeFile(
          journal,
          JSON.stringify({
            id: request.id,
            before: treeIdentity(before),
            after: receipt.identity,
            changed,
          }) + "\n",
          { flag: "a" },
        );
        log(`EDIT ${request.id}: isolated current request`);
        return receipt;
      },
      grade: async ({ batch, attempt }) => {
        executor?.close();
        executor = null;
        let expected;
        if (batch.phase === "names") {
          for (const request of batch.requests) {
            const step = nameStates.next().value;
            if (step?.target !== request.id) throw Error("Naming reference coverage differs");
            expected = step.tree;
          }
        } else if (batch.requests.at(-1).action === "cleanup-empty-namespaces")
          expected = plan.canonicalNamed;
        return check(`${batch.id}-attempt-${attempt}`, expected);
      },
      save: async (chain) => {
        report.chain = chain;
        await save();
      },
      log,
    });
    if (report.chain.status !== "pass") throw Error(`Full chain stopped: ${report.chain.status}`);
    assert.equal(report.checks.length, batches.length + 1, "Unexpected intermediate grading");
    assertFullEndpoint(await readTree(workspace), plan.canonicalFinal);
    assert.equal(nameStates.next().done, true, "Incomplete naming coverage");
    report.status = "pass";
    report.final = await identity();
    await save();
    log(
      `VERIFIED FULL E2E: ${plan.requests.length} isolated requests, ${batches.length} related batches, ${report.checks.length} fresh build/render checks; structure and names complete`,
    );
    return report;
  } catch (error) {
    report.status = "fail";
    report.error = error.message;
    await save();
    throw error;
  } finally {
    executor?.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  verifyFullRestoration(process.argv[2], process.argv[3]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
