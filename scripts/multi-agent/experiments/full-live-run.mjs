import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runBatchedRequestChain } from "../../../src/suites/explicit-edit-multi-agent/tasks/request-batches.mjs";
import { GradeFailure } from "../../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import {
  readTree,
  writeTree,
  treeIdentity,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { batchRequests } from "../../../src/suites/explicit-edit-multi-agent/tasks/request-batches.mjs";
import { assertFullEndpoint } from "../../../src/suites/explicit-edit-multi-agent/grading/full-grade.mjs";
import {
  startBaseline,
  finalizedUsage,
} from "../../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import {
  groupedRequests,
  runGroupedRequestChain,
  GROUPED_PROMPT_BYTES,
} from "./grouped-requests.mjs";
import {
  overallDeadline,
  abortStatus,
} from "../../../src/suites/explicit-edit-multi-agent/execution/overall-deadline.mjs";

const exec = promisify(execFile);
/** Run a proven full workload with one live baseline session and coarse batch feedback.
 * Trusted references and diagnostics stay outside the agent sandbox. Each failed
 * batch allows three corrections in its current workspace, without replaying moves.
 * The sequential control has no overall deadline. The grouped-hour profile delivers
 * one ordered list per request and caps initial grading plus execution at one hour.
 * Each attempt still has a 30-minute limit, bounded by the overall deadline.
 * Output must be a fresh private directory; earlier runs are never overwritten.
 */
