import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRunOptions, runLocal, runOfficial } from "../../scripts/benchmark-run.mjs";

test("one run command requires an explicit official or local mode", () => {
  assert.throws(() => parseRunOptions(["--harness", "pi-default", "--model", "m"]), /exactly one/);
  assert.throws(
    () => parseRunOptions(["--official", "--local", "--harness", "pi-default", "--model", "m"]),
    /exactly one/,
  );
  assert.equal(
    parseRunOptions([
      "--official",
      "--harness",
      "pi-default",
      "--model",
      "m",
      "--agent-version",
      "1.2.3",
    ]).thinking,
    "low",
  );
});

test("an official run is full unless the user explicitly selects one task", () => {
  const full = parseRunOptions([
    "--official",
    "--harness",
    "pi-default",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--agent-version",
    "0.85.1",
  ]);
  assert.equal(full.task, undefined);
  assert.equal(full.concurrency, "10");

  const partial = parseRunOptions([
    "--official",
    "--harness",
    "pi-default",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--agent-version",
    "0.85.1",
    "--task",
    "replace-all-10-plain",
  ]);
  assert.equal(partial.task, "replace-all-10-plain");
});

test("the reusable workflow keeps partial and full execution paths distinct", async () => {
  const workflow = await readFile(
    path.join(import.meta.dirname, "../../.github/workflows/official-run.yml"),
    "utf8",
  );
  assert.ok(workflow.includes("description: Optional single task"));
  assert.ok(!workflow.includes("default: replace-all-10-plain"));
  assert.ok(workflow.includes('if [[ -n "$TASK" ]]; then'));
  assert.ok(workflow.includes('--task "$TASK"'));
  assert.ok(workflow.includes("EXPLICIT_EDIT_SMOKE_PASSED=1 npm run benchmark -- raw-run"));
  assert.ok(workflow.includes("--oracle-recoveries 5"));
  assert.ok(workflow.includes('--concurrency "$CONCURRENCY"'));
  assert.ok(workflow.includes("value.job_workflow_sha"));
  assert.ok(workflow.includes("value.job_workflow_ref"));
});

test("full official dispatch omits task and forwards full-run concurrency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchmark-run-"));
  const authFile = path.join(root, "auth.json");
  await writeFile(authFile, '{"openai-codex":{"access":"private"}}\n');
  const calls = [];
  let lists = 0;
  const execute = async (binary, args, options = {}) => {
    calls.push({ binary, args, options });
    if (args[0] === "api") return "alice";
    if (binary === "hf") return "hf_private";
    if (args[0] === "run" && args[1] === "list") return String(lists++ ? 22 : 21);
    return "";
  };
  try {
    await runOfficial(
      {
        harness: "pi-default",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "low",
        concurrency: "10",
        "agent-version": "0.85.1",
        "harness-version": "",
        "runtime-version": "",
        "pi-auth-file": authFile,
        "no-wait": true,
      },
      execute,
    );
    const dispatch = calls.find(({ args }) => args[0] === "workflow" && args[1] === "run").args;
    assert.ok(dispatch.includes("concurrency=10"));
    assert.ok(!dispatch.some((value) => value.startsWith("task=")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local mode delegates to the existing complete unverified submission", async () => {
  const calls = [];
  await runLocal(
    {
      harness: "codex-cli-default",
      model: "openai/model",
      thinking: "low",
      concurrency: "3",
    },
    async (binary, args) => calls.push({ binary, args }),
  );
  assert.deepEqual(calls, [
    {
      binary: "npm",
      args: [
        "run",
        "benchmark:submit",
        "--",
        "--harness",
        "codex-cli-default",
        "--model",
        "openai/model",
        "--thinking",
        "low",
        "--concurrency",
        "3",
      ],
    },
  ]);
});

test("official mode bootstraps secrets through stdin and dispatches approved inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchmark-run-"));
  const authFile = path.join(root, "auth.json");
  await writeFile(authFile, '{"openai-codex":{"access":"private"}}\n');
  const calls = [];
  let lists = 0;
  const execute = async (binary, args, options = {}) => {
    calls.push({ binary, args, options });
    if (args[0] === "api") return "alice";
    if (args[0] === "repo" && args[1] === "view") throw Error("missing");
    if (binary === "hf") return "hf_private";
    if (args[0] === "run" && args[1] === "list") return String(lists++ ? 22 : 21);
    return "";
  };
  try {
    const result = await runOfficial(
      {
        harness: "pi-default",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "low",
        task: "replace-all-10-plain",
        "agent-version": "0.85.1",
        "harness-version": "",
        "pi-auth-file": authFile,
        "no-wait": true,
      },
      execute,
    );
    assert.deepEqual(result, { repository: "alice/explicit-edit-benchmark-run", runId: "22" });
    assert.ok(
      calls.some(({ args }) => args.includes("alexshpunt/explicit-edit-benchmark-run-template")),
    );
    const secrets = calls.filter(({ args }) => args[0] === "secret");
    assert.deepEqual(
      secrets.map(({ args }) => args[2]),
      ["PI_AUTH_JSON", "HF_TOKEN"],
    );
    assert.ok(
      secrets.every(({ args }) => !args.includes("private") && !args.includes("hf_private")),
    );
    assert.ok(calls.some(({ args }) => args.includes("model=openai-codex/gpt-5.6-luna")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
