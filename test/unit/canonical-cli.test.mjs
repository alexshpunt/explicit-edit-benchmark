import assert from "node:assert/strict";
import test from "node:test";
import { multiAgentMain } from "../../scripts/multi-agent.mjs";

for (const missing of ["--canonical", "--config", "--allow-model-calls"]) {
  test(`canonical execution requires ${missing} before reading private input`, async () => {
    const flags = new Map([
      ["--canonical", ["missing-cache"]],
      ["--config", ["missing-private-config"]],
      ["--allow-model-calls", []],
    ]);
    flags.delete(missing);
    await assert.rejects(
      multiAgentMain([
        "run-canonical",
        "missing-preparation",
        "missing-output",
        ...[...flags].flatMap(([flag, values]) => [flag, ...values]),
      ]),
      { code: "ERR_ASSERTION" },
    );
  });
}

test("canonical preparation requires retained feasibility evidence before reading inputs", async () => {
  await assert.rejects(
    multiAgentMain(["prepare-canonical", "missing-preparation", "missing-output"]),
    { code: "ERR_ASSERTION" },
  );
});

test("canonical packet and process limits reject invalid integers before loading inputs", async () => {
  for (const flag of ["--max-concurrent-agents", "--batch-size"]) {
    for (const value of ["0", "-1", "1.5", "Infinity", "invalid", "9007199254740992"]) {
      await assert.rejects(
        multiAgentMain([
          "run-canonical",
          "missing-preparation",
          "missing-output",
          "--canonical=missing-cache",
          "--config=missing-config",
          "--allow-model-calls",
          `${flag}=${value}`,
        ]),
        { code: "ERR_ASSERTION" },
      );
    }
  }
});

test("canonical commands cannot change legacy grading weights or request a new reference run", async () => {
  for (const flag of [
    "--build-weight=2",
    "--result-weight=4",
    "--reference-batch-size=100",
    "--agent-lifecycle=per-delivery",
  ]) {
    await assert.rejects(
      multiAgentMain(["run-canonical", "missing-preparation", "missing-output", flag]),
      { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" },
    );
  }
  await assert.rejects(
    multiAgentMain(["verify-canonical", "missing-preparation", "missing-output"]),
    { code: "ERR_ASSERTION" },
  );
});

test("validated canonical preparation options reach the existing workload loader", async () => {
  await assert.rejects(
    multiAgentMain([
      "prepare-canonical",
      "missing-preparation",
      "missing-output",
      "--proof=missing-proof",
      "--agents=2",
    ]),
    (error) => error.code === "ENOENT" && error.path.endsWith("manifest.json"),
  );
});