export async function runFullLive(
  proofPath,
  configPath,
  outputPath,
  { signal: externalSignal, profile = "sequential", hourLimitMs = 3_600_000 } = {},
) {
  assert.ok(["sequential", "grouped-hour"].includes(profile), "Unknown delivery profile");
  const grouped = profile === "grouped-hour";
  const proof = path.resolve(proofPath),
    output = path.resolve(outputPath);
  const json = async (p) => JSON.parse(await readFile(p, "utf8"));
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  const proven = await json(path.join(proof, "report.json"));
  const audit = await json(path.join(proof, "audit.json"));
  assert.equal(proven.status, "pass");
  assert.equal(audit.status, "pass");
  const requestBytes = await readFile(path.join(proof, "requests.json"));
  assert.equal(hash(requestBytes), audit.requestsSha256);
  const requests = JSON.parse(requestBytes);
  const controlBatches = batchRequests(requests);
  assert.equal(requests.length, 2930);
  assert.equal(controlBatches.length, 155);
  const batches = grouped ? groupedRequests(requests) : controlBatches;
  const config = await json(configPath);
  await mkdir(output, { mode: 0o700 });
  const workspace = path.join(output, "workspace");
  const initial = await readTree(path.join(proof, "checks/initial/source"));
  assert.equal(treeIdentity(initial), audit.initial);
  await writeTree(workspace, initial);
  await mkdir(path.join(output, "checks"));
  await writeFile(path.join(output, "requests.json"), requestBytes);
  if (grouped)
    await writeFile(path.join(output, "lists.json"), JSON.stringify(batches, null, 2) + "\n");
  const report = {
    version: grouped ? "renderer-full-grouped-hour-v1" : "renderer-full-live-oracle-v1",
    profile,
    ...(grouped ? { promptBytes: GROUPED_PROMPT_BYTES, lists: batches.length } : {}),
    status: "preparing",
    model: config.model,
    thinking: config.thinking,
    harness: "baseline-agent",
    tools: ["bash"],
    requests: requests.length,
    batches: batches.length,
    requestSha256: audit.requestsSha256,
    initial: audit.initial,
    policy: {
      oracleRecoveries: 3,
      feedbackMode: "coarse",
      batchAttemptTimeoutMs: 1800000,
      trialTimeoutMs: grouped ? hourLimitMs : null,
    },
    passedBatches: 0,
    passedRequests: 0,
    deliveredRequests: 0,
    deliveries: [],
    checks: [],
    usage: null,
  };
  const save = async () => {
    await writeFile(
      path.join(output, "report.pending.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
  };
  async function sourceTree() {
    const tree = {};
    async function visit(relative) {
      for (const entry of await readdir(path.join(workspace, relative), { withFileTypes: true })) {
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(file);
        else if (!entry.isFile())
          throw Object.assign(Error(`Unsupported source entry: ${file}`), {
            category: "structure",
          });
        else if (file.endsWith(".cpp") || file.endsWith(".h")) {
          const bytes = await readFile(path.join(workspace, file));
          assert.ok(Buffer.from(bytes.toString("utf8")).equals(bytes), `Invalid UTF-8: ${file}`);
          tree[file] = bytes.toString("utf8");
        }
      }
    }
    await visit("");
    return tree;
  }
  function base(build, render) {
    return [
      "--unshare-all",
      "--new-session",
      "--die-with-parent",
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/etc/ld.so.cache",
      "/etc/ld.so.cache",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      workspace,
      "/workspace",
      ...(render
        ? ["--ro-bind", build, "/build", "--bind", render, "/render"]
        : ["--bind", build, "/build"]),
      "--chdir",
      "/workspace",
    ];
  }
  async function command(args, category, logFile, currentSignal) {
    try {
      const result = await exec("/usr/bin/bwrap", args, {
        timeout: 300000,
        signal: currentSignal,
        env: {},
        maxBuffer: 32 * 1024 * 1024,
      });
      await writeFile(logFile, result.stdout + result.stderr);
    } catch (error) {
      await writeFile(logFile, (error.stdout ?? "") + (error.stderr ?? "") + error.message);
      error.category =
        error.killed || error.signal || typeof error.code !== "number"
          ? "infrastructure"
          : category;
      throw error;
    }
  }
  async function grade(label, expected, currentSignal) {
    const directory = path.join(output, "checks", label),
      build = path.join(directory, "build");
    await mkdir(directory);
    await mkdir(build);
    const tree = await sourceTree();
    await writeTree(path.join(directory, "source"), tree);
    const check = { label, identity: treeIdentity(tree), status: "running" };
    report.checks.push(check);
    await save();
    try {
      try {
        assertFullEndpoint(tree, expected);
      } catch (error) {
        error.category = "structure";
        throw error;
      }
      const sources = Object.keys(tree)
        .filter((file) => file.endsWith(".cpp"))
        .sort();
      assert.ok(sources.includes("main.cpp"));
      console.log(`GRADE ${label}: isolated fresh build and two repeated scenes`);
      await command(
        [
          ...base(build),
          "/usr/bin/clang++",
          "-std=c++17",
          "-O0",
          "-ffp-contract=off",
          "-pthread",
          ...(Object.keys(tree).some((file) => file.startsWith("support/"))
            ? ["-I", "/workspace/support"]
            : []),
          ...sources.map((file) => `/workspace/${file}`),
          "-o",
          "/build/renderer",
        ],
        "build",
        path.join(directory, "compile.log"),
        currentSignal,
      );
      const passes = [];
      for (const pass of ["scene", "repeat"]) {
        const render = path.join(directory, pass);
        await mkdir(render);
        await command(
          [...base(build, render), "/build/renderer", `/render/${pass}`],
          "behavior",
          path.join(directory, `${pass}.log`),
          currentSignal,
        );
        const pixels = [];
        for (const scene of [0, 1]) {
          const handle = await open(
            path.join(render, `${pass}-${scene}.rgba32f`),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const stat = await handle.stat();
            assert.ok(stat.isFile() && stat.size === 16384);
            const bytes = await handle.readFile();
            for (let i = 0; i < bytes.length; i += 4)
              assert.ok(Number.isFinite(bytes.readFloatLE(i)));
            pixels.push(hash(bytes));
          } finally {
            await handle.close();
          }
        }
        passes.push(pixels);
      }
      try {
        assert.deepEqual(passes[0], audit.pixels);
        assert.deepEqual(passes[1], audit.pixels);
      } catch (error) {
        error.category = "behavior";
        throw error;
      }
      Object.assign(check, { status: "pass", pixels: passes[0] });
      await rm(path.join(build, "renderer"));
      console.log(`PASS ${label}`);
      return { status: "pass", identity: check.identity, pixels: check.pixels };
    } catch (error) {
      Object.assign(check, {
        status: "fail",
        category: error.category ?? "infrastructure",
        error: error.message,
      });
      throw error;
    } finally {
      await save();
    }
  }
  let driver, active;
  const started = performance.now();
  const deadline = grouped ? overallDeadline(externalSignal, hourLimitMs) : null;
  const signal = deadline?.signal ?? externalSignal;
  await save();
  try {
    await grade("initial", initial, signal);
    signal?.throwIfAborted();
    driver = await startBaseline(workspace, path.join(output, "agent-state"), config, {
      eventsFile: path.join(output, "agent-events.jsonl"),
      signal,
    });
    report.runtimeVersion = driver.version;
    report.status = "running";
    await save();
    const runChain = grouped ? runGroupedRequestChain : runBatchedRequestChain;
    const chain = await runChain(grouped ? batches : requests, {
      oracleRecoveries: 3,
      feedbackMode: "coarse",
      attemptTimeoutMs: 1800000,
      trialTimeoutMs: null,
      signal,
      log: console.log,
      identity: async () => treeIdentity(await sourceTree()),
      save: async (snapshot) => {
        report.chain = snapshot;
        report.status = snapshot.status;
        report.passedBatches = snapshot.passedBatches;
        report.passedRequests = snapshot.passedRequests;
        report.deliveries = snapshot.deliveries;
        report.deliveredRequests = snapshot.deliveries
          .filter((entry) => !entry.repair && (grouped || entry.status === "edited"))
          .reduce((sum, entry) => sum + (grouped ? entry.requestIds.length : 1), 0);
        if (grouped) {
          report.passedLists = snapshot.passedBatches;
          report.modelDeliveries = snapshot.deliveries.length;
        }
        report.usage = finalizedUsage(driver.events);
        await save();
      },
      execute: async ({ prompt, index, batchIndex, attempt, repair, signal: currentSignal }) => {
        active = {
          batch: batches[batchIndex].id,
          request: grouped ? batches[batchIndex].id : requests[index].id,
          attempt,
          repair,
        };
        const before = await sourceTree();
        console.log(
          `EDIT ${repair ? "repair" : active.request}: ${active.batch}, attempt ${attempt}/4`,
        );
        try {
          return await driver.execute(prompt, { signal: currentSignal });
        } finally {
          const after = await sourceTree();
          await writeFile(
            path.join(output, "edits.jsonl"),
            JSON.stringify({
              ...active,
              before: treeIdentity(before),
              after: treeIdentity(after),
              changed: Object.entries(after).filter(([file, text]) => before[file] !== text),
              removed: Object.keys(before).filter((file) => !(file in after)),
            }) + "\n",
            { flag: "a" },
          );
        }
      },
      grade: async ({ batch, attempt, signal: currentSignal }) => {
        const expected = await readTree(
          path.join(proof, "checks", `${batch.referenceBatchId ?? batch.id}-attempt-1`, "source"),
        );
        try {
          return await grade(`${batch.id}-attempt-${attempt}`, expected, currentSignal);
        } catch (error) {
          throw new GradeFailure(error.category ?? "infrastructure", error.message);
        }
      },
    });
    report.status = chain.status;
    report.terminal = chain.batchReport.terminal ?? null;
  } catch (error) {
    report.status = signal?.aborted
      ? abortStatus(signal)
      : error.name === "AbortError" || error.name === "TimeoutError"
        ? "timeout"
        : ["structure", "build", "behavior"].includes(error.category)
          ? "blocked"
          : (error.category ?? "infrastructure");
    report.terminal = {
      ...active,
      category: error.category ?? report.status,
      message: error.message,
    };
    console.log(`${report.status.toUpperCase()}: ${error.message.slice(0, 1500)}`);
  } finally {
    if (driver) {
      await driver.close();
      report.agentClosed = driver.closed;
      report.usage = finalizedUsage(driver.events);
    }
    await rm(path.join(output, "agent-state/pi/auth.json"), { force: true });
    if (grouped && signal.aborted) {
      report.status = abortStatus(signal);
      report.terminal = { ...active, category: report.status, message: signal.reason?.message };
    }
    deadline?.close();
    report.elapsedMs = performance.now() - started;
    report.final = treeIdentity(await sourceTree());
    await save();
    console.log(
      `${report.status.toUpperCase()}: verified ${report.passedRequests}/${requests.length} requests, ${report.passedBatches}/${batches.length} batches; delivered ${report.deliveredRequests}; up to three coarse corrections per batch`,
    );
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const report = await runFullLive(...process.argv.slice(2, 5), { signal: controller.signal });
  process.exitCode = report.status === "pass" ? 0 : 1;
}
