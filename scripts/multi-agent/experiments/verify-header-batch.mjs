import assert from "node:assert/strict";
import path from "node:path";
import { prepareScriptedExecutor } from "./scripted-runtime.mjs";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { headerRestoration } from "../../../src/suites/explicit-edit-multi-agent/tasks/restoration-extraction.mjs";
import {
  batchRequests,
  runBatchedRequestChain,
} from "../../../src/suites/explicit-edit-multi-agent/tasks/request-batches.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { buildAndRender } from "../../../src/suites/explicit-edit-multi-agent/generation/run.mjs";
import { runIsolatedRequest } from "./scripted-run.mjs";
import { GradeFailure } from "../../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import { withoutBlankLayoutLines } from "../../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";

/** Verify only the project-header batch from an existing verified generation.
 * The isolated worker receives one current prompt and workspace, not this planner
 * or private reference trees. Keep source evidence and two repeated scene outputs.
 * This bounded proof neither regenerates inputs nor proves full restoration.
 */
export async function verifyHeaderBatch(
  generation,
  output,
  { compiler = "clang++", log = console.log } = {},
) {
  generation = path.resolve(generation);
  output = path.resolve(output);
  const manifest = JSON.parse(await readFile(path.join(generation, "operations.json"), "utf8"));
  const generationReport = JSON.parse(await readFile(path.join(generation, "report.json"), "utf8"));
  if (generationReport.payload?.status !== "pass" || generationReport.final !== manifest.final)
    throw new Error("Expected a previously verified generation");
  const golden = generationReport.payload.pixels;
  assert.equal(golden?.length, 2, "Missing verified scene hashes");
  const plan = headerRestoration(await readTree(path.join(generation, "payload")), manifest);
  const batches = batchRequests(plan.requests);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const workspace = path.join(output, "workspace");
  const executor = path.join(output, "executor");
  await writeTree(workspace, plan.initial);
  await prepareScriptedExecutor(executor);
  await writeFile(
    path.join(output, "requests.json"),
    JSON.stringify(plan.requests, null, 2) + "\n",
  );
  const report = {
    version: "renderer-header-batch-proof-v1",
    status: "running",
    requests: plan.requests.length,
    batches: batches.length,
    pendingSources: plan.pendingSources,
    checks: [],
    chain: null,
  };
  const save = () =>
    writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const captured = new Set();
  const identity = async () => {
    const tree = await readTree(workspace);
    const value = treeIdentity(tree);
    if (!captured.has(value)) {
      await writeTree(path.join(output, "sources", value), tree);
      captured.add(value);
    }
    return value;
  };
  async function check(label, expected) {
    const tree = await readTree(workspace);
    const record = { label, status: "running", identity: await identity() };
    report.checks.push(record);
    await save();
    const scratch = path.join(output, label);
    try {
      try {
        if (expected) {
          assert.deepEqual(
            Object.keys(tree).sort(),
            Object.keys(expected).sort(),
            "Wrong extracted files",
          );
          for (const [file, source] of Object.entries(expected)) {
            if (file !== "main.cpp")
              assert.equal(
                withoutBlankLayoutLines(tree[file]),
                withoutBlankLayoutLines(source),
                `Changed extracted header: ${file}`,
              );
          }
        }
      } catch (error) {
        throw new GradeFailure("structure", error.message);
      }
      log(`BUILD ${label}: fresh workspace, both scenes repeated`);
      const pixels = await buildAndRender(workspace, scratch, tree, compiler);
      try {
        assert.deepEqual(pixels, golden, "Header batch changed rendered pixels");
      } catch (error) {
        throw new GradeFailure("behavior", error.message);
      }
      Object.assign(record, { status: "pass", pixels });
      await save();
      await rm(path.join(scratch, "renderer"));
      log(`PASS ${label}`);
      return { status: "pass", pixels };
    } catch (error) {
      Object.assign(record, { status: "fail", error: error.message });
      await save();
      if (error.cmd)
        throw new GradeFailure(
          error.cmd.startsWith(compiler) ? "build" : "behavior",
          error.message,
        );
      throw error;
    }
  }
  try {
    await mkdir(path.join(output, "sources"));
    await check("initial");
    report.chain = await runBatchedRequestChain(plan.requests, {
      identity,
      execute: ({ prompt, signal }) => runIsolatedRequest(workspace, executor, prompt, { signal }),
      grade: ({ batch, attempt }) =>
        check(
          `${batch.id}-attempt-${attempt}`,
          plan.stages.find((stage) => stage.id === batch.requests.at(-1).id).tree,
        ),
      save: async (chain) => {
        report.chain = chain;
        await save();
      },
      log,
    });
    report.status = report.chain.status;
    await save();
    if (report.status !== "pass") throw new Error(`Header batch stopped: ${report.status}`);
    assert.equal(report.checks.length, batches.length + 1, "Unexpected intermediate grading");
    log(
      `VERIFIED HEADER BATCH: ${plan.requests.length} isolated requests, ${batches.length} batches, ${report.checks.length} fresh build/render checks; implementation extraction remains pending`,
    );
    return report;
  } catch (error) {
    if (report.status === "running") report.status = "fail";
    report.error = error.message;
    await save();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error(
      "Usage: node scripts/multi-agent/experiments/verify-header-batch.mjs GENERATION NEW_OUTPUT",
    );
    process.exitCode = 1;
  } else
    verifyHeaderBatch(process.argv[2], process.argv[3]).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
