import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeTree, treeIdentity } from "../generation/generator.mjs";
import { MULTI_AGENT_BENCHMARK } from "../results.mjs";
import {
  RESTORING_MULTI_AGENT_PROTOCOL,
  RESTORING_MULTI_AGENT_POLICY,
} from "../restoring-results.mjs";
import { prepareBarrierSymbolMap } from "../grading/barrier-symbol-map.mjs";
import { prepareAtomicRoundCredit } from "../grading/atomic-round-credit.mjs";
import { measureCoherentCandidate } from "../grading/coherent-build.mjs";
import { barrierRepairNodes } from "../grading/repair-diagnostics.mjs";
import { roundScore } from "../grading/round-score.mjs";
import {
  prepareConcurrentExecutor,
  concurrentExecutor,
} from "../reference/concurrent-executor.mjs";
import { ATOMIC_DISPATCH_POLICY, runAtomicStream } from "./atomic-stream.mjs";
import { startBaseline, finalizedUsage } from "./pi-baseline.mjs";
import {
  captureCandidate,
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "./candidate-evidence.mjs";
import { runRestoringRound } from "./restoring-boundary.mjs";
import { loadRestoringPreparation } from "./restoring-preparation.mjs";
import { restoringSourceIdentity } from "./restoring-identity.mjs";
import {
  RESTORING_RUN_VERSION,
  restoringRunIdentity,
  createRestoringProof,
  validateRestoringProof,
} from "./restoring-proof.mjs";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const passed = (row) =>
  row.passedAtoms === row.totalAtoms && row.buildPassed && row.resultMatched && row.integrityPassed;

/** Separate restoring methodology. Historical checkpoints and proofs are never inputs.
 * Every round is measured from one drained, raw shared candidate. Six ordinary
 * editing attempts share that candidate; pass or exhaustion restores the trusted
 * current endpoint without credit, replacement processes or idle inference.
 */
export async function runRestoring(
  preparationPath,
  outputPath,
  {
    agents,
    configPath,
    proofPath,
    createDriver,
    reference = false,
    allowModelCalls = false,
    batchSize = ATOMIC_DISPATCH_POLICY.defaultBatchSize,
    referenceBatchSize,
    buildWeight = 2,
    resultWeight = 4,
    signal: externalSignal,
    log = console.log,
    onCase,
  } = {},
) {
  const started = performance.now();
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, "Invalid restoring delivery size");
  roundScore(
    { passedAtoms: 0, totalAtoms: 1, buildPassed: false, resultMatched: false },
    { buildWeight, resultWeight },
  );
  assert.equal(typeof reference, "boolean");
  assert.equal(typeof allowModelCalls, "boolean");
  assert.ok(!(configPath && createDriver), "Choose one participant factory");
  assert.ok(!(configPath && reference), "Scripted reference cannot use model configuration");
  assert.ok(!configPath || allowModelCalls, "Model execution requires explicit authorization");
  assert.ok(onCase === undefined || typeof onCase === "function");
  const live = Boolean(configPath || createDriver),
    referenceRun = !live || reference;
  assert.ok(
    referenceRun || referenceBatchSize === undefined,
    "Reference delivery sizing cannot change measured execution",
  );
  const deliveryBatchSize = referenceBatchSize === undefined ? batchSize : referenceBatchSize;
  assert.ok(
    Number.isSafeInteger(deliveryBatchSize) && deliveryBatchSize > 0,
    "Invalid reference delivery size",
  );
  assert.ok(
    referenceRun || proofPath,
    "Measured restoration requires a new matching execution proof",
  );
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const signal = controller.signal,
    output = path.resolve(outputPath);
  const drivers = [],
    notices = [];
  let report, workspace, boundary, identity;
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(async () => {
      await writeFile(
        path.join(output, "report.pending.json"),
        JSON.stringify(report, null, 2) + "\n",
        { mode: 0o600 },
      );
      await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
    });
    return saving;
  };
  try {
    try {
      signal.throwIfAborted();
      const loaded = await loadRestoringPreparation(preparationPath, { agents });
      agents = loaded.agents;
      const { manifest, schedule, atomicIntervals } = loaded;
      identity = restoringRunIdentity(loaded, await restoringSourceIdentity(), {
        protocol: RESTORING_MULTI_AGENT_PROTOCOL,
        policy: RESTORING_MULTI_AGENT_POLICY,
        batchSize,
        buildWeight,
        resultWeight,
      });
      // No participant is constructed until both fresh source identity and the
      // new full-scope proof match. Old preparation verification files are ignored.
      if (!referenceRun) validateRestoringProof(await json(proofPath), identity);
      let config,
        runtime = null;
      if (configPath) {
        config = await json(configPath);
        const installed = await json(
          path.join(config.runtime, "node_modules/@earendil-works/pi-coding-agent/package.json"),
        );
        assert.equal(
          installed.version,
          "1.3.0",
          "Restoring Baseline requires the approved persistent runtime",
        );
        runtime = {
          agent: "pi",
          version: installed.version,
          platform: process.platform,
          architecture: process.arch,
        };
      }
      await mkdir(output, { mode: 0o700 });
      workspace = path.join(output, "workspace");
      report = {
        ...identity,
        version: RESTORING_RUN_VERSION,
        benchmark: MULTI_AGENT_BENCHMARK,
        mode: referenceRun ? "reference" : "measured",
        ...(referenceRun ? { referenceBatchSize: deliveryBatchSize } : {}),
        status: "running",
        model: config?.model ?? null,
        thinking: config?.thinking ?? null,
        harness: config ? "baseline-agent" : null,
        runtime,
        schedule,
        rounds: [],
        checks: [],
        atomicBarriers: [],
        executions: [],
        deliveries: 0,
        repairs: 0,
        conflicts: live ? null : 0,
        usage: null,
        agentsClosed: [],
        terminal: null,
      };
      await save();
      await writeTree(workspace, loaded.initial);
      const initial = await captureCandidate(workspace, path.join(output, "initial-candidate"), {
        signal,
      });
      assert.equal(treeIdentity(initial.tree), identity.initial);
      await prepareBarrierSymbolMap(initial.tree, {
        evidence: path.join(output, "initial-symbols"),
        signal,
      });
      const initialBuild = await measureCoherentCandidate(
        initial.source,
        path.join(output, "initial-verification"),
        initial.tree,
        { expectedPixels: manifest.pixels, signal },
      );
      report.initialCheck = {
        identity: identity.initial,
        buildPassed: initialBuild.buildPassed,
        resultMatched: initialBuild.resultMatched,
        integrityPassed: initial.invalid.length === 0,
      };
      await assertCandidateUnchanged(workspace, initial, { signal });
      assert.ok(
        report.initialCheck.buildPassed &&
          report.initialCheck.resultMatched &&
          report.initialCheck.integrityPassed,
        "Trusted initial candidate failed verification",
      );
      boundary = initial;
      await save();
      if (!live) await prepareConcurrentExecutor(path.join(output, "executor"));
      for (let agent = 0; agent < agents; agent++) {
        signal.throwIfAborted();
        const state = path.join(output, `agent-${agent}`);
        const driver = createDriver
          ? await createDriver(workspace, state, agent)
          : config
            ? await startBaseline(workspace, state, config, {
                signal,
                eventsFile: path.join(output, `agent-${agent}-events.jsonl`),
                enforceProcessBoundary: true,
              })
            : concurrentExecutor(workspace, path.join(output, "executor"), { signal });
        drivers.push(driver);
        notices.push([]);
      }
      await Promise.all(drivers.map((driver) => driver.ready));
      report.participants = await Promise.all(drivers.map((driver) => driver.assertIdle()));
      await save();
      let rotation = 0,
        lastProgressSave = performance.now();
      const publicPrefix = [];
      for (const round of schedule) {
        signal.throwIfAborted();
        const interval = atomicIntervals.rounds.get(round.id);
        publicPrefix.push(...interval.nodes);
        let prepared, expectedSymbols, corrections;
        try {
          expectedSymbols = await prepareBarrierSymbolMap(interval.expectedTree, {
            evidence: path.join(output, "symbol-maps", round.id),
            signal,
          });
          prepared = prepareAtomicRoundCredit({
            ...interval.credit,
            expectedTree: interval.expectedTree,
            nodes: interval.nodes,
            expectedSymbols,
          });
          // The credit view, not 38 complete compiler maps, is retained during work.
          expectedSymbols = undefined;
          const result = await runRestoringRound({
            workspace,
            output,
            round: round.id,
            interval,
            drivers,
            notices,
            priorBoundary: boundary,
            signal,
            maxAttempts: referenceRun ? 1 : 6,
            buildWeight,
            resultWeight,
            executeAttempt: async ({ attempt }) => {
              log(
                `EDIT ${round.id}: maximum ${agents} persistent agents, attempt ${attempt}/${referenceRun ? 1 : 6}`,
              );
              const repair = attempt > 1;
              const repairId = (id) => `repair-${round.id}-attempt-${attempt}-${id}`;
              const nodes = repair
                ? corrections.map((node) => ({
                    ...node,
                    id: repairId(node.id),
                    dependencies: node.dependencies.map(repairId),
                  }))
                : interval.nodes;
              const state = { round: round.id, attempt, dispatched: [], status: "delivering" };
              report.atomicBarriers.push(state);
              const stream = await runAtomicStream(nodes, {
                agents,
                rotation,
                batchSize: deliveryBatchSize,
                signal,
                onCase: onCase
                  ? (event) => onCase({ ...event, round: round.id, attempt })
                  : undefined,
                executeBatch: async (members, agent, deliverySignal, context) => {
                  const editingTasks = repair
                    ? members.map(({ id, operations }) => ({ id, operations }))
                    : members;
                  const atomicIds = repair ? [] : members.map(({ id }) => id);
                  const repairIds = repair ? members.map(({ id }) => id) : [];
                  const diagnostics = repair
                    ? [
                        ...new Map(
                          members
                            .flatMap((node) => node.diagnostics ?? [])
                            .map((item) => [JSON.stringify(item), item]),
                        ).values(),
                      ]
                    : [];
                  const queued = [...notices[agent]];
                  const item = {
                    round: round.id,
                    attempt,
                    agent,
                    atomicId: members[0].id,
                    atomicIds,
                    tasks: repair ? [] : [...new Set(members.map(({ taskId }) => taskId))],
                    ...(repair
                      ? {
                          deliveryKind: "barrier-repair",
                          repairIds,
                          repairFiles: [
                            ...new Set(members.flatMap((node) => node.repairFiles ?? [])),
                          ],
                        }
                      : {}),
                    restorationNotices: queued,
                    diagnostics,
                    status: "running",
                    startedMs: performance.now() - started,
                  };
                  report.executions.push(item);
                  state.dispatched.push(...members.map(({ id }) => id));
                  report.deliveries++;
                  if (repair) report.repairs++;
                  const prompt =
                    (queued.length
                      ? `The controller restored the shared project to the trusted end of the listed rounds after saving their measured candidates. Inspect current files before editing; retain your conversation but do not assume earlier bytes remain. Restoration grants no edit credit.\n${JSON.stringify({ restoredRounds: queued })}\n\n`
                      : "") +
                    members.map(({ prompt }) => prompt).join("\n\n---\n\n") +
                    (diagnostics.length
                      ? `\n\nCandidate compiler diagnostics:\n${JSON.stringify(diagnostics)}`
                      : "") +
                    `\n\nYou share this writable project with up to ${agents} persistent agents, each with a separate retained history. Other agents may edit the same files concurrently. This round assigns ${context.assignedParticipants} agents; ${context.activeDeliveries} editing deliveries are active at this dispatch, including yours.`;
                  try {
                    if (live)
                      item.receipt = await drivers[agent].execute(prompt, {
                        signal: deliverySignal,
                        round: round.id,
                        attempt,
                        batchSize: deliveryBatchSize,
                        atomicId: members[0].id,
                        atomicIds,
                        diagnostics,
                        ...(repair
                          ? { deliveryKind: "barrier-repair", repairTasks: editingTasks }
                          : {}),
                      });
                    else {
                      item.receipts = await drivers[agent].executeBatch(editingTasks, {
                        notices: queued,
                      });
                      for (const receipt of item.receipts) report.conflicts += receipt.conflicts;
                    }
                    notices[agent].splice(0, queued.length);
                    item.status = "settled";
                  } catch (error) {
                    Object.assign(item, {
                      status: "error",
                      category: error.category ?? "infrastructure",
                      message: error.message,
                    });
                    if (error.execution) item.receipt = error.execution;
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
              Object.assign(state, { queues: stream.queues, status: "drained" });
              await save();
            },
            measureCandidate: async (candidate, { evidence }) => {
              const { measureRestoringCandidate } = await import("./candidate-grade.mjs");
              return measureRestoringCandidate(candidate, prepared, {
                evidence,
                expectedPixels: manifest.pixels,
                signal,
              });
            },
            onAttempt: async (outcome, { candidate, measurement, evidence }) => {
              report.checks.push({ round: round.id, ...outcome });
              const state = report.atomicBarriers.at(-1);
              state.status = passed(outcome) ? "accepted" : "editing-failed";
              await writeFile(
                path.join(evidence, "credit.json"),
                JSON.stringify(measurement.credit) + "\n",
                { flag: "wx", mode: 0o600 },
              );
              if (!passed(outcome) && outcome.attempt < (referenceRun ? 1 : 6))
                corrections = barrierRepairNodes({
                  category: measurement.category,
                  diagnostics: measurement.diagnostics,
                  compiler: measurement.compilerDiagnostics,
                  bindings: measurement.bindings,
                  nodes: publicPrefix,
                  tree: candidate.lexicalTree,
                });
              log(
                `CHECK ${round.id}/${outcome.attempt}: ${outcome.passedAtoms}/${outcome.totalAtoms} atoms; build=${outcome.buildPassed}; pixels=${outcome.resultMatched}; integrity=${outcome.integrityPassed}`,
              );
              await save();
            },
          });
          const { boundary: restoredBoundary, ...observed } = result;
          boundary = restoredBoundary;
          report.rounds.push(observed);
          await save();
          if (referenceRun && !passed(observed.attempts[0]))
            throw Object.assign(
              new Error("Scripted reference failed its first measured candidate"),
              {
                category: "infrastructure",
              },
            );
        } finally {
          atomicIntervals.rounds.delete(round.id);
          prepared = undefined;
          expectedSymbols = undefined;
          globalThis.gc?.();
        }
      }
      await Promise.all(drivers.map((driver) => driver.assertIdle()));
      await assertCandidateUnchanged(workspace, boundary, { signal });
      report.status = "complete";
    } catch (error) {
      if (!report) throw error;
      report.status = externalSignal?.aborted
        ? "cancelled"
        : error.category === "driver_exit" || error.category === "provider_failure"
          ? "driver_exit"
          : "infrastructure";
      report.terminal = {
        category: externalSignal?.aborted ? "cancelled" : (error.category ?? "infrastructure"),
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
      };
    } finally {
      const closed = await Promise.allSettled(drivers.map((driver) => driver.close()));
      if (report) {
        report.agentsClosed = drivers.map(
          (driver, index) => closed[index].status === "fulfilled" && driver.closed === true,
        );
        if (
          report.status === "complete" &&
          (drivers.length !== agents || report.agentsClosed.some((value) => !value))
        ) {
          report.status = "infrastructure";
          report.terminal = {
            category: "infrastructure",
            message: "Participant shutdown did not drain every process",
          };
        }
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
        const failedFinalization = (error) => {
          const detail = {
            category: "infrastructure",
            message: error.message,
            ...(error.code ? { code: error.code } : {}),
          };
          (report.finalizationFailures ??= []).push(detail);
          if (report.status === "complete" || report.status === "running")
            report.status = "infrastructure";
          report.terminal ??= detail;
        };
        for (let agent = 0; agent < drivers.length; agent++) {
          try {
            await rm(path.join(output, `agent-${agent}/pi/auth.json`), { force: true });
          } catch (error) {
            failedFinalization(error);
          }
        }
        // Even operational stops retain raw bytes after editors die. A missing
        // workspace cannot replace the original error with a cleanup exception.
        try {
          const final = await captureCandidate(workspace, path.join(output, "final-candidate"));
          report.final = final.invalid.length ? null : treeIdentity(final.tree);
          report.finalEvidence = {
            status: "captured",
            identity: final.identity,
            boundaryIdentity: final.boundaryIdentity,
          };
        } catch (error) {
          report.final = null;
          report.finalEvidence = {
            status: "error",
            code: error.code ?? null,
            message: error.message,
          };
          failedFinalization(error);
        }
        if (report.status === "complete") {
          try {
            await assertCandidateUnchanged(workspace, boundary);
          } catch (error) {
            report.status = "infrastructure";
            report.terminal = { category: "infrastructure", message: error.message };
          }
        }
        try {
          const currentSource = await restoringSourceIdentity();
          for (const [field, value] of Object.entries(currentSource))
            assert.deepEqual(
              value,
              identity[field],
              "Restoring execution source changed during the run",
            );
        } catch (error) {
          failedFinalization(error);
        }
        report.pendingRestorationNotices = notices;
        report.elapsedMs = performance.now() - started;
        await save();
      }
      externalSignal?.removeEventListener("abort", abort);
    }
    if (referenceRun && report.status === "complete" && identity.sourceClean) {
      try {
        const proof = createRestoringProof(report, identity);
        await writeFile(path.join(output, "verification.json"), JSON.stringify(proof) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        report.proof = { status: "pass", version: proof.version };
      } catch (error) {
        report.status = "infrastructure";
        report.terminal = {
          category: "infrastructure",
          message: error.message,
          ...(error.code ? { code: error.code } : {}),
        };
        report.proof = { status: "error" };
      }
      await save();
    }
    log(
      `${report.status.toUpperCase()}: ${report.rounds.length}/${report.totalRounds} restored rounds; ${report.deliveries} deliveries, ${report.repairs} repair deliveries`,
    );
    return report;
  } finally {
    if (workspace) releaseCandidateWorkspace(workspace);
  }
}
