import assert from "node:assert/strict";
import test from "node:test";
import { parseRunOptions, runLocal, runOfficial } from "../../scripts/benchmark-run.mjs";
import { writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tempDirectory } from "../helpers/temp.mjs";
import { submitOptions } from "../../scripts/benchmark-submit.mjs";
import { spawnSync } from "node:child_process";
import { officialSuiteRunOptions } from "../../scripts/benchmark-suites.mjs";
import { suiteVerifier } from "../../scripts/run-multi-agent-batch.mjs";

const baseline = ["--local", "--harness", "baseline-agent", "--model", "example/model"];
const multiAgent = ["--suite", "explicit-edit-multi-agent", ...baseline];

test("common run help describes suite/config selection without opening a run", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/benchmark.mjs", "run", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--suite ID/);
  assert.match(result.stdout, /--config FILE/);
});

test("official scope validation refuses unapproved teams before credentials or model calls", async () => {
  const policy = JSON.parse(
    await readFile(new URL("../../policies/official-runs/v1.json", import.meta.url), "utf8"),
  );
  const runnerSha = policy.workflows[0].sha;
  const original = await officialSuiteRunOptions(policy, "explicit-edit", { runnerSha });
  assert.equal(original.concurrency, "10");
  await assert.rejects(
    officialSuiteRunOptions(policy, "explicit-edit-multi-agent", { runnerSha }),
    /no matching approved/,
  );
  policy.suites = {
    "explicit-edit-multi-agent": { runner: { verifierSha256: await suiteVerifier() } },
  };
  const team = await officialSuiteRunOptions(policy, "explicit-edit-multi-agent", { runnerSha });
  assert.equal(team.concurrency, "15");
  await assert.rejects(
    officialSuiteRunOptions(policy, team.suite, { runnerSha, concurrency: "14" }),
    /exactly 15/,
  );
  await assert.rejects(
    officialSuiteRunOptions(policy, team.suite, { runnerSha, task: "task-001" }),
    /full workload/,
  );
  policy.suites[team.suite].runner.verifierSha256 = "a".repeat(64);
  await assert.rejects(
    officialSuiteRunOptions(policy, team.suite, { runnerSha }),
    /no matching approved/,
  );
  policy.workflows[0].status = "revoked";
  await assert.rejects(
    officialSuiteRunOptions(policy, "explicit-edit", { runnerSha }),
    /Revoked signer/,
  );
});

test("the original suite keeps its default scheduling and permits one selected task", () => {
  const options = parseRunOptions([...baseline, "--task", "replace-all-10-plain"]);
  assert.equal(options.suite, "explicit-edit");
  assert.equal(options.concurrency, "10");
  assert.equal(options.task, "replace-all-10-plain");
});

test("the common run command selects the full Multi-Agent team independently of the harness", () => {
  for (const harness of [
    "baseline-agent",
    "pi-agent-ide",
    "codex-cli-default",
    "opencode-default",
  ]) {
    const options = parseRunOptions([
      "--suite",
      "explicit-edit-multi-agent",
      "--local",
      "--harness",
      harness,
      "--model",
      "example/model",
    ]);
    assert.equal(options.suite, "explicit-edit-multi-agent");
    assert.equal(options.harness, harness);
    assert.equal(options.concurrency, "15");
    assert.equal(options.task, undefined);
    assert.equal(options["timeout-seconds"], undefined);
  }
});

test("a public Multi-Agent observation refuses partial or smaller teams before running", () => {
  for (const concurrency of ["1", "14", "16", "20"])
    assert.throws(
      () => parseRunOptions([...multiAgent, "--concurrency", concurrency]),
      /15.*agents|agents.*15/,
    );
  assert.throws(
    () => parseRunOptions([...multiAgent, "--task", "task-001"]),
    /full.*workload|all.*tasks|partial/i,
  );
  assert.equal(parseRunOptions([...multiAgent, "--concurrency", "15"]).concurrency, "15");
  assert.throws(
    () => parseRunOptions(["--suite", "unknown-suite", ...baseline]),
    /Unknown.*suite|Unsupported.*suite/,
  );
});

