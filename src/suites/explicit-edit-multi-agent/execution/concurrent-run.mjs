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
import { ATOMIC_DISPATCH_POLICY, runAtomicStream } from "./atomic-stream.mjs";
import { atomicOrder } from "../tasks/atomic-effects.mjs";
import { atomicCheckpoints } from "../tasks/atomic-bundle.mjs";
import { barrierRepairTask, sourceFilesAfter } from "../tasks/task-constraints.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
  MULTI_AGENT_MAX_ATTEMPTS,
} from "../results.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function feedback(category) {
  if (category === "build") return "The project does not build.";
  if (category === "behavior") return "The rendered images do not match.";
  return "The batch requirements are not met.";
}

/** Stream one ready atomic edit to each free persistent participant sharing a project.
 * Verified effects unlock dependencies; drained parent-task barriers alone grant
 * Score credit after cumulative structure, build and repeated-pixel checks.
 * Corrections retain edits/history and share the fixed barrier-level budget. If
 * atoms remain verified but full grading fails, one short global repair replaces
 * atomic redispatch for that attempt. A failed barrier stops the accepted prefix.
 * Live trials require a matching atomic scripted proof before drivers open.
 * Reference CAS conflicts are observed; live counts remain unknown unless supplied
 * by the harness. Private plans, gates and future tasks are never agent mounts.
 * createDriver(workspace, state, agent) returns execute(prompt, { signal, round,
 * attempt, atomicId? , deliveryKind? }), async close() and a closed getter.
 * Optional synchronous onCase(event) forwards atomic case lifetimes with their
 * round and attempt for private external watchdogs. It does not set model limits
 * or fabricate observations for retained work or global barrier-repair deliveries.
 */
