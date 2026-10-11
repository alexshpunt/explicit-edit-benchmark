import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  exportMultiAgentResult,
  validateMultiAgentResult,
} from "../src/suites/explicit-edit-multi-agent/results.mjs";

const help = `Explicit Edit — Multi-Agent (candidate)

Separate from the existing 226-task benchmark and its Score.

  prepare NEW_OUTPUT [--from-coherent AUDITED_COHERENT_PREPARATION]
  verify PREPARATION NEW_OUTPUT [--agents auto|N]
  run PREPARATION NEW_OUTPUT --config PRIVATE_JSON --allow-model-calls [--agents auto|N]
  export RUN_DIRECTORY NEW_RESULT_JSON
  validate RESULT_JSON

prepare and verify are model-free but CPU-heavy. Run on Linux x64 with Clang 18.
run starts persistent Baseline Agents (Pi 1.0.1, bash only, empty system prompt).
It requires a matching scripted team proof. It has no default time limits and can
spend model credit indefinitely. Cancel with Ctrl+C; failed edits are retained.
export creates a safe local result. Nothing uploads or publishes automatically.
See docs/multi-agent.md for prerequisites, private config and result interpretation.
`;

/** Run the separate candidate CLI. Imports for generation and execution are lazy:
 * help, export and validation cannot start agents or rebuild the fixture. */
export async function multiAgentMain(args) {
  if (!args.length || args.includes("--help") || args[0] === "help") {
    console.log(help);
    return;
  }
  const [command, ...rest] = args;
  const options = {
    prepare: { "from-coherent": { type: "string" } },
    verify: { agents: { type: "string", default: "auto" } },
    run: {
      agents: { type: "string", default: "auto" },
      config: { type: "string" },
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
  if (command === "run") {
    assert.equal(values["allow-model-calls"], true, "Live execution requires --allow-model-calls");
    assert.ok(values.config, "Live execution requires --config PRIVATE_JSON");
  }
  if (command === "prepare") {
    const { prepareMultiAgent } =
      await import("../src/suites/explicit-edit-multi-agent/prepare.mjs");
    await prepareMultiAgent(positionals[0], { coherentProof: values["from-coherent"] });
    return;
  }
  if (command === "export") {
    const result = await exportMultiAgentResult(...positionals);
    console.log(`Exported safe Multi-Agent result: ${positionals[1]}`);
    console.log(
      `${result.status.toUpperCase()}: ${result.progress.acceptedTasks}/${result.progress.totalTasks} jointly accepted tasks; ${(result.progress.completion * 100).toFixed(2)}%; ${(result.execution.elapsedMs / 60000).toFixed(2)} min`,
    );
    return;
  }
  if (command === "validate") {
    const result = validateMultiAgentResult(JSON.parse(await readFile(positionals[0], "utf8")));
    console.log(
      `VALID: ${result.benchmark}; ${result.status}; ${result.progress.acceptedTasks}/${result.progress.totalTasks} tasks`,
    );
    return;
  }
  const agents = values.agents === "auto" ? undefined : Number(values.agents);
  assert.ok(
    agents === undefined || (Number.isSafeInteger(agents) && agents > 0),
    "--agents must be auto or a positive integer",
  );
  const { runConcurrent } =
    await import("../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await runConcurrent(...positionals, {
      agents,
      configPath: command === "run" ? values.config : undefined,
      signal: controller.signal,
    });
    console.log(
      `Private evidence retained in ${positionals[1]}; use export to create a safe local result.`,
    );
    process.exitCode = report.status === "pass" ? 0 : 1;
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
