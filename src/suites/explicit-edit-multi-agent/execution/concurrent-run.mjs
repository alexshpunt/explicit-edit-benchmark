import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTree, writeTree, treeIdentity } from "../generation/generator.mjs";
import { rotatingSchedule, dependencyGraph } from "../tasks/concurrent-schedule.mjs";
import { checkpointContracts } from "../grading/concurrent-contracts.mjs";
import { evaluateCoherentContract } from "../grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../grading/coherent-build.mjs";
import { GradeFailure } from "../grading/failure.mjs";
import {
  prepareConcurrentExecutor,
  concurrentExecutor,
} from "../reference/concurrent-executor.mjs";
import { startBaseline, finalizedUsage } from "./pi-baseline.mjs";
import { readSharedSource } from "../reference/concurrent-commit.mjs";
import { REFERENCE_PLANNER_SLOTS } from "../reference/concurrent-planners.mjs";
import { MULTI_AGENT_BENCHMARK, MULTI_AGENT_PROTOCOL } from "../results.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function feedback(category) {
  if (category === "build") return "The project does not build.";
  if (category === "behavior") return "The rendered images do not match.";
  return "The batch requirements are not met.";
}

/** Run real persistent agents concurrently against one writable project. The DAG
 * fixes safe readiness; team size sets round membership and ownership rotates.
 * Grading happens
 * after all participants settle. Three coarse repairs retain every agent's edits
 * and history. A failed barrier stops the verified team prefix, not an invented
 * per-agent score. Live trials require an exact matching scripted team proof.
 * Reference CAS conflict counts are observable; live counts stay unknown unless
 * the harness supplies them. Reports and trusted contracts are not agent mounts.
 * createDriver(workspace, state, agent) binds a common harness participant with
 * execute(prompt, { signal, round, attempt }), close() and a closed getter.
 */
