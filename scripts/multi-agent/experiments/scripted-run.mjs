import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareScriptedExecutor } from "./scripted-runtime.mjs";
import { fileURLToPath } from "node:url";
import { assertSliceObligations, resolveObligations } from "./atomic-slice.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { buildAndRender } from "../../../src/suites/explicit-edit-multi-agent/generation/run.mjs";

/** Run one current request in Bubblewrap. Only the current workspace is writable.
 * The executor directory must contain only the worker and its pure lexer, never
 * workload records or answers. Runtime files are read-only; host files, environment,
 * network and other processes are not available. There is no unsandboxed fallback.
 */
export function runIsolatedRequest(
  workspace,
  executor,
  prompt,
  { signal, timeoutMs = 30_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/bwrap",
      [
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
        path.resolve(executor),
        "/executor",
        "--bind",
        path.resolve(workspace),
        "/workspace",
        "--chdir",
        "/workspace",
        process.execPath,
        "/executor/reference/scripted-worker.mjs",
        "/workspace",
      ],
      { timeout: timeoutMs, signal, maxBuffer: 1024 * 1024, env: {} },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message, { cause: error }));
        else resolve({ stdout, stderr });
      },
    );
    // A rejected startup may close stdin before the request is written.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/** Independently execute the pinned slice in one evolving workspace, stopping on
 * the first failed edit, obligation, build or render. No source snapshots or inverse
 * records are read by the worker. This proves this slice, not the full benchmark.
 */
export async function scriptedSeries(
  initialSource,
  workloadPath,
  output,
  { log = console.log } = {},
) {
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(path.join(output, "checks"));
  const report = { version: "renderer-scripted-slice-v1", status: "unverified", checks: [] };
  const save = () =>
    writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await save();
  let id = "initial",
    phase = "input";
  try {
    const workload = JSON.parse(await readFile(workloadPath, "utf8"));
    if (workload.version !== "renderer-atomic-slice-v2" || workload.steps.length !== 11)
      throw new Error("Expected the pinned eleven-request slice");
    const compiler = await new Promise((resolve, reject) => {
      execFile("clang++", ["--version"], { timeout: 10_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.split("\n").slice(0, 2));
      });
    });
    if (
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !/clang version 18\./.test(compiler[0])
    )
      throw new Error("Verification currently requires Linux x64 and Clang 18");
    report.environment = { platform: process.platform, architecture: process.arch, compiler };
    const obligations = resolveObligations(workload.steps);
    assert.deepEqual(workload.obligations, obligations, "Serialized obligations differ");
    const initial = await readTree(initialSource);
    assert.equal(treeIdentity(initial), workload.initial, "Initial source differs");
    assert.deepEqual(Object.keys(initial), ["main.cpp"], "Expected the unchanged monolith");
    const workspace = path.join(output, "workspace");
    await writeTree(workspace, initial);
    const executor = path.join(output, "executor");
    await prepareScriptedExecutor(executor);
    report.initial = workload.initial;
    report.steps = workload.steps.length;
    let golden;
    for (let index = 0; index <= workload.steps.length; index++) {
      const step = workload.steps[index - 1];
      id = step?.id ?? "initial";
      const check = { id, status: "unverified", before: treeIdentity(await readTree(workspace)) };
      report.checks.push(check);
      phase = "edit";
      await save();
      if (step) {
        log(`EDIT ${id}: isolated current request`);
        check.execution = await runIsolatedRequest(workspace, executor, step.prompt);
      }
      const tree = await readTree(workspace);
      check.identity = treeIdentity(tree);
      phase = "obligations";
      if (step) {
        assertSliceObligations(tree, obligations[index - 1]);
        check.obligations = "pass";
      }
      phase = "build-render";
      await save();
      log(`BUILD ${id}: current workspace`);
      const pixels = await buildAndRender(
        workspace,
        path.join(output, "checks", id),
        tree,
        "clang++",
      );
      golden ??= pixels;
      assert.deepEqual(pixels, golden, `Rendered pixels differ at ${id}`);
      Object.assign(check, { pixels, status: "pass" });
      log(`PASS ${id}: cumulative obligations, two exact scenes, repeat render`);
      await save();
    }
    report.status = "pass";
    await save();
    log(
      `VERIFIED SCRIPTED SLICE: ${workload.steps.length} isolated requests, ${report.checks.length} states; one evolving workspace`,
    );
    return report;
  } catch (error) {
    report.status = "fail";
    report.failure = { id, phase, message: error.message };
    const check = report.checks.at(-1);
    if (check?.status === "unverified") check.status = "fail";
    await save();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 3)
      throw new Error(
        "Usage: node scripts/multi-agent/experiments/scripted-run.mjs INITIAL_SOURCE WORKLOAD_JSON NEW_OUTPUT",
      );
    await scriptedSeries(...args);
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
