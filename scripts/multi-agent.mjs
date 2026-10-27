import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  exportMultiAgentResult,
  validateMultiAgentResult,
} from "../src/suites/explicit-edit-multi-agent/results.mjs";
import { RESTORING_MULTI_AGENT_PROTOCOL } from "../src/suites/explicit-edit-multi-agent/restoring-results.mjs";

const help = `Explicit Edit — Multi-Agent (candidate)

Separate from the existing 226-task benchmark and its Score.

  prepare NEW_OUTPUT [--from-coherent AUDITED_COHERENT_PREPARATION]
  verify PREPARATION NEW_OUTPUT [--agents auto|N] [--batch-size N]
  run PREPARATION NEW_OUTPUT --config PRIVATE_JSON --allow-model-calls [--agents auto|N] [--batch-size N]
  verify-restoring PREPARATION NEW_OUTPUT [--agents auto|N] [--batch-size N] [--build-weight W] [--result-weight W]
  run-restoring PREPARATION NEW_OUTPUT --config PRIVATE_JSON --proof NEW_PROOF --allow-model-calls [--agents auto|N] [--batch-size N] [--build-weight W] [--result-weight W]
  export RUN_DIRECTORY NEW_RESULT_JSON
  validate RESULT_JSON

prepare and verify are model-free but CPU-heavy. Run on Linux x64 with Clang 18.
run starts persistent Baseline Agents (Pi 1.0.1, bash only, empty system prompt).
It requires a matching scripted team proof. It has no default time limits and can
spend model credit indefinitely. Cancel with Ctrl+C; failed edits are retained.
Restoring commands use a separate methodology: partial original-atom round Score,
independent build/output evidence and canonical end-of-current-round restoration.
They keep the same participant processes after passes and six editing failures.
verify-restoring writes a new proof only from clean, committed source. It never
modifies historical preparation proofs. run-restoring requires that exact proof
and a native persistent Baseline Pi 1.3.0 config. It has no delivery deadline.
export creates a safe local result. Nothing uploads or publishes automatically.
See docs/multi-agent.md for prerequisites, private config and result interpretation.
`;

function progressLabel(result) {
  if (result.protocol === RESTORING_MULTI_AGENT_PROTOCOL)
    return `${result.score.final.score.toFixed(3)}% final round Score; ${result.score.first.score.toFixed(3)}% first round Score; ${result.progress.observedRounds}/${result.progress.totalRounds} restored rounds`;
  return `${result.progress.acceptedTasks}/${result.progress.totalTasks} jointly accepted tasks; ${(result.progress.completion * 100).toFixed(2)}%`;
}
/** Run the separate candidate CLI. Imports for generation and execution are lazy:
 * help, export and validation cannot start agents or rebuild the fixture. */
export async function multiAgentMain(args) {
  if (!args.length || args.includes("--help") || args[0] === "help") {
    console.log(help);
    return;
  }
  const [command, ...rest] = args;
  const restoring = ["verify-restoring", "run-restoring"].includes(command);
  const run = command === "run" || command === "run-restoring";
  const restoringOptions = {
    agents: { type: "string", default: "auto" },
    "batch-size": { type: "string" },
    "build-weight": { type: "string" },
    "result-weight": { type: "string" },
  };
  const options = {
    prepare: { "from-coherent": { type: "string" } },
    verify: { agents: { type: "string", default: "auto" }, "batch-size": { type: "string" } },
    run: {
      agents: { type: "string", default: "auto" },
      "batch-size": { type: "string" },
      config: { type: "string" },
      "allow-model-calls": { type: "boolean", default: false },
    },
    "verify-restoring": restoringOptions,
    "run-restoring": {
      ...restoringOptions,
      config: { type: "string" },
      proof: { type: "string" },
      "allow-model-calls": { type: "boolean", default: false },
    },
    export: {},
    validate: {},
  };
  assert.ok(Object.hasOwn(options, command), "Unknown Multi-Agent command; use --help");
  const { values, positionals } = parseArgs({
    args: rest,
    options: options[command],
    allowPositionals: true,
    strict: true,
  });
  assert.equal(
    positionals.length,
    ["prepare", "validate"].includes(command) ? 1 : 2,
    "Wrong positional arguments; use --help",
  );
  if (run) {
    assert.equal(values["allow-model-calls"], true, "Live execution requires --allow-model-calls");
    assert.ok(values.config, "Live execution requires --config PRIVATE_JSON");
    if (restoring) assert.ok(values.proof, "Restoring execution requires --proof NEW_PROOF");
  }
  if (command === "prepare") {
    const { prepareMultiAgent } =
      await import("../src/suites/explicit-edit-multi-agent/prepare.mjs");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      await prepareMultiAgent(positionals[0], {
        coherentProof: values["from-coherent"],
        signal: controller.signal,
      });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  if (command === "export") {
    const result = await exportMultiAgentResult(...positionals);
    console.log(`Exported safe Multi-Agent result: ${positionals[1]}`);
    console.log(
      `${result.status.toUpperCase()}: ${progressLabel(result)}; ${(result.execution.elapsedMs / 60000).toFixed(2)} min`,
    );
    return;
  }
  if (command === "validate") {
    const result = validateMultiAgentResult(JSON.parse(await readFile(positionals[0], "utf8")));
    console.log(`VALID: ${result.benchmark}; ${result.status}; ${progressLabel(result)}`);
    return;
  }
  const agents = values.agents === "auto" ? undefined : Number(values.agents);
  assert.ok(
    agents === undefined || (Number.isSafeInteger(agents) && agents > 0),
    "--agents must be auto or a positive integer",
  );
  const batchSize = values["batch-size"] === undefined ? undefined : Number(values["batch-size"]);
  assert.ok(
    batchSize === undefined || (Number.isSafeInteger(batchSize) && batchSize > 0),
    "--batch-size must be a positive integer",
  );
  const weights = {};
  for (const [flag, field] of [
    ["build-weight", "buildWeight"],
    ["result-weight", "resultWeight"],
  ]) {
    if (values[flag] === undefined) continue;
    const value = Number(values[flag]);
    assert.ok(
      Number.isFinite(value) && value >= 1,
      "Failure weights must be finite and at least one",
    );
    weights[field] = value;
  }
  const execute = restoring
    ? (await import("../src/suites/explicit-edit-multi-agent/execution/restoring-run.mjs"))
        .runRestoring
    : (await import("../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs"))
        .runConcurrent;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await execute(...positionals, {
      agents,
      batchSize,
      configPath: run ? values.config : undefined,
      ...(restoring
        ? {
            ...weights,
            proofPath: values.proof,
            allowModelCalls: values["allow-model-calls"] === true,
          }
        : {}),
      signal: controller.signal,
    });
    console.log(
      `Private evidence retained in ${positionals[1]}; use export to create a safe local result.`,
    );
    process.exitCode = report.status === (restoring ? "complete" : "pass") ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  multiAgentMain(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
