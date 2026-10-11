import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareScriptedExecutor } from "./scripted-runtime.mjs";
import { fileURLToPath } from "node:url";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { resolveObligations } from "./atomic-slice.mjs";
import { inspectCandidate } from "./candidate-grader.mjs";
import { GradeFailure } from "../../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import { createSliceContract, assertCandidateObligations } from "./candidate-obligations.mjs";
import { runIsolatedRequest } from "./scripted-run.mjs";
import { runRequestChain } from "../../../src/suites/explicit-edit-multi-agent/execution/request-chain.mjs";
import { createEvidence } from "./chain-report.mjs";
import {
  startBaseline,
  finalizedUsage,
} from "../../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";

/** Run the accepted slice with trusted grading and one evolving workspace.
 * Without baseline configuration this uses the independent scripted executor.
 * With it, one real Pi process stays alive across every request and correction.
 */
export async function runSlice(
  initialSource,
  workloadPath,
  output,
  {
    signal,
    log = console.log,
    baseline,
    scriptedExecutor,
    experiment,
    attemptTimeoutMs,
    trialTimeoutMs,
  } = {},
) {
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const evidenceStore = await createEvidence(output);
  const save = evidenceStore.save;
  let report = {
    version: "renderer-offline-slice-v1",
    ...(experiment ? { experiment } : {}),
    status: "preparing",
    usage: null,
    passedPrefix: 0,
    steps: [],
    attempts: [],
  };
  await save(report);
  let driver;
  try {
    const workload = JSON.parse(await readFile(workloadPath, "utf8"));
    assert.equal(workload.version, "renderer-atomic-slice-v2");
    assert.equal(workload.steps.length, 11);
    const obligations = resolveObligations(workload.steps);
    assert.deepEqual(workload.obligations, obligations);
    report.passedPrefix = 0;
    report.steps = workload.steps.map((step) => ({ id: step.id, status: "unattempted" }));
    await save(report);
    const initial = await readTree(initialSource);
    assert.equal(treeIdentity(initial), workload.initial);
    assert.deepEqual(Object.keys(initial), ["main.cpp"]);
    const workspace = path.join(output, "workspace");
    await writeTree(workspace, initial);
    await evidenceStore.checkpoint(initial);
    const executor = path.join(output, "executor");
    if (!baseline) {
      await prepareScriptedExecutor(executor, scriptedExecutor);
    }
    const evidence = path.join(output, "checks");
    await mkdir(evidence);
    log("GRADE initial: isolated fresh build, compiler inventory and two repeated scenes");
    const referenceBaseline = await inspectCandidate(workspace, path.join(evidence, "initial"), {
      signal,
    });
    const contract = createSliceContract(initial, referenceBaseline);
    await writeFile(path.join(output, "contract.json"), JSON.stringify(contract) + "\n");
    log("PASS initial");
    if (baseline)
      driver = await startBaseline(workspace, path.join(output, "agent-state"), baseline, {
        eventsFile: path.join(output, "agent-events.jsonl"),
      });
    const context = {
      initial: workload.initial,
      ...(experiment ? { experiment } : {}),
      workloadVersion: workload.version,
      baseline: { pixels: referenceBaseline.pixels },
      executor: baseline ? "baseline-agent" : "scripted",
      livePi: Boolean(baseline),
      ...(driver
        ? { runtimeVersion: driver.version, model: baseline.model, thinking: baseline.thinking }
        : {}),
    };
    report = await runRequestChain(workload.steps, {
      signal,
      log,
      attemptTimeoutMs,
      trialTimeoutMs,
      save: async (chain) => {
        report = { ...chain, ...context, usage: driver ? finalizedUsage(driver.events) : null };
        await save(report);
      },
      identity: async () => {
        let current;
        try {
          current = await readTree(workspace);
        } catch {
          return null;
        }
        return evidenceStore.checkpoint(current);
      },
      execute: async ({ prompt, signal: currentSignal }) => {
        try {
          if (driver) return await driver.execute(prompt, { signal: currentSignal });
          return await runIsolatedRequest(workspace, executor, prompt, { signal: currentSignal });
        } catch (error) {
          if (error.cause?.code === "ENOENT" || error.message.startsWith("bwrap:"))
            throw new GradeFailure("infrastructure", error.message, { cause: error });
          throw error;
        }
      },
      grade: async ({ index, attempt, signal: currentSignal }) => {
        const inspection = await inspectCandidate(
          workspace,
          path.join(evidence, `${workload.steps[index].id}-attempt-${attempt}`),
          { signal: currentSignal },
        );
        assertCandidateObligations(inspection, obligations[index], contract);
        return { status: "pass", pixels: inspection.pixels };
      },
    });
    report = { ...report, ...context, usage: driver ? finalizedUsage(driver.events) : null };
    await save(report);
    log(
      `${report.status.toUpperCase()}: ${report.passedPrefix}/11 requests, ${report.attempts.length} attempts; evidence retained`,
    );
    return report;
  } catch (error) {
    report.status = signal?.aborted ? "cancelled" : "infrastructure";
    report.terminal = { category: report.status, message: error.message };
    await save(report);
    log(`${report.status.toUpperCase()}: ${error.message}`);
    return report;
  } finally {
    if (driver) {
      await driver.close();
      report.agentClosed = driver.closed;
      await save(report);
    }
  }
}

/** Run the independent scripted proof without invoking Pi or a model. */
export function offlineSlice(initialSource, workloadPath, output, options = {}) {
  assert.equal(options.baseline, undefined, "Use liveSlice for real Pi execution");
  return runSlice(initialSource, workloadPath, output, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3)
      throw new Error(
        "Usage: node scripts/multi-agent/experiments/offline-run.mjs INITIAL_SOURCE WORKLOAD_JSON NEW_OUTPUT",
      );
    const report = await offlineSlice(...args, { signal: controller.signal });
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
