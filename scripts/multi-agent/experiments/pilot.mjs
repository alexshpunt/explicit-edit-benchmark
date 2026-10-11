import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateSeries } from "../../../src/suites/explicit-edit-multi-agent/generation/run.mjs";
import { sliceSeries } from "./slice-run.mjs";
import {
  readTree,
  treeIdentity,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { resolveObligations } from "./atomic-slice.mjs";
import { assertNeutralSource } from "../../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import { offlineSlice } from "./offline-run.mjs";
import { liveSlice } from "./live-run.mjs";
import { rebuildReport, renderSummary } from "./chain-report.mjs";

const execFile = promisify(execFileCallback);
const directory = fileURLToPath(new URL("./", import.meta.url));
const version = "renderer-pilot-v1";
const policy = {
  version: "renderer-chain-policy-v1",
  attempts: 3,
  attemptTimeoutMs: 600000,
  trialTimeoutMs: 7200000,
  tools: ["bash"],
  systemPrompt: "",
  scenes: 2,
  repeats: 2,
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });

async function identities() {
  const roots = [
    [
      "suite",
      fileURLToPath(new URL("../../../src/suites/explicit-edit-multi-agent/", import.meta.url)),
    ],
    ["experiments", directory],
  ];
  const sources = [];
  async function visit(root, prefix) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      const name = prefix + "/" + entry.name;
      if (entry.isDirectory()) await visit(file, name);
      else if (entry.isFile() && entry.name.endsWith(".mjs"))
        sources.push([name, digest(await readFile(file))]);
    }
  }
  for (const [prefix, root] of roots) await visit(root, prefix);
  sources.sort(([a], [b]) => a.localeCompare(b));
  const grader = sources.filter(([name]) =>
    [
      "experiments/candidate-grader.mjs",
      "experiments/candidate-inspect.mjs",
      "experiments/candidate-obligations.mjs",
      "suite/grading/failure.mjs",
      "suite/cpp/compiler-includes.mjs",
      "suite/cpp/cpp-tokens.mjs",
    ].includes(name),
  );
  return {
    fixture: treeIdentity(
      await readTree(
        fileURLToPath(new URL("../../../fixtures/explicit-edit-multi-agent/", import.meta.url)),
      ),
    ),
    implementation: digest(JSON.stringify(sources)),
    grader: digest(JSON.stringify(grader)),
  };
}

async function regularFile(file, label) {
  try {
    assert.ok((await lstat(file)).isFile());
    await access(file);
  } catch {
    throw Error(`${label} must be an existing regular file`);
  }
}

