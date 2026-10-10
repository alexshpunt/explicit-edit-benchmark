import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTree, writeTree, treeIdentity } from "../generation/generator.mjs";
import { runRequestChain } from "./request-chain.mjs";
import { overallDeadline, abortStatus } from "./overall-deadline.mjs";
import { GradeFailure } from "../grading/failure.mjs";
import { evaluateCoherentContract } from "../grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../grading/coherent-build.mjs";
import { fullExecutor } from "../reference/full-executor.mjs";
import { prepareCoherentExecutor } from "../reference/coherent-executor.mjs";
import { startBaseline, finalizedUsage } from "./pi-baseline.mjs";

async function candidateTree(workspace) {
  const tree = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(workspace, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(file);
      else if (!entry.isFile())
        throw new GradeFailure("structure", `Nonregular candidate entry: ${file}`);
      else if (/\.(?:cpp|h)$/.test(file)) {
        const bytes = await readFile(path.join(workspace, file));
        if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
          throw new GradeFailure("structure", "Invalid candidate UTF-8");
        tree[file] = bytes.toString("utf8");
      }
    }
  }
  await visit("");
  return tree;
}

/** Run whole coherent goals against one evolving workspace with cumulative contract
 * grading and three retained-state coarse repairs. The default coherent profile has
 * no overall or attempt deadline and remains cancellable. Explicit coherent-hour
 * runs keep the old limits. Diagnostic runs cannot publish a preparation proof.
 * Scripted mode receives current public selectors only. Live mode uses one real Pi
 * baseline session and requires a matching completed scripted proof first.
 * Preparation and reports stay outside the agent's namespace; output must be fresh.
 */