test("the real raw CLI rejects invalid team policy before opening a harness configuration", () => {
  const raw = path.join(import.meta.dirname, "../../scripts/run-harness-batch.mjs");
  const cases = [
    { flags: ["--concurrency", "1"], error: /15.*agents|agents.*15/ },
    { flags: ["--task", "task-001"], error: /full.*workload|partial/ },
    { flags: ["--smoke"], error: /full.*untimed.*workload/ },
    { flags: ["--oracle-recoveries", "5"], error: /three.*corrections/ },
    { flags: ["--timeout-seconds", "120"], error: /untimed.*workload/ },
  ];
  for (const { flags, error } of cases) {
    const child = spawnSync(
      process.execPath,
      [
        raw,
        "--suite",
        "explicit-edit-multi-agent",
        "--config",
        "must-not-be-opened.json",
        ...flags,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, error);
    assert.ok(!child.stderr.includes("ENOENT"));
  }
});
test("the common local submission receives the selected suite and fixed team policy", async () => {
  const calls = [];
  await runLocal(parseRunOptions(multiAgent), async (binary, args) => calls.push({ binary, args }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, "npm");
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 3), ["run", "benchmark:submit", "--"]);
  assert.equal(args[args.indexOf("--suite") + 1], "explicit-edit-multi-agent");
  assert.equal(args[args.indexOf("--concurrency") + 1], "15");
  assert.equal(args[args.indexOf("--harness") + 1], "baseline-agent");
});

test("submission retains the fixed team policy without passing suite options to adapter preparation", () => {
  const options = submitOptions([
    "--suite",
    "explicit-edit-multi-agent",
    "--harness",
    "baseline-agent",
    "--model",
    "example/model",
    "--thinking",
    "high",
  ]);
  assert.equal(options.suite, "explicit-edit-multi-agent");
  assert.equal(options.concurrency, 15);
  assert.equal(options.oracleRecoveries, 3);
  assert.equal(options.timeoutSeconds, null);
  assert.deepEqual(options.prepareArgs, [
    "--harness",
    "baseline-agent",
    "--model",
    "example/model",
    "--thinking",
    "high",
  ]);
  const custom = submitOptions([
    "--suite",
    "explicit-edit-multi-agent",
    "--config",
    "custom.config.mjs",
  ]);
  assert.equal(custom.concurrency, 15);
  assert.equal(custom.config, "custom.config.mjs");
  assert.throws(
    () =>
      submitOptions([
        "--suite",
        "explicit-edit-multi-agent",
        "--config",
        "c",
        "--concurrency",
        "1",
      ]),
    /15.*agents|agents.*15/,
  );
});

test("official dispatch cannot silently substitute the original suite for Multi-Agent", async (t) => {
  const root = await tempDirectory("suite-dispatch-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const authFile = path.join(root, "auth.json");
  await writeFile(authFile, "{}\n");
  const calls = [];
  let lists = 0;
  const execute = async (binary, args) => {
    calls.push({ binary, args });
    if (args[0] === "api") return "test-contributor";
    if (binary === "hf") return "test-token";
    if (args[0] === "run" && args[1] === "list") return String(lists++ ? 22 : 21);
    return "";
  };
  await runOfficial(
    parseRunOptions([
      "--suite",
      "explicit-edit-multi-agent",
      "--official",
      "--harness",
      "baseline-agent",
      "--model",
      "example/model",
      "--agent-version",
      "1.0.1",
      "--pi-auth-file",
      authFile,
      "--no-wait",
    ]),
    execute,
  );
  const dispatch = calls.find(({ args }) => args[0] === "workflow" && args[1] === "run").args;
  assert.ok(dispatch.includes("suite=explicit-edit-multi-agent"));
  assert.ok(dispatch.includes("concurrency=15"));
  assert.ok(!dispatch.some((value) => value.startsWith("task=")));
});
test("custom model-harness matrices use the existing config path for either suite", async () => {
  for (const suite of ["explicit-edit", "explicit-edit-multi-agent"]) {
    const options = parseRunOptions(["--suite", suite, "--local", "--config", "custom.config.mjs"]);
    assert.equal(options.config, "custom.config.mjs");
    assert.equal(options.harness, undefined);
    const calls = [];
    await runLocal(options, async (binary, args) => calls.push({ binary, args }));
    assert.equal(calls.length, 1);
    const args = calls[0].args;
    assert.equal(args[args.indexOf("--config") + 1], "custom.config.mjs");
    assert.ok(!args.includes("--harness"));
    assert.ok(!args.includes("--model"));
  }
  assert.throws(
    () =>
      parseRunOptions([
        "--local",
        "--config",
        "custom.config.mjs",
        "--harness",
        "pi-default",
        "--model",
        "example/model",
      ]),
    /config.*harness|config.*preset/i,
  );
});