export async function runConcurrent(
  preparationPath,
  outputPath,
  { agents, configPath, createDriver, signal: externalSignal, log = console.log } = {},
) {
  const started = performance.now();
  const live = Boolean(configPath || createDriver);
  assert.ok(
    !(configPath && createDriver),
    "Choose a private baseline config or the common harness driver",
  );
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const signal = controller.signal;
  const preparation = path.resolve(preparationPath),
    output = path.resolve(outputPath);
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  const drivers = [];
  let report, workspace;
  try {
    const manifest = await json(path.join(preparation, "manifest.json"));
    assert.equal(manifest.version, "renderer-concurrent-v2");
    const bytes = await readFile(path.join(preparation, "tasks.json"));
    assert.equal(digest(bytes), manifest.workloadSha256);
    const taskList = JSON.parse(bytes);
    assert.equal(taskList.length, manifest.tasks);
    const graphBytes = await readFile(path.join(preparation, "graph.json"));
    assert.equal(digest(graphBytes), manifest.graphSha256);
    const graph = JSON.parse(graphBytes);
    const transitions = [];
    for (const task of taskList) {
      const content = await readFile(path.join(preparation, "transitions", task.id + ".json"));
      assert.equal(digest(content), manifest.transitionHashes[task.id]);
      transitions.push(JSON.parse(content));
    }
    assert.deepEqual(graph, dependencyGraph(taskList, transitions));
    agents ??= graph.width;
    const schedule = rotatingSchedule(graph, agents);
    const scheduleSha256 = digest(JSON.stringify(schedule));
    const initialBytes = await readFile(path.join(preparation, "contracts/initial.json"));
    assert.equal(digest(initialBytes), manifest.initialContractSha256);
    const initialContract = JSON.parse(initialBytes);
    const initial = await readTree(path.join(preparation, "initial"));
    assert.equal(treeIdentity(initial), manifest.initial);
    const contracts = checkpointContracts(
      initial,
      initialContract,
      taskList,
      transitions,
      schedule,
    );
    const contractHashes = Object.fromEntries(
      [...contracts].map(([id, contract]) => [id, digest(JSON.stringify(contract))]),
    );
    if (live) {
      const proof = await json(path.join(preparation, `verification-${agents}.json`));
      assert.equal(proof.status, "pass", "Concurrent live runs need a matched scripted proof");
      assert.equal(proof.workloadSha256, manifest.workloadSha256);
      assert.equal(proof.scheduleSha256, scheduleSha256);
      assert.deepEqual(proof.contractHashes, contractHashes);
      assert.equal(proof.initial, manifest.initial);
      assert.equal(proof.final, manifest.final);
      assert.equal(proof.acceptedRounds, schedule.length);
      assert.equal(proof.acceptedTasks, manifest.tasks);
    }
    signal.throwIfAborted();
    await mkdir(output, { mode: 0o700 });
    workspace = path.join(output, "workspace");
    await writeTree(workspace, initial);
    report = {
      version: "renderer-concurrent-run-v1",
      benchmark: MULTI_AGENT_BENCHMARK,
      protocol: MULTI_AGENT_PROTOCOL,
      runtime: null,
      status: "running",
      mode: live ? "live" : "scripted",
      agents,
      workloadSha256: manifest.workloadSha256,
      graphSha256: manifest.graphSha256,
      graphWidth: graph.width,
      scheduleSha256,
      contractHashes,
      schedule,
      policy: manifest.policy,
      initial: manifest.initial,
      totalRounds: schedule.length,
      totalTasks: manifest.tasks,
      acceptedRounds: 0,
      acceptedTasks: 0,
      deliveries: 0,
      repairs: 0,
      checks: [],
      executions: [],
      conflicts: live ? null : 0,
      referencePlannerSlots: live ? null : REFERENCE_PLANNER_SLOTS,
      regressedAcceptedObligations: [],
      overwrittenPeerChanges: null,
      usage: null,
    };
    let saving = Promise.resolve();
    const save = () => {
      saving = saving.then(async () => {
        await writeFile(
          path.join(output, "report.pending.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
      });
      return saving;
    };
    let acceptedIds = new Set();
    async function grade(label, id) {
      signal.throwIfAborted();
      const directory = path.join(output, "checks", label);
      await mkdir(directory, { recursive: true });
      const item = {
        label,
        contractId: id,
        status: "running",
        startedMs: performance.now() - started,
      };
      report.checks.push(item);
      await save();
      try {
        let tree;
        try {
          tree = await readSharedSource(workspace);
        } catch (error) {
          throw new GradeFailure("structure", error.message);
        }
        item.identity = treeIdentity(tree);
        await writeTree(path.join(directory, "source"), tree);
        const ledger = evaluateCoherentContract(tree, contracts.get(id));
        await writeFile(path.join(directory, "obligations.json"), JSON.stringify(ledger) + "\n");
        item.obligations = { passed: ledger.passed, total: ledger.total };
        item.regressions = ledger.obligations
          .filter((obligation) => obligation.status === "fail" && acceptedIds.has(obligation.id))
          .map((obligation) => obligation.id);
        if (item.regressions.length)
          report.regressedAcceptedObligations.push({ label, ids: item.regressions });
        if (ledger.status !== "pass")
          throw new GradeFailure("structure", "Round editing obligations are not met");
        log(
          `BUILD ${label}: cumulative obligations ${ledger.passed}/${ledger.total}; fresh build and two repeated scenes`,
        );
        const pixels = await buildCoherentCandidate(
          path.join(directory, "source"),
          path.join(directory, "verification"),
          tree,
          { signal },
        );
        if (JSON.stringify(pixels) !== JSON.stringify(manifest.pixels))
          throw new GradeFailure("behavior", "Rendered pixels differ");
        if (treeIdentity(await readSharedSource(workspace)) !== item.identity)
          throw new GradeFailure("structure", "Source changed after the round barrier");
        signal.throwIfAborted();
        acceptedIds = new Set(ledger.obligations.map((obligation) => obligation.id));
        Object.assign(item, { status: "pass", pixels });
        await rm(path.join(directory, "verification/build/renderer"));
        log(`PASS ${label}`);
      } catch (error) {
        Object.assign(item, {
          status: "fail",
          category: error.category ?? "infrastructure",
          message: error.message,
        });
        throw error;
      } finally {
        item.elapsedMs = performance.now() - started - item.startedMs;
        await save();
      }
    }
    await grade("initial", "initial");
    let config;
    if (configPath) {
      config = await json(configPath);
      Object.assign(report, {
        model: config.model,
        thinking: config.thinking,
        harness: "baseline-agent",
      });
      const runtime = await json(
        path.join(config.runtime, "node_modules/@earendil-works/pi-coding-agent/package.json"),
      );
      assert.equal(runtime.version, "1.0.1");
      report.runtime = {
        agent: "pi",
        version: runtime.version,
        platform: process.platform,
        architecture: process.arch,
      };
    } else if (!live) await prepareConcurrentExecutor(path.join(output, "executor"));
    for (let agent = 0; agent < agents; agent++) {
      signal.throwIfAborted();
      drivers.push(
        createDriver
          ? await createDriver(workspace, path.join(output, `agent-${agent}`), agent)
          : config
            ? await startBaseline(workspace, path.join(output, `agent-${agent}`), config, {
                eventsFile: path.join(output, `agent-${agent}-events.jsonl`),
                signal,
              })
            : concurrentExecutor(workspace, path.join(output, "executor"), { signal }),
      );
    }
    const tasks = new Map(taskList.map((task) => [task.id, task]));
    for (const round of schedule) {
      signal.throwIfAborted();
      let failure;
      for (let attempt = 1; attempt <= 4; attempt++) {
        log(`EDIT ${round.id}: ${agents} persistent agents, attempt ${attempt}/4`);
        const participants = Array.from({ length: agents }, (_, agent) => ({
          agent,
          assigned: round.assignments
            .filter((item) => item.agent === agent)
            .map((item) => tasks.get(item.task)),
        })).filter((item) => item.assigned.length);
        const executions = participants.map(async ({ agent, assigned }) => {
          const item = {
            round: round.id,
            attempt,
            agent,
            tasks: assigned.map((task) => task.id),
            status: "running",
            startedMs: performance.now() - started,
          };
          report.executions.push(item);
          report.deliveries++;
          if (attempt > 1) report.repairs++;
          // One public block per live agent, only its own targets for this round.
          const current = assigned
            .map((task) => (agents === 1 ? task.prompt : `Task ${task.id}:\n${task.prompt}`))
            .join("\n\n");
          const guidance =
            agents === 1
              ? ""
              : `\n\nYou share one writable project with ${agents - 1} other persistent agents (${agents} agents in this run, including you). This round assigns editing tasks to ${participants.length} agents, including you. Agents without an assignment wait. Peers assigned in this round may edit the same files concurrently. Re-read after peer changes and preserve their completed work. Do not replace files from stale whole-file snapshots or leave background writers after settling. Verification is at the ready-task barrier.`;
          const prompt =
            attempt > 1
              ? `${current}${guidance}\n\n${feedback(failure.category)}\nCorrect the current workspace. Keep earlier changes and satisfy the current request.`
              : current + guidance;
          try {
            if (live)
              item.receipt = await drivers[agent].execute(prompt, {
                signal,
                round: round.id,
                attempt,
              });
            else {
              if (attempt > 1)
                throw Error("Reference editor has no repair policy; failed state retained");
              item.receipts = [];
              for (const task of assigned) {
                const receipt = await drivers[agent].execute(task);
                item.receipts.push(receipt);
                report.conflicts += receipt.conflicts;
              }
            }
            item.status = "settled";
          } catch (error) {
            Object.assign(item, {
              status: "error",
              category: error.category ?? "infrastructure",
              message: error.message,
            });
            if (error.receipt) item.receipt = error.receipt;
            controller.abort(error);
            throw error;
          } finally {
            item.elapsedMs = performance.now() - started - item.startedMs;
            await save();
          }
        });
        const settling = Promise.allSettled(executions);
        await save();
        const results = await settling;
        const error = results.find((result) => result.status === "rejected");
        if (error) throw signal.reason ?? error.reason;
        signal.throwIfAborted();
        try {
          await grade(`${round.id}-attempt-${attempt}`, round.id);
          failure = null;
          report.acceptedRounds++;
          report.acceptedTasks += round.assignments.length;
          await save();
          break;
        } catch (error) {
          if (!["structure", "build", "behavior"].includes(error.category)) throw error;
          failure = error;
          log(`FAIL ${round.id}: attempt ${attempt}/4 [${error.category}]`);
          if (attempt === 4) {
            report.status = "blocked";
            report.terminal = {
              id: round.id,
              category: "blocked",
              failure: { category: error.category, message: error.message },
            };
          }
        }
      }
      if (failure) break;
    }
    if (report.acceptedRounds === schedule.length) report.status = "pass";
  } catch (error) {
    if (!report) throw error;
    report.status = externalSignal?.aborted ? "cancelled" : (error.category ?? "infrastructure");
    report.terminal = { category: report.status, message: error.message };
  } finally {
    await Promise.allSettled(drivers.map((driver) => driver.close()));
    if (report) {
      if (live) {
        report.agentsClosed = drivers.map((driver) => driver.closed);
        const usage = drivers.map((driver) =>
          Array.isArray(driver.events) ? finalizedUsage(driver.events) : null,
        );
        report.usage =
          usage.length === agents && usage.every(Boolean)
            ? Object.fromEntries(
                Object.keys(usage[0]).map((key) => [
                  key,
                  usage.every((item) => Number.isFinite(item[key]))
                    ? usage.reduce((sum, item) => sum + item[key], 0)
                    : null,
                ]),
              )
            : null;
        for (let agent = 0; agent < agents; agent++)
          await rm(path.join(output, `agent-${agent}/pi/auth.json`), { force: true });
      }
      report.elapsedMs = performance.now() - started;
      try {
        report.final = treeIdentity(await readSharedSource(workspace));
      } catch {
        report.final = null;
      }
      await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      log(
        `${report.status.toUpperCase()}: ${report.acceptedRounds}/${report.totalRounds} rounds, ${report.acceptedTasks}/${report.totalTasks} jointly verified tasks; ${report.deliveries} agent blocks, ${report.repairs} repair blocks; conflicts ${report.conflicts ?? "unknown"}`,
      );
    }
    externalSignal?.removeEventListener("abort", abort);
  }
  if (!live && report.status === "pass") {
    const proof = {
      status: "pass",
      agents,
      workloadSha256: report.workloadSha256,
      scheduleSha256: report.scheduleSha256,
      contractHashes: report.contractHashes,
      initial: report.initial,
      final: report.final,
      acceptedRounds: report.acceptedRounds,
      acceptedTasks: report.acceptedTasks,
    };
    await writeFile(path.join(output, "verification.json"), JSON.stringify(proof) + "\n", {
      flag: "wx",
    });
    const proofFile = path.join(preparation, `verification-${agents}.json`);
    try {
      await writeFile(proofFile, JSON.stringify(proof) + "\n", { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      assert.deepEqual(await json(proofFile), proof);
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [preparation, output, count = "auto", configPath] = process.argv.slice(2);
  assert.ok(
    preparation && output,
    "Usage: concurrent-run.mjs PREPARATION OUTPUT [auto|AGENT_COUNT] [PRIVATE_CONFIG]",
  );
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const report = await runConcurrent(preparation, output, {
    agents: count === "auto" ? undefined : Number(count),
    configPath,
    signal: controller.signal,
  });
  process.exitCode = report.status === "pass" ? 0 : 1;
}
