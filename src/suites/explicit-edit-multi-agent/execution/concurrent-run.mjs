import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTree, writeTree, treeIdentity } from "../generation/generator.mjs";
import { rotatingSchedule, dependencyGraph } from "../tasks/concurrent-schedule.mjs";
import { checkpointContracts } from "../grading/concurrent-contracts.mjs";
import { evaluateCoherentContract } from "../grading/coherent-grade.mjs";
import {
  prepareBarrierSymbolMap,
  evaluateBarrierSymbolMap,
} from "../grading/barrier-symbol-map.mjs";
import { buildCoherentCandidate } from "../grading/coherent-build.mjs";
import { GradeFailure } from "../grading/failure.mjs";
import {
  prepareConcurrentExecutor,
  concurrentExecutor,
} from "../reference/concurrent-executor.mjs";
import { startBaseline, finalizedUsage } from "./pi-baseline.mjs";
import { readSharedSource } from "../reference/concurrent-commit.mjs";
import {
  REFERENCE_EXECUTION_POLICY,
  referenceConcurrency,
  referenceFirstPass,
  validateReferenceExecution,
  validateCurrentReferenceExecution,
} from "../reference/execution-proof.mjs";
import { suiteVerifier } from "../source-identity.mjs";
import { readConcurrentCheckpoint, writeConcurrentCheckpoint } from "./concurrent-checkpoint.mjs";
import { ATOMIC_DISPATCH_POLICY, runAtomicStream } from "./atomic-stream.mjs";
import { atomicOrder } from "../tasks/atomic-effects.mjs";
import { atomicCheckpoints } from "../tasks/atomic-bundle.mjs";
import { sourceFilesAfter } from "../tasks/task-constraints.mjs";
import {
  taskDiagnostics,
  compilerDiagnostics,
  barrierRepairNodes,
} from "../grading/repair-diagnostics.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
  MULTI_AGENT_MAX_ATTEMPTS,
} from "../results.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Divide each barrier into balanced participant queues and check only the drained team.
 * Ordered dependency chains stay on one participant; parent barriers alone grant
 * Score credit after cumulative structure, build and repeated-pixel checks.
 * Corrections retain edits/history and share the fixed barrier-level budget.
 * Corrections are balanced across the whole team by file, without writer attribution.
 * Live trials require a matching atomic scripted proof before drivers open.
 * Ordinary reference merge conflicts are observed; live counts remain unknown unless supplied
 * by the harness. Private plans, gates and future tasks are never agent mounts.
 * createDriver(workspace, state, agent) returns execute(prompt, { signal, round,
 * attempt, batchSize, atomicId, atomicIds, deliveryKind?, repairTasks?, diagnostics }),
 * async close() and a closed getter. atomicId identifies the first work item for
 * native artifact paths. Initial atomicIds name original atoms; fresh barrier
 * repairs use atomicIds: [] and public repairTasks: [{ id, operations }].
 * Private compiler bindings never enter driver metadata. One receipt belongs
 * to the delivery; it is not source acceptance.
 * Accepted barriers publish immutable checkpoints/<round> snapshots. resumeFrom
 * selects one checkpoint; recoveryReason records the verified infrastructure fault.
 * Recovery strictly regrades its source before opening fresh sessions. It is always
 * diagnostic/unscored, retains prefix credit and leaves the new barrier budget fixed.
 * It must not be used to grant more attempts after a genuine model failure.
 * Optional synchronous onCase(event) forwards atomic case lifetimes with their
 * round and attempt for private external watchdogs. It does not set model limits
 * or fabricate observations for retained work.
 */