export async function runConcurrent(
  preparationPath,
  outputPath,
  { agents, configPath, createDriver, signal: externalSignal, log = console.log, onCase } = {},
) {
  const started = performance.now();
  assert.ok(onCase === undefined || typeof onCase === "function", "Invalid case observer");
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
    assert.deepEqual(
      manifest.policy,
      MULTI_AGENT_POLICY,
      "Unsupported Multi-Agent preparation policy",
    );
    assert.equal(
      manifest.atomic?.version,
      ATOMIC_DISPATCH_POLICY.version,
      "Unsupported atomic stream preparation",
    );
    assert.equal(
      manifest.atomic.dispatchPolicySha256,
      digest(JSON.stringify(ATOMIC_DISPATCH_POLICY)),
      "Atomic dispatch policy changed",
    );
    const bytes = await readFile(path.join(preparation, "tasks.json"));
    assert.equal(digest(bytes), manifest.workloadSha256);
    const taskList = JSON.parse(bytes);
    assert.equal(taskList.length, manifest.tasks);
    const atomicBytes = await readFile(path.join(preparation, "atomic/tasks.json"));
    const batchBytes = await readFile(path.join(preparation, "atomic/batches.json"));
    assert.equal(digest(atomicBytes), manifest.atomic.workloadSha256, "Atomic workload changed");
    assert.equal(
      digest(batchBytes),
      manifest.atomic.batchesSha256,
      "Private atomic bindings changed",
    );
    const atomicWorkload = JSON.parse(atomicBytes);
    assert.equal(atomicWorkload.version, "renderer-atomic-workload-v1");
    assert.equal(atomicWorkload.nodes.length, manifest.atomic.edits);
    atomicOrder(atomicWorkload.nodes);
    assert.deepEqual(
      [...new Set(atomicWorkload.nodes.map((node) => node.taskId))].sort(),
      taskList.map((task) => task.id).sort(),
      "Atomic scoring-group coverage differs",
    );
    const atomicBatches = JSON.parse(batchBytes);
    assert.ok(Array.isArray(atomicBatches), "Invalid private atomic binding batches");
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
    const atomicIntervals = atomicCheckpoints(
      initial,
      atomicWorkload,
      atomicBatches,
      schedule,
      contracts,
    );
    assert.equal(
      treeIdentity(atomicIntervals.tree),
      manifest.final,
      "Atomic schedule changed the final restoration",
    );
    const publicSourceFiles = new Map();
    let requiredSourceFiles = Object.keys(initial);
    for (const round of schedule) {
      const interval = atomicIntervals.rounds.get(round.id);
      requiredSourceFiles = sourceFilesAfter(
        requiredSourceFiles,
        interval.nodes.flatMap((node) => node.operations),
      );
      assert.deepEqual(
        requiredSourceFiles,
        contracts.get(round.id).files,
        "Public task file effects differ from the full barrier contract",
      );
      publicSourceFiles.set(round.id, requiredSourceFiles);
    }
    const contractHashes = Object.fromEntries(
      [...contracts].map(([id, contract]) => [id, digest(JSON.stringify(contract))]),
    );
    if (live) {
      const proof = await json(path.join(preparation, `verification-${agents}.json`));
      assert.deepEqual(
        proof.atomic,
        manifest.atomic,
        "Concurrent live runs need a matched atomic stream proof",
      );
      assert.equal(proof.status, "pass", "Concurrent live runs need a matched scripted proof");
      assert.equal(proof.agents, agents, "Atomic proof participant count differs");
      assert.equal(
        proof.acceptedAtomicEdits,
        manifest.atomic.edits,
        "Atomic proof inventory is incomplete",
      );
      assert.equal(proof.protocol, MULTI_AGENT_PROTOCOL, "Unsupported Multi-Agent proof protocol");
      assert.deepEqual(proof.policy, MULTI_AGENT_POLICY, "Unsupported Multi-Agent proof policy");
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
      atomic: manifest.atomic,
      atomicBarriers: [],
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
    async function grade(label, id, { atomicBlocked = false } = {}) {
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
        if (atomicBlocked)
          throw Error(
            "Atomic gates contradicted a passing full contract; retained for investigation",
          );
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
    let rotation = 0;
    let lastProgressSave = performance.now();
    const decision = (result) =>
      result.status === "pass" ? true : result.status === "pending" ? "pending" : false;
    for (const round of schedule) {
      signal.throwIfAborted();
      const { nodes, checkpoint } = atomicIntervals.rounds.get(round.id);
      // Only this local interval owns warm inventories through its corrections.
      atomicIntervals.rounds.delete(round.id);
      const parentTasks = round.assignments.map((assignment) => assignment.task);
      let completed = new Set();
      let startedAtoms = new Set();
      let failure;
      let barrierRepair = false;
      for (let attempt = 1; attempt <= MULTI_AGENT_MAX_ATTEMPTS; attempt++) {
        log(
          `EDIT ${round.id}: ${agents} persistent agents, attempt ${attempt}/${MULTI_AGENT_MAX_ATTEMPTS}`,
        );
        const retained = checkpoint.revalidate(await readSharedSource(workspace), {
          completed,
          started: startedAtoms,
        });
        completed = retained.completed;
        const state = {
          round: round.id,
          attempt,
          retained: [...completed],
          invalidated: retained.invalidated,
          inputChecks: [],
          completed: null,
          failed: [],
        };
        report.atomicBarriers.push(state);
        const executions = new Map();
        async function deliver(node, agent, deliverySignal, context, globalRepair = false) {
          const abortDelivery = () => controller.abort(deliverySignal.reason);
          deliverySignal.addEventListener("abort", abortDelivery, { once: true });
          const item = {
            round: round.id,
            attempt,
            agent,
            tasks: globalRepair ? parentTasks : [node.taskId],
            ...(globalRepair ? { deliveryKind: "barrier-repair" } : { atomicId: node.id }),
            status: "running",
            startedMs: performance.now() - started,
          };
          report.executions.push(item);
          if (!globalRepair) startedAtoms.add(node.id);
          executions.set(node.id, item);
          report.deliveries++;
          if (attempt > 1) report.repairs++;
          const current = globalRepair
            ? barrierRepairTask(publicSourceFiles.get(round.id))
            : node.prompt;
          const guidance = `\n\nYou are one of ${agents} persistent agents sharing this writable project. At this dispatch, ${context.writers.size} editing deliveries are active, including yours. Tasks are assigned one at a time to free agents. Other agents may edit the same files concurrently. Do only the current request. Re-read after peer changes, preserve completed work, and never replace a file from a stale whole-file snapshot. Do not leave background writers after your response. Edits and histories are retained across corrections; do not restart, reset the workspace or undo completed work. Dependencies are checked between edits; full verification waits for the barrier.`;
          const prompt =
            current + guidance + (attempt > 1 ? `\n\n${feedback(failure.category)}` : "");
          try {
            if (live) {
              item.receipt = await drivers[agent].execute(prompt, {
                signal: deliverySignal,
                round: round.id,
                attempt,
                ...(globalRepair ? { deliveryKind: "barrier-repair" } : { atomicId: node.id }),
              });
            } else {
              if (attempt > 1)
                throw Error("Reference editor has no repair policy; failed state retained");
              const receipt = await drivers[agent].execute(node);
              item.receipts = [receipt];
              report.conflicts += receipt.conflicts;
            }
            item.status = "settled";
            return item.receipt;
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
            deliverySignal.removeEventListener("abort", abortDelivery);
            item.elapsedMs = performance.now() - started - item.startedMs;
            // Bound progress I/O independently of the number of tiny deliveries.
            // Full state is saved at each drained barrier and on every exit.
            if (performance.now() - lastProgressSave >= 5000) {
              lastProgressSave = performance.now();
              await save();
            }
          }
        }
        const readSource = () => readSharedSource(workspace);
        let stream;
        await save();
        if (barrierRepair && completed.size === nodes.length) {
          const agent = rotation % agents;
          rotation = (agent + 1) % agents;
          await deliver({ id: round.id }, agent, signal, { writers: new Set([round.id]) }, true);
          const repaired = checkpoint.revalidate(await readSource(), {
            completed,
            started: startedAtoms,
          });
          completed = repaired.completed;
          state.invalidated.push(...repaired.invalidated);
          stream = { status: completed.size === nodes.length ? "pass" : "blocked", failed: [] };
        } else {
          stream = await runAtomicStream(nodes, {
            agents,
            onCase: onCase ? (event) => onCase({ ...event, round: round.id, attempt }) : undefined,
            completed,
            started: startedAtoms,
            rotation,
            signal,
            checkInputs: async (node, deliverySignal, context) => {
              // Keep readiness evidence private and separate from verified
              // outputs or native deliveries; a continuation is only a waiver.
              const trace = {
                atomicId: node.id,
                startedMs: performance.now() - started,
                decision: "checking",
                observations: [],
              };
              state.inputChecks.push(trace);
              const observed = (atomicId, mode, checked) => {
                trace.observations.push({
                  atomicId,
                  mode,
                  status: checked.status,
                  reason: checked.reason ?? null,
                });
              };
              const finish = (value) => {
                trace.decision = value === true ? "pass" : value === false ? "fail" : "pending";
                return value;
              };
              try {
                // Prerequisites, continuation waiver and own input/output fallback
                // share one stable source span, rather than yielding between
                // individually valid checks while peers advance the frontier.
                const checked = await checkpoint.observeInputs(readSource, node.id, context, {
                  signal: deliverySignal,
                  onObservation: observed,
                });
                return finish(decision(checked));
              } catch (error) {
                trace.decision = deliverySignal.aborted ? "aborted" : "error";
                throw error;
              } finally {
                trace.elapsedMs = performance.now() - started - trace.startedMs;
              }
            },
            execute: (node, agent, deliverySignal, context) =>
              deliver(node, agent, deliverySignal, context),
            verify: async (node, deliverySignal, _receipt, context) => {
              const checked = await checkpoint.observe(readSource, node.id, context, {
                signal: deliverySignal,
              });
              executions.get(node.id).atomicCheck = {
                status: checked.status,
                reason: checked.reason ?? null,
              };
              return decision(checked);
            },
          });
          completed = stream.completed;
          startedAtoms = stream.started;
          rotation = stream.rotation;
        }
        state.completed = [...completed];
        state.failed = stream.failed;
        await save();
        signal.throwIfAborted();
        if (!report.executions.some((item) => item.round === round.id && item.attempt === attempt))
          throw Error("Atomic inputs could not be observed before any delivery opportunity");
        try {
          await grade(`${round.id}-attempt-${attempt}`, round.id, {
            atomicBlocked: stream.status !== "pass",
          });
          failure = null;
          report.acceptedRounds++;
          report.acceptedTasks += parentTasks.length;
          await save();
          break;
        } catch (error) {
          if (!["structure", "build", "behavior"].includes(error.category)) throw error;
          failure = error;
          barrierRepair = completed.size === nodes.length;
          log(
            `FAIL ${round.id}: attempt ${attempt}/${MULTI_AGENT_MAX_ATTEMPTS} [${error.category}]`,
          );
          if (attempt === MULTI_AGENT_MAX_ATTEMPTS) {
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
    const acceptedAtomicEdits = new Set(report.executions.map((item) => item.atomicId)).size;
    assert.equal(
      acceptedAtomicEdits,
      report.atomic.edits,
      "Reference did not dispatch the complete atomic inventory",
    );
    const proof = {
      status: "pass",
      protocol: report.protocol,
      policy: report.policy,
      atomic: report.atomic,
      acceptedAtomicEdits,
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