export async function runCoherent(
  preparationPath,
  outputPath,
  {
    configPath,
    signal: externalSignal,
    profile = "coherent",
    hourLimitMs = 3600000,
    log = console.log,
  } = {},
) {
  if (!["coherent", "coherent-hour", "coherent-diagnostic"].includes(profile))
    throw Error("Unknown coherent profile");
  if (profile !== "coherent-hour" && hourLimitMs !== 3600000)
    throw Error("Untimed runs do not accept an hour limit");
  const trialTimeoutMs = profile === "coherent-hour" ? hourLimitMs : null;
  const attemptTimeoutMs = profile === "coherent-hour" ? 1800000 : null;
  const started = performance.now();
  const deadline = trialTimeoutMs === null ? null : overallDeadline(externalSignal, trialTimeoutMs);
  const signal = deadline?.signal ?? externalSignal ?? new AbortController().signal;
  const preparation = path.resolve(preparationPath),
    output = path.resolve(outputPath);
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  let driver, executor, report, workspace;
  try {
    const manifest = await json(path.join(preparation, "manifest.json"));
    assert.equal(manifest.version, "renderer-coherent-v1");
    const taskBytes = await readFile(path.join(preparation, "tasks.json"));
    assert.equal(createHash("sha256").update(taskBytes).digest("hex"), manifest.tasksSha256);
    const tasks = JSON.parse(taskBytes);
    assert.equal(tasks.length, manifest.tasks);
    const contracts = new Map();
    for (const id of ["initial", ...tasks.map((task) => task.id)]) {
      const bytes = await readFile(path.join(preparation, "contracts", `${id}.json`));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.contractHashes[id]);
      contracts.set(id, JSON.parse(bytes));
    }
    if (configPath) {
      const proof = await json(path.join(preparation, "verification.json"));
      assert.equal(proof.status, "pass", "Coherent tasks need a completed scripted proof");
      assert.equal(proof.tasksSha256, manifest.tasksSha256);
      assert.equal(proof.initial, manifest.initial);
      assert.equal(proof.final, manifest.final);
      assert.equal(proof.acceptedTasks, manifest.tasks);
      assert.equal(proof.checks, manifest.tasks + 1);
      assert.deepEqual(proof.contractHashes, manifest.contractHashes);
    }
    await mkdir(output, { mode: 0o700 });
    workspace = path.join(output, "workspace");
    const initial = await readTree(path.join(preparation, "initial"));
    assert.equal(treeIdentity(initial), manifest.initial);
    await writeTree(workspace, initial);
    const tools = path.join(output, "executor");
    if (!configPath) await prepareCoherentExecutor(tools);
    report = {
      version: "renderer-coherent-run-v1",
      profile,
      mode: configPath ? "live" : "scripted",
      status: "running",
      tasksSha256: manifest.tasksSha256,
      contractHashes: manifest.contractHashes,
      tasks: tasks.map(({ id, phase, subsystem, goal }) => ({ id, phase, subsystem, goal })),
      policy: {
        trialTimeoutMs,
        attemptTimeoutMs,
        oracleRecoveries: 3,
        feedbackMode: "coarse",
      },
      checks: [],
      chain: null,
      acceptedTasks: 0,
      deliveries: 0,
      repairs: 0,
      usage: null,
      initial: manifest.initial,
    };
    const save = async () => {
      await writeFile(
        path.join(output, "report.pending.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
      await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
    };
    const identity = async () => treeIdentity(await candidateTree(workspace));
    async function grade(label, contractId, currentSignal) {
      const directory = path.join(output, "checks", label);
      await mkdir(directory, { recursive: true });
      const item = { label, contractId, status: "running" };
      report.checks.push(item);
      await save();
      try {
        currentSignal.throwIfAborted();
        const tree = await candidateTree(workspace);
        item.identity = treeIdentity(tree);
        await writeTree(path.join(directory, "source"), tree);
        const ledger = evaluateCoherentContract(tree, contracts.get(contractId));
        await writeFile(
          path.join(directory, "obligations.json"),
          JSON.stringify(ledger, null, 2) + "\n",
        );
        item.obligations = { passed: ledger.passed, total: ledger.total };
        if (ledger.status !== "pass")
          throw new GradeFailure("structure", "Task contract obligations are not met");
        log(
          `BUILD ${label}: cumulative obligations ${ledger.passed}/${ledger.total}; fresh isolated build, two repeated scenes`,
        );
        const pixels = await buildCoherentCandidate(
          path.join(directory, "source"),
          path.join(directory, "verification"),
          tree,
          { signal: currentSignal },
        );
        if (JSON.stringify(pixels) !== JSON.stringify(manifest.pixels))
          throw new GradeFailure("behavior", "Rendered pixels differ");
        currentSignal.throwIfAborted();
        Object.assign(item, { status: "pass", pixels });
        await rm(path.join(directory, "verification/build/renderer"));
        log(`PASS ${label}`);
        return { status: "pass", ...item.obligations, identity: item.identity };
      } catch (error) {
        Object.assign(item, {
          status: "fail",
          category: error.category ?? "infrastructure",
          message: error.message,
        });
        throw error;
      } finally {
        await save();
      }
    }
    log(
      profile === "coherent-hour"
        ? `PROFILE coherent-hour: total limit ${trialTimeoutMs} ms; attempt limit ${attemptTimeoutMs} ms`
        : `PROFILE ${profile}: no overall or attempt deadline; cancellation remains active`,
    );
    await grade("initial", "initial", signal);
    if (configPath) {
      const config = await json(configPath);
      Object.assign(report, {
        model: config.model,
        thinking: config.thinking,
        harness: "baseline-agent",
      });
      const runtime = JSON.parse(
        await readFile(
          path.join(config.runtime, "node_modules/@earendil-works/pi-coding-agent/package.json"),
          "utf8",
        ),
      );
      assert.equal(runtime.version, "1.0.1", "Coherent baseline requires pinned Pi 1.0.1");
      driver = await startBaseline(workspace, path.join(output, "agent-state"), config, {
        eventsFile: path.join(output, "agent-events.jsonl"),
        signal,
      });
    }
    report.chain = await runRequestChain(tasks, {
      signal,
      trialTimeoutMs: null,
      attemptTimeoutMs,
      oracleRecoveries: 3,
      feedbackMode: "coarse",
      identity,
      log,
      execute: async ({ prompt, index, attempt, signal: currentSignal }) => {
        report.deliveries++;
        if (attempt > 1) report.repairs++;
        await save();
        if (driver) return driver.execute(prompt, { signal: currentSignal });
        if (attempt > 1)
          throw Error("Scripted executor has no repair strategy; failed state retained");
        executor = fullExecutor(workspace, tools, { signal: currentSignal });
        try {
          const receipt = await executor.deliver(tasks[index]);
          await writeFile(path.join(output, "edits.jsonl"), JSON.stringify(receipt) + "\n", {
            flag: "a",
          });
          return receipt;
        } finally {
          executor.close();
          executor = null;
        }
      },
      grade: ({ index, attempt, signal: currentSignal }) =>
        grade(`${tasks[index].id}-attempt-${attempt}`, tasks[index].id, currentSignal),
      save: async (chain) => {
        report.chain = chain;
        report.acceptedTasks = chain.passedPrefix;
        report.status = chain.status;
        await save();
      },
    });
    report.status = report.chain.status;
    report.terminal = report.chain.terminal ?? null;
  } catch (error) {
    if (!report) throw error;
    report.status = signal.aborted ? abortStatus(signal) : (error.category ?? "infrastructure");
    report.terminal = { category: report.status, message: error.message };
  } finally {
    executor?.close();
    if (driver) {
      await driver.close();
      report.agentClosed = driver.closed;
      report.usage = finalizedUsage(driver.events);
    }
    if (report) {
      await rm(path.join(output, "agent-state/pi/auth.json"), { force: true });
      report.final = workspace ? await identityOfWorkspace(workspace) : null;
      report.elapsedMs = performance.now() - started;
      if (signal.aborted || (trialTimeoutMs !== null && report.elapsedMs >= trialTimeoutMs)) {
        report.status = signal.aborted ? abortStatus(signal) : "timeout";
        report.terminal ??= {
          category: report.status,
          message: "Total trial limit reached during closure",
        };
      }
      await writeFile(
        path.join(output, "report.pending.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
      if (
        !["timeout", "cancelled"].includes(report.status) &&
        (signal.aborted ||
          (trialTimeoutMs !== null && performance.now() - started >= trialTimeoutMs))
      ) {
        report.status = signal.aborted ? abortStatus(signal) : "timeout";
        report.elapsedMs = performance.now() - started;
        report.terminal = {
          category: report.status,
          message: "Trial stopped during report closure",
        };
        await writeFile(
          path.join(output, "report.pending.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
      }
      await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
      log(
        `${report.status.toUpperCase()}: ${report.acceptedTasks}/${report.tasks.length} coherent tasks; ${report.deliveries} deliveries, ${report.repairs} repairs`,
      );
    }
    deadline?.close();
  }
  if (!configPath && profile !== "coherent-diagnostic" && report.status === "pass") {
    const proof = {
      status: "pass",
      tasksSha256: report.tasksSha256,
      contractHashes: report.contractHashes,
      initial: report.initial,
      final: report.final,
      acceptedTasks: report.acceptedTasks,
      checks: report.checks.length,
      elapsedMs: report.elapsedMs,
    };
    await writeFile(path.join(output, "verification.json"), JSON.stringify(proof) + "\n", {
      flag: "wx",
    });
    try {
      await writeFile(path.join(preparation, "verification.json"), JSON.stringify(proof) + "\n", {
        flag: "wx",
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await json(path.join(preparation, "verification.json"));
      assert.deepEqual({ ...previous, elapsedMs: null }, { ...proof, elapsedMs: null });
    }
  }
  return report;
}

async function identityOfWorkspace(workspace) {
  try {
    return treeIdentity(await candidateTree(workspace));
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const profile =
    args[0] === "--diagnostic"
      ? "coherent-diagnostic"
      : args[0] === "--hour-limited"
        ? "coherent-hour"
        : "coherent";
  if (profile !== "coherent") args.shift();
  assert.ok(
    args.length === 2 || args.length === 3,
    "Usage: coherent-run.mjs [--diagnostic | --hour-limited] PREPARATION OUTPUT [PRIVATE_CONFIG]",
  );
  assert.ok(
    args.every((arg) => !arg.startsWith("--")),
    "Unknown coherent option",
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const report = await runCoherent(args[0], args[1], {
    configPath: args[2],
    profile,
    signal: controller.signal,
  });
  process.exitCode = report.status === "pass" ? 0 : 1;
}