export async function runConcurrent(
  preparationPath,
  outputPath,
  {
    agents,
    configPath,
    createDriver,
    reference = false,
    resumeFrom,
    recoveryReason,
    batchSize = ATOMIC_DISPATCH_POLICY.defaultBatchSize,
    signal: externalSignal,
    log = console.log,
    onCase,
  } = {},
) {
  const started = performance.now();
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, "Invalid atomic batch size");
  assert.ok(onCase === undefined || typeof onCase === "function", "Invalid case observer");
  assert.equal(typeof reference, "boolean", "Invalid reference execution purpose");
  assert.ok(!(reference && configPath), "Scripted reference cannot use paid configuration");
  const live = Boolean(configPath || createDriver);
  const referenceRun = !live || reference;
  assert.ok(
    !resumeFrom || (live && !referenceRun),
    "Checkpoint recovery is live diagnostic work only",
  );
  assert.ok(
    !resumeFrom || (typeof recoveryReason === "string" && recoveryReason.trim().length > 0),
    "Checkpoint recovery requires an explicit infrastructure/verifier defect reason",
  );
  const maxAttempts = referenceRun ? 1 : MULTI_AGENT_MAX_ATTEMPTS;
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
    }
    const contractHashes = Object.fromEntries(
      [...contracts].map(([id, contract]) => [id, digest(JSON.stringify(contract))]),
    );
    if (live && !referenceRun && !resumeFrom) {
      const proof = await json(path.join(preparation, `verification-${agents}.json`));
      assert.deepEqual(
        proof.atomic,
        manifest.atomic,
        "Concurrent live runs need a matched atomic stream proof",
      );
      assert.equal(proof.status, "pass", "Concurrent live runs need a matched scripted proof");
      await validateCurrentReferenceExecution(proof, agents);
      assert.equal(proof.agents, agents, "Atomic proof participant count differs");
      assert.equal(proof.batchSize, batchSize, "Atomic proof message size differs");
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
      assert.equal(proof.expectedFinal, manifest.final);
      assert.match(proof.final, /^[a-f0-9]{64}$/);
      assert.equal(proof.acceptedRounds, schedule.length);
      assert.equal(proof.acceptedTasks, manifest.tasks);
    }
    signal.throwIfAborted();
    await mkdir(output, { mode: 0o700 });
    workspace = path.join(output, "workspace");
    report = {
      version: "renderer-concurrent-run-v1",
      benchmark: MULTI_AGENT_BENCHMARK,
      protocol: resumeFrom ? "renderer-checkpoint-diagnostic-v1" : MULTI_AGENT_PROTOCOL,
      ...(resumeFrom ? { diagnosticOnly: true, referenceProofMatched: false, score: null } : {}),
      verifierSha256: await suiteVerifier(),
      runtime: null,
      status: "running",
      mode: referenceRun ? "scripted" : "live",
      agents,
      batchSize,
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
      expectedFinal: manifest.final,
      totalRounds: schedule.length,
      totalTasks: manifest.tasks,
      acceptedRounds: 0,
      acceptedTasks: 0,
      deliveries: 0,
      repairs: 0,
      checks: [],
      executions: [],
      conflicts: live ? null : 0,
      referencePlannerSlots: live ? null : agents,
      referenceExecution: referenceRun ? REFERENCE_EXECUTION_POLICY : null,
      referenceSourceSha256: referenceRun ? await suiteVerifier() : null,
      regressedAcceptedObligations: [],
      overwrittenPeerChanges: null,
      usage: null,
    };
    const restored = resumeFrom ? await readConcurrentCheckpoint(resumeFrom, report) : null;
    if (restored) {
      report.resume = {
        roundId: restored.roundId,
        sourceIdentity: restored.sourceIdentity,
        sourceReportSha256: restored.sourceReportSha256,
        completedRounds: restored.completedRounds,
        acceptedTasks: restored.acceptedTasks,
        rotation: restored.rotation,
        recoveryReason,
        conversation: "fresh",
        revalidated: false,
      };
    }
    await writeTree(workspace, restored?.source ?? initial);
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
    const symbolMaps = new Map();
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
      let tree,
        repairBindings = [];
      try {
        try {
          tree = await readSharedSource(workspace);
        } catch (error) {
          throw new GradeFailure("structure", error.message);
        }
        item.identity = treeIdentity(tree);
        await writeTree(path.join(directory, "source"), tree);
        if (!symbolMaps.has(id)) {
          const expected = id === "initial" ? initial : atomicIntervals.rounds.get(id).expectedTree;
          symbolMaps.set(
            id,
            await prepareBarrierSymbolMap(expected, {
              signal,
              evidence: path.join(output, "symbol-maps", id),
            }),
          );
        }
        const lexical = evaluateCoherentContract(tree, contracts.get(id));
        const semantic = await evaluateBarrierSymbolMap(tree, symbolMaps.get(id), {
          signal,
          evidence: path.join(directory, "symbol-map"),
        });
        repairBindings = semantic.bindings ?? [];
        const obligations = [...lexical.obligations, ...semantic.obligations];
        const passed = obligations.filter((entry) => entry.status === "pass").length;
        const ledger = {
          status: lexical.status === "pass" && semantic.status === "pass" ? "pass" : "fail",
          passed,
          total: obligations.length,
          obligations,
        };
        await writeFile(path.join(directory, "obligations.json"), JSON.stringify(ledger) + "\n");
        item.obligations = { passed: ledger.passed, total: ledger.total };
        item.regressions = ledger.obligations
          .filter((obligation) => obligation.status === "fail" && acceptedIds.has(obligation.id))
          .map((obligation) => obligation.id);
        if (item.regressions.length)
          report.regressedAcceptedObligations.push({ label, ids: item.regressions });
        if (ledger.status !== "pass") {
          const error = new GradeFailure("structure", "Round editing obligations are not met");
          error.diagnostics = taskDiagnostics(ledger);
          error.compilerDiagnostics = semantic.compilerDiagnostics;
          error.repairBindings = repairBindings;
          throw error;
        }
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
        // Candidate compiler facts stay private to diagnostic planning.
        error.repairBindings = repairBindings;
        if (error.category === "build")
          error.diagnostics = compilerDiagnostics(error.cause?.stderr, tree);
        item.diagnostics = error.diagnostics ?? [];
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
    if (restored) {
      await grade(`resume-${restored.roundId}`, restored.roundId);
      report.acceptedRounds = restored.completedRounds;
      report.acceptedTasks = restored.acceptedTasks;
      report.resume.revalidated = true;
      await save();
    } else await grade("initial", "initial");
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
    // Startup readiness only: no participant waits here once editing begins.
    await Promise.all(drivers.map((driver) => driver.ready));
    let rotation = restored?.rotation ?? 0;
    let lastProgressSave = performance.now();
    const publicPrefix = [];
    for (const [roundIndex, round] of schedule.entries()) {
      signal.throwIfAborted();
      const interval = atomicIntervals.rounds.get(round.id);
      const { nodes } = interval;
      publicPrefix.push(...nodes);
      if (roundIndex < (restored?.completedRounds ?? 0)) {
        atomicIntervals.rounds.delete(round.id);
        continue;
      }
      const parentTasks = round.assignments.map((assignment) => assignment.task);
      let corrections;
      let failure;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log(`EDIT ${round.id}: ${agents} persistent agents, attempt ${attempt}/${maxAttempts}`);
        const state = { round: round.id, attempt, dispatched: [], status: "delivering" };
        report.atomicBarriers.push(state);
        const repairId = (id) => `repair-${round.id}-attempt-${attempt}-${id}`;
        const dispatchNodes =
          attempt === 1
            ? nodes
            : corrections.map((node) => ({
                ...node,
                id: repairId(node.id),
                dependencies: node.dependencies.map(repairId),
              }));
        const stream = await runAtomicStream(dispatchNodes, {
          batchSize,
          agents,
          rotation,
          signal,
          onCase: onCase ? (event) => onCase({ ...event, round: round.id, attempt }) : undefined,
          executeBatch: async (members, agent, deliverySignal, context) => {
            const repair = attempt > 1;
            const editingTasks = repair
              ? members.map((node) => ({
                  id: node.id,
                  operations: node.operations,
                }))
              : members;
            const atomicIds = repair ? [] : members.map((node) => node.id);
            const repairIds = repair ? editingTasks.map((node) => node.id) : [];
            // A repair is fresh problem work, never another original atom delivery.
            const deliveryId = repair ? repairIds[0] : members[0].id;
            const diagnostics =
              attempt === 1
                ? []
                : [
                    ...new Map(
                      members
                        .flatMap((node) => node.diagnostics ?? [])
                        .map((entry) => [JSON.stringify(entry), entry]),
                    ).values(),
                  ];
            const item = {
              round: round.id,
              attempt,
              agent,
              tasks: repair ? [] : [...new Set(members.map((node) => node.taskId))],
              atomicId: deliveryId,
              atomicIds,
              ...(attempt > 1
                ? {
                    deliveryKind: "barrier-repair",
                    repairIds,
                    repairFiles: [...new Set(members.flatMap((node) => node.repairFiles ?? []))],
                  }
                : {}),
              diagnostics,
              status: "running",
              startedMs: performance.now() - started,
            };
            report.executions.push(item);
            state.dispatched.push(...members.map((node) => node.id));
            report.deliveries++;
            if (attempt > 1) report.repairs++;
            const current =
              members.map((node) => node.prompt).join("\n\n---\n\n") +
              (diagnostics.length
                ? `\n\nCandidate compiler diagnostics:\n${JSON.stringify(diagnostics)}`
                : "");
            const prompt =
              current +
              `\n\nYou are one of ${agents} persistent agents sharing this writable project. Other agents may edit the same files concurrently. Each agent has a separate retained conversation history. In this barrier, ${context.assignedParticipants} agents have assignments. At this dispatch, ${context.activeDeliveries} editing deliveries are active, including yours.`;
            try {
              if (live) {
                item.receipt = await drivers[agent].execute(prompt, {
                  signal: deliverySignal,
                  round: round.id,
                  attempt,
                  batchSize,
                  atomicId: deliveryId,
                  atomicIds,
                  ...(repair ? { deliveryKind: "barrier-repair", repairTasks: editingTasks } : {}),
                  diagnostics,
                });
              } else {
                if (drivers[agent].executeBatch)
                  item.receipts = await drivers[agent].executeBatch(editingTasks);
                else {
                  item.receipts = [];
                  for (const node of editingTasks)
                    item.receipts.push(await drivers[agent].execute(node));
                }
                for (const receipt of item.receipts) report.conflicts += receipt.conflicts;
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
              if (performance.now() - lastProgressSave >= 5000) {
                lastProgressSave = performance.now();
                await save();
              }
            }
          },
        });
        rotation = stream.rotation;
        state.queues = stream.queues;
        state.status = "drained";
        await save();
        signal.throwIfAborted();
        try {
          await grade(`${round.id}-attempt-${attempt}`, round.id);
          failure = null;
          state.status = "accepted";
          state.accepted = nodes.map((node) => node.id);
          report.acceptedRounds++;
          report.acceptedTasks += parentTasks.length;
          const checkpointRoot = path.join(output, "checkpoints");
          await mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
          await writeConcurrentCheckpoint(path.join(checkpointRoot, round.id), {
            report,
            roundId: round.id,
            source: await readTree(
              path.join(output, "checks", `${round.id}-attempt-${attempt}`, "source"),
            ),
          });
          await save();
          break;
        } catch (error) {
          if (!["structure", "build", "behavior"].includes(error.category)) throw error;
          failure = error;
          state.status = "failed";
          if (attempt < maxAttempts) {
            corrections = await barrierRepairNodes({
              category: error.category,
              diagnostics: error.diagnostics ?? [],
              compiler: error.compilerDiagnostics ?? [],
              nodes: publicPrefix,
              tree: await readSharedSource(workspace),
              bindings: error.repairBindings ?? [],
            });
            state.repairFiles = [...new Set(corrections.flatMap((node) => node.repairFiles))];
          }
          await save();
          log(`FAIL ${round.id}: attempt ${attempt}/${maxAttempts} [${error.category}]`);
          if (attempt === maxAttempts) {
            report.status = "blocked";
            report.terminal = {
              id: round.id,
              category: "blocked",
              failure: { category: error.category, message: error.message },
            };
          }
        }
      }
      atomicIntervals.rounds.delete(round.id);
      symbolMaps.delete(round.id);
      globalThis.gc?.();
      if (failure) break;
    }
    if (report.acceptedRounds === schedule.length) {
      if (referenceRun) {
        report.referenceFirstPass = referenceFirstPass(report);
        report.referenceConcurrency = referenceConcurrency(report.executions);
        await validateCurrentReferenceExecution(report, agents);
      }
      report.status = "pass";
    }
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
  if (referenceRun && report.status === "pass") {
    const acceptedAtomicEdits = new Set(report.executions.flatMap((item) => item.atomicIds)).size;
    assert.equal(
      acceptedAtomicEdits,
      report.atomic.edits,
      "Reference did not dispatch the complete atomic inventory",
    );
    const proof = {
      status: "pass",
      protocol: report.protocol,
      policy: report.policy,
      referenceExecution: REFERENCE_EXECUTION_POLICY,
      referenceSourceSha256: report.referenceSourceSha256,
      referenceConcurrency: referenceConcurrency(report.executions),
      referenceFirstPass: report.referenceFirstPass,
      repairs: report.repairs,
      atomic: report.atomic,
      acceptedAtomicEdits,
      agents,
      batchSize,
      workloadSha256: report.workloadSha256,
      scheduleSha256: report.scheduleSha256,
      contractHashes: report.contractHashes,
      initial: report.initial,
      final: report.final,
      expectedFinal: report.expectedFinal,
      acceptedRounds: report.acceptedRounds,
      acceptedTasks: report.acceptedTasks,
    };
    validateReferenceExecution(proof, agents);
    await writeFile(path.join(output, "verification.json"), JSON.stringify(proof) + "\n", {
      flag: "wx",
    });
    // Native scripted validation keeps its own proof. It must not replace the
    // Node prerequisite, whose observed concurrency is a different execution.
    if (!live) {
      const proofFile = path.join(preparation, `verification-${agents}.json`);
      try {
        await writeFile(proofFile, JSON.stringify(proof) + "\n", { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        assert.deepEqual(await json(proofFile), proof);
      }
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [preparation, output, count = "auto", configPath, size] = process.argv.slice(2);
  assert.ok(
    preparation && output,
    "Usage: concurrent-run.mjs PREPARATION OUTPUT [auto|AGENT_COUNT] [PRIVATE_CONFIG] [BATCH_SIZE]",
  );
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const report = await runConcurrent(preparation, output, {
    agents: count === "auto" ? undefined : Number(count),
    batchSize: size === undefined ? undefined : Number(size),
    configPath,
    signal: controller.signal,
  });
  process.exitCode = report.status === "pass" ? 0 : 1;
}
