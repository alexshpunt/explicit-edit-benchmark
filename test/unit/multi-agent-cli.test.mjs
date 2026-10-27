import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { multiAgentMain } from "../../scripts/multi-agent.mjs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { restoringFixture } from "../helpers/restoring-result-fixture.mjs";
import { tempDirectory } from "../helpers/temp.mjs";

const command = (...args) =>
  spawnSync(process.execPath, ["scripts/multi-agent.mjs", ...args], {
    encoding: "utf8",
    timeout: 10000,
  });

await test("the separate CLI is discoverable without runtime, credentials, preparation or model access", () => {
  const result = command("--help");
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["prepare", "verify", "run", "export", "validate"])
    assert.ok(result.stdout.includes(name));
  assert.ok(result.stdout.includes("--allow-model-calls"));
});

await test("native restoring export and validation show the measured first and final round scores", async (t) => {
  const root = await tempDirectory("restoring-cli-export-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = path.join(root, "run"),
    output = path.join(root, "safe.json");
  await mkdir(run);
  await writeFile(path.join(run, "report.json"), JSON.stringify(restoringFixture()));
  const exported = command("export", run, output);
  assert.equal(exported.status, 0, exported.stderr);
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.score.final.score, 53.125);
  assert.equal(result.score.first.score, 50);
  assert.ok(exported.stdout.includes("53.125"));
  const validated = command("validate", output);
  assert.equal(validated.status, 0, validated.stderr);
  assert.ok(validated.stdout.includes("53.125"));
});
await test("delivery sizes must be positive integers before any preparation is read", () => {
  for (const size of ["0", "-1", "1.5", "not-a-number", "9007199254740992"]) {
    const result = command("verify", "missing-preparation", "missing-output", "--batch-size", size);
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes("ENOENT"));
  }
});

await test("restoring references accept a separate delivery size while retaining the measured batch", async () => {
  for (const size of ["1", "50", "100"]) {
    await assert.rejects(
      multiAgentMain([
        "verify-restoring",
        "missing-preparation",
        "missing-output",
        "--agents=15",
        "--batch-size=10",
        `--reference-batch-size=${size}`,
      ]),
      (error) =>
        error.code === "ENOENT" &&
        error.path.endsWith(path.join("missing-preparation", "manifest.json")),
    );
  }
});

await test("reference delivery sizes must be positive safe integers before preparation is read", async () => {
  for (const size of ["0", "-1", "1.5", "", "auto", "Infinity", "9007199254740992"]) {
    await assert.rejects(
      multiAgentMain([
        "verify-restoring",
        "missing-preparation",
        "missing-output",
        `--reference-batch-size=${size}`,
      ]),
      { code: "ERR_ASSERTION" },
    );
  }
});

await test("reference batching cannot be selected for measured or legacy execution", async () => {
  for (const command of ["run-restoring", "verify", "run"]) {
    await assert.rejects(
      multiAgentMain([
        command,
        "missing-preparation",
        "missing-output",
        "--reference-batch-size=100",
      ]),
      { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" },
    );
  }
});
await test("restoring proof, config and model-call authorization are required before reading private inputs", async () => {
  for (const missing of ["--proof", "--config", "--allow-model-calls"]) {
    const flags = new Map([
      ["--proof", ["missing-proof.json"]],
      ["--config", ["private-config.json"]],
      ["--allow-model-calls", []],
    ]);
    flags.delete(missing);
    await assert.rejects(
      multiAgentMain([
        "run-restoring",
        "missing-preparation",
        "missing-output",
        ...[...flags].flatMap(([flag, values]) => [flag, ...values]),
      ]),
      { code: "ERR_ASSERTION" },
    );
  }
});

await test("restoring weights are finite numbers at least one before loading preparation or execution", async () => {
  for (const flag of ["--build-weight", "--result-weight"]) {
    for (const value of ["0", "0.5", "-1", "Infinity", "NaN", "wrong"]) {
      await assert.rejects(
        multiAgentMain([
          "verify-restoring",
          "missing-preparation",
          "missing-output",
          `${flag}=${value}`,
        ]),
        { code: "ERR_ASSERTION" },
      );
    }
  }
});
await test("live calls need explicit permission and scripted mode rejects private provider configuration", () => {
  for (const args of [
    ["run", "missing-preparation", "missing-output", "--config", "private-config.json"],
    ["run", "missing-preparation", "missing-output", "--allow-model-calls"],
    ["verify", "missing-preparation", "missing-output", "--config", "private-config.json"],
    ["verify", "missing-preparation", "missing-output", "--agents", "0"],
  ]) {
    const result = command(...args);
    assert.equal(result.status, 1);
    assert.ok(
      !result.stderr.includes("ENOENT"),
      "Reject invalid invocation before reading preparation or credentials",
    );
  }
});