async function configuration(file, harness) {
  let config;
  try {
    config = await json(file);
  } catch {
    throw Error("Invalid private configuration JSON");
  }
  assert.ok(
    config && typeof config === "object" && !Array.isArray(config),
    "Expected a private configuration object",
  );
  if (config.harness !== harness)
    throw Error(`Unsupported ${harness} harness; select ${harness} explicitly`);
  const base = path.dirname(path.resolve(file));
  if (harness === "scripted") {
    assert.deepEqual(
      Object.keys(config).sort(),
      ["executor", "harness"],
      "Expected only scripted harness and executor",
    );
    assert.equal(typeof config.executor, "string", "Expected a scripted executor directory");
    const executor = await realpath(path.resolve(base, config.executor));
    for (const name of ["reference/scripted-worker.mjs", "cpp/cpp-tokens.mjs"])
      await regularFile(path.join(executor, name), "Scripted executor");
    return { executor };
  }
  const { harness: ignored, ...baseline } = config;
  assert.equal(ignored, "baseline-agent");
  assert.ok(
    Object.keys(baseline).every((key) =>
      ["runtime", "model", "thinking", "authFile", "modelsFile", "envFile"].includes(key),
    ),
    "Unknown Baseline configuration key",
  );
  assert.ok(
    typeof baseline.runtime === "string" &&
      typeof baseline.model === "string" &&
      baseline.model.includes("/"),
    "Explicit Pi runtime and provider/model are required",
  );
  assert.ok(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(baseline.thinking),
    "Explicit thinking level is required",
  );
  baseline.runtime = path.resolve(base, baseline.runtime);
  try {
    const runtimePackage = await json(
      path.join(baseline.runtime, "node_modules/@earendil-works/pi-coding-agent/package.json"),
    );
    assert.equal(runtimePackage.version, "1.0.1");
    await regularFile(
      path.join(
        baseline.runtime,
        "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      ),
      "Pi executable",
    );
  } catch {
    throw Error("Pi runtime must be a separate pinned 1.0.1 installation");
  }
  for (const key of ["authFile", "modelsFile", "envFile"]) {
    if (baseline[key] !== undefined) {
      assert.equal(typeof baseline[key], "string", "Expected explicit private file paths");
      baseline[key] = path.resolve(base, baseline[key]);
      await regularFile(baseline[key], "Declared private input");
    }
  }
  if (baseline.envFile) {
    let env;
    try {
      env = await json(baseline.envFile);
    } catch {
      throw Error("Invalid explicit provider environment JSON");
    }
    assert.ok(
      env &&
        typeof env === "object" &&
        !Array.isArray(env) &&
        Object.entries(env).every(
          ([key, value]) =>
            /^[A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key) &&
            typeof value === "string",
        ),
      "Only explicit provider credentials are allowed in envFile",
    );
  }
  return baseline;
}

/** Check the pinned build tools and an actual isolated runtime without starting an agent or a model. */
export async function checkEnvironment() {
  assert.ok(
    process.platform === "linux" &&
      process.arch === "x64" &&
      Number(process.versions.node.split(".")[0]) >= 24,
    "Requires Linux x64 and Node.js 24 or newer",
  );
  const versions = {};
  for (const [name, label] of [
    ["clang++", "Clang 18"],
    ["clangd", "Clangd 18"],
  ]) {
    try {
      const result = await execFile(name, ["--version"], { timeout: 10000 });
      const line = result.stdout.split("\n")[0];
      assert.match(line, /(?:clang|clangd) version 18\./);
      versions[name] = line;
    } catch {
      throw Error(`${label} is required and must be available on PATH`);
    }
  }
  try {
    await execFile(
      "/usr/bin/bwrap",
      [
        "--unshare-all",
        "--new-session",
        "--die-with-parent",
        "--clearenv",
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
        "/usr/bin/true",
      ],
      { timeout: 10000, env: {} },
    );
  } catch {
    throw Error("Bubblewrap isolation is unavailable; no unsandboxed fallback");
  }
  return {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    ...versions,
    isolation: "pass",
    modelCalls: 0,
  };
}

/** Load only a completed preparation whose source, workload, fixture, implementation and policy still agree. */
export async function preparedPilot(root) {
  root = path.resolve(root);
  const manifest = await json(path.join(root, "pilot.json"));
  assert.equal(manifest.version, version, "Expected the experimental renderer pilot, not V1");
  assert.equal(manifest.status, "pass", "Preparation is incomplete");
  const { identity, ...body } = manifest;
  assert.equal(identity, digest(JSON.stringify(body)), "Preparation identity changed");
  assert.deepEqual(manifest.policy, policy, "Trial policy changed");
  assert.deepEqual(
    manifest.sources,
    await identities(),
    "Fixture or implementation changed; prepare again",
  );
  const source = path.join(root, "slice/workspace");
  const workloadPath = path.join(root, "slice/trusted/workload.json");
  const sourceTree = await readTree(source);
  assert.deepEqual(Object.keys(sourceTree), ["main.cpp"]);
  assertNeutralSource("main.cpp", sourceTree["main.cpp"]);
  const workload = await json(workloadPath);
  assert.equal(workload.version, "renderer-atomic-slice-v2");
  assert.equal(workload.steps.length, 11);
  assert.equal(workload.initial, treeIdentity(sourceTree));
  assert.equal(manifest.initial, workload.initial);
  assert.equal(manifest.workload, digest(await readFile(workloadPath)), "Workload changed");
  assert.deepEqual(workload.obligations, resolveObligations(workload.steps));
  assert.doesNotMatch(JSON.stringify(workload), /yocto/i);
  return { manifest, source, workloadPath };
}

/** Prepare the accepted eleven requests from the pinned source fixture, with fresh builds and renders throughout. */
export async function preparePilot(output, { log = console.log } = {}) {
  const environment = await checkEnvironment();
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const generation = path.join(output, "generation");
  const generated = await generateSeries(generation, { names: true, log });
  assert.equal(generated.payload.status, "pass");
  const slice = await sliceSeries(
    path.join(generation, "payload"),
    path.join(generation, "operations.json"),
    path.join(output, "slice"),
    { log },
  );
  assert.equal(slice.status, "pass");
  assert.equal(slice.steps, 11);
  const manifest = {
    version,
    status: "pass",
    sources: await identities(),
    initial: slice.initial,
    workload: digest(await readFile(path.join(output, "slice/trusted/workload.json"))),
    policy,
    environment,
    pixels: generated.payload.pixels,
  };
  await save(path.join(output, "pilot.json"), {
    ...manifest,
    identity: digest(JSON.stringify(manifest)),
  });
  log("PREPARED: experimental renderer pilot, 11 requests; no model calls");
  log("Review: slice/review.md; pictures: slice/trusted/states/initial/build/scene-{0,1}.ppm");
  return manifest;
}

const help = `Experimental renderer pilot: 11 requests, separate from V1.
Use a suitable Linux environment and one heavy job at a time under a shared project lock.

node scripts/multi-agent/experiments/pilot.mjs prepare NEW_PREPARATION
node scripts/multi-agent/experiments/pilot.mjs ready [PREPARATION] [--live PRIVATE_CONFIG]
node scripts/multi-agent/experiments/pilot.mjs verify PREPARATION NEW_RUN [SCRIPTED_CONFIG]
node scripts/multi-agent/experiments/pilot.mjs live PREPARATION NEW_RUN PRIVATE_CONFIG --allow-model-calls
node scripts/multi-agent/experiments/pilot.mjs report RUN

prepare, ready, verify and report never call a model. live needs separate user approval.
Existing outputs are not overwritten. Raw evidence and configuration stay private.`;

/** Execute one explicit pilot mode. Only live with an authorization flag may start Pi/model execution. */
export async function pilotCommand(args, { signal, log = console.log } = {}) {
  const [mode, ...rest] = args;
  if (args.length === 1 && mode === "--help") {
    log(help);
    return;
  }
  if (mode === "report" && rest.length === 1) {
    const result = await rebuildReport(rest[0]);
    log(renderSummary(result.summary));
    return result;
  }
  if (mode === "ready") {
    const liveIndex = rest.indexOf("--live");
    const liveArgs = liveIndex < 0 ? [] : rest.slice(liveIndex);
    const preparation = liveIndex < 0 ? rest : rest.slice(0, liveIndex);
    assert.ok(preparation.length <= 1 && (liveArgs.length === 0 || liveArgs.length === 2), help);
    if (liveArgs.length) await configuration(liveArgs[1], "baseline-agent");
    const environment = await checkEnvironment();
    if (preparation.length) await preparedPilot(preparation[0]);
    log(
      `READY: ${preparation.length ? "verified eleven-step preparation; " : "build environment; "}${liveArgs.length ? "pinned Baseline runtime checked; " : ""}no agent started, zero model calls`,
    );
    return environment;
  }
  if (mode === "prepare" && rest.length === 1) return preparePilot(rest[0], { log });
  if (mode === "live" && !rest.includes("--allow-model-calls"))
    throw Error("Live execution requires explicit --allow-model-calls and separate user approval");
  assert.ok(
    (mode === "verify" && [2, 3].includes(rest.length)) ||
      (mode === "live" && rest.length === 4 && rest[3] === "--allow-model-calls"),
    help,
  );
  const config = rest[2]
    ? await configuration(rest[2], mode === "live" ? "baseline-agent" : "scripted")
    : null;
  await checkEnvironment();
  const prepared = await preparedPilot(rest[0]);
  const options = {
    signal,
    log,
    experiment: {
      version,
      identity: prepared.manifest.identity,
      grader: prepared.manifest.sources.grader,
      policy,
    },
    ...(config?.executor ? { scriptedExecutor: config.executor } : {}),
  };
  const report =
    mode === "live"
      ? await liveSlice(prepared.source, prepared.workloadPath, rest[1], config, options)
      : await offlineSlice(prepared.source, prepared.workloadPath, rest[1], options);
  log(renderSummary((await rebuildReport(rest[1])).summary));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await pilotCommand(process.argv.slice(2), { signal: controller.signal });
    if (result?.status && result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
