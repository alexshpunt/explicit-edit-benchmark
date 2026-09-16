import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    parseRunOptions(["--official", "--harness", "pi-default", "--model", "m"]).thinking,
    "low",
  );
});

test("local mode delegates to the existing complete unverified submission", async () => {
  const calls = [];
  await runLocal(
    {
      harness: "pi-default",
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
        "pi-default",
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
