import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
  verify-restoring PREPARATION NEW_OUTPUT [--agents auto|N] [--batch-size N] [--reference-batch-size N] [--build-weight W] [--result-weight W]
  run-restoring PREPARATION NEW_OUTPUT --config PRIVATE_JSON --proof NEW_PROOF --allow-model-calls [--agents auto|N] [--batch-size N] [--build-weight W] [--result-weight W] [--agent-lifecycle persistent|per-delivery] [--max-concurrent-agents N]
  prepare-canonical PREPARATION NEW_CACHE --proof RETAINED_PROOF [--agents auto|N] [--trusted-endpoints PRIVATE_JSON]
  run-canonical PREPARATION NEW_OUTPUT --canonical CACHE --config PRIVATE_JSON --allow-model-calls [--agents auto|N] [--batch-size N] [--max-concurrent-agents N] [--from-round N]
  export-canonical RUN_DIRECTORY NEW_RESULT_JSON
  validate-canonical RESULT_JSON
  inspect-canonical RUN_DIRECTORY
  export RUN_DIRECTORY NEW_RESULT_JSON
  validate RESULT_JSON

prepare and verify are model-free but CPU-heavy. Run on Linux x64 with Clang 18.
run starts persistent Baseline Agents (Pi 1.0.1, bash only, empty system prompt).
It requires a matching scripted team proof. It has no default time limits and can
spend model credit indefinitely. Cancel with Ctrl+C; failed edits are retained.
Restoring commands use a separate methodology: partial original-atom round Score,
independent build/output evidence and canonical end-of-current-round restoration.
The default persistent mode keeps participant processes between packets and rounds.
--agent-lifecycle per-delivery gives every original packet a fresh agent; recovery
may continue a round-local context. --max-concurrent-agents limits live workers
independently of --agents, which still selects the graph schedule.
verify-restoring writes a new proof only from clean, committed source. It never
modifies historical preparation proofs. Unconfigured persistent runs require an
exact proof; explicit lifecycle/concurrency profiles can validate retained
restoring workload-feasibility evidence.
Both modes require native Baseline Pi 1.3.0 and have no delivery deadline.
--batch-size binds the measured delivery policy. verify-restoring alone accepts
--reference-batch-size for scripted deliveries; it defaults to --batch-size.
For 15 agents delivering 10 edits, reference verification may batch 100 edits:
  verify-restoring PREPARATION PROOF_OUTPUT --agents 15 --batch-size 10 --reference-batch-size 100
  run-restoring PREPARATION RUN_OUTPUT --agents 15 --batch-size 10 --config PRIVATE_JSON --proof PROOF_OUTPUT/verification.json --allow-model-calls
Canonical commands use full-project fixed-hunk scoring and round-ready agent pools.
prepare-canonical caches trusted endpoints from retained feasibility evidence; it
never executes a new reference. run-canonical closes all namespaces before grading
and permits one structural, one build and one image correction. Its default live
native process cap is 30, separate from the original graph schedule's --agents.
Canonical results remain separate from historical scores. inspect-canonical reads
a terminal run without publishing it. See docs/renderer-canonical-diff.md.
export creates a safe local result. Nothing uploads or publishes automatically.
See docs/multi-agent.md for prerequisites, private config and result interpretation.
`;

async function canonicalCommand(command, values, positionals) {
  if (["export-canonical", "validate-canonical", "inspect-canonical"].includes(command)) {
    const { canonicalMultiAgentResult, validateCanonicalResult } =
      await import("../src/suites/explicit-edit-multi-agent/canonical-results.mjs");
    const file =
      command === "validate-canonical" ? positionals[0] : path.join(positionals[0], "report.json");
    const value = JSON.parse(await readFile(file, "utf8"));
    const result = command === "validate-canonical" ? value : canonicalMultiAgentResult(value);
    validateCanonicalResult(result);
    if (command === "export-canonical")
      await writeFile(positionals[1], JSON.stringify(result, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    console.log(
      `${result.status.toUpperCase()}: ${result.score.score.toFixed(3)}% ${result.status === "complete" ? "final canonical Score" : "partial canonical aggregate"}; ${result.score.firstStructuralScore.toFixed(3)}% first structural Score`,
    );
    return;
  }
  const positive = (name) => {
    if (values[name] === undefined) return undefined;
    const value = Number(values[name]);
    assert.ok(
      Number.isSafeInteger(value) && value > 0,
      "Canonical numeric options must be positive safe integers",
    );
    return value;
  };
  const agents = values.agents === "auto" ? undefined : positive("agents");
  const batchSize = positive("batch-size");
  const maxConcurrentAgents = positive("max-concurrent-agents");
  if (command === "prepare-canonical")
    assert.ok(values.proof, "Canonical preparation requires retained feasibility evidence");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (command === "prepare-canonical") {
      const { prepareCanonical } =
        await import("../src/suites/explicit-edit-multi-agent/execution/canonical-preparation.mjs");
      const manifest = await prepareCanonical(...positionals, {
        agents,
        proofPath: values.proof,
        trustedEndpoints: values["trusted-endpoints"]
          ? JSON.parse(await readFile(values["trusted-endpoints"], "utf8"))
          : undefined,
        signal: controller.signal,
      });
      console.log(
        `Prepared ${manifest.rounds.length} canonical rounds; ${manifest.rounds.reduce((sum, row) => sum + row.totalHunks, 0)} reference hunks`,
      );
    } else if (command === "verify-canonical") {
      const { verifyCanonical } =
        await import("../src/suites/explicit-edit-multi-agent/execution/canonical-run.mjs");
      const summary = await verifyCanonical(...positionals, {
        canonicalPath: values.canonical,
        agents,
        batchSize,
        maxConcurrentAgents,
        signal: controller.signal,
        log: () => {},
      });
      console.log(JSON.stringify(summary));
      if (summary.status !== "pass") process.exitCode = 1;
    } else {
      const { runCanonical } =
        await import("../src/suites/explicit-edit-multi-agent/execution/canonical-run.mjs");
      const report = await runCanonical(...positionals, {
        canonicalPath: values.canonical,
        agents,
        batchSize,
        maxConcurrentAgents,
        fromRound: positive("from-round"),
        configPath: values.config,
        referenceProofPath: values.proof,
        allowModelCalls: values["allow-model-calls"],
        signal: controller.signal,
      });
      console.log(
        `${report.status.toUpperCase()}: ${report.score.score.toFixed(3)}% ${report.mode === "diagnostic-continuation" ? "diagnostic partial aggregate" : report.status === "complete" ? "canonical Score" : "partial canonical aggregate"}; ${report.rounds.length}/${report.plan.length} measured rounds`,
      );
      if (report.status !== "complete") process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
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
  const run = ["run", "run-restoring", "run-canonical"].includes(command);
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
    "verify-restoring": {
      ...restoringOptions,
      "reference-batch-size": { type: "string" },
    },
    "run-restoring": {
      ...restoringOptions,
      "agent-lifecycle": { type: "string" },
      "max-concurrent-agents": { type: "string" },
      config: { type: "string" },
      proof: { type: "string" },
      "allow-model-calls": { type: "boolean", default: false },
    },
    "prepare-canonical": {
      agents: { type: "string", default: "auto" },
      proof: { type: "string" },
      "trusted-endpoints": { type: "string" },
    },
    "verify-canonical": {
      agents: { type: "string", default: "auto" },
      "batch-size": { type: "string" },
      "max-concurrent-agents": { type: "string" },
      canonical: { type: "string" },
    },
    "run-canonical": {
      agents: { type: "string", default: "auto" },
      "batch-size": { type: "string" },
      "max-concurrent-agents": { type: "string" },
      "from-round": { type: "string" },
      canonical: { type: "string" },
      config: { type: "string" },
      proof: { type: "string" },
      "allow-model-calls": { type: "boolean", default: false },
    },
    "export-canonical": {},
    "validate-canonical": {},
    "inspect-canonical": {},
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
    ["prepare", "validate", "validate-canonical", "inspect-canonical"].includes(command) ? 1 : 2,
    "Wrong positional arguments; use --help",
  );
  if (run) {
    assert.equal(values["allow-model-calls"], true, "Live execution requires --allow-model-calls");
    assert.ok(values.config, "Live execution requires --config PRIVATE_JSON");
    if (restoring) assert.ok(values.proof, "Restoring execution requires --proof NEW_PROOF");
    if (command === "run-canonical") {
      assert.ok(values.canonical, "Canonical execution requires --canonical CACHE");
      assert.ok(values.proof, "Canonical execution requires --proof REFERENCE/summary.json");
    }
  }
  if (command === "verify-canonical")
    assert.ok(values.canonical, "Canonical verification requires --canonical CACHE");
  if (command.endsWith("-canonical")) {
    await canonicalCommand(command, values, positionals);
    return;
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
  const referenceBatchSize =
    values["reference-batch-size"] === undefined
      ? undefined
      : Number(values["reference-batch-size"]);
  assert.ok(
    referenceBatchSize === undefined ||
      (Number.isSafeInteger(referenceBatchSize) && referenceBatchSize > 0),
    "--reference-batch-size must be a positive integer",
  );
  const agentLifecycle = values["agent-lifecycle"];
  assert.ok(
    agentLifecycle === undefined || ["persistent", "per-delivery"].includes(agentLifecycle),
    "--agent-lifecycle must be persistent or per-delivery",
  );
  const maxConcurrentAgents =
    values["max-concurrent-agents"] === undefined
      ? undefined
      : Number(values["max-concurrent-agents"]);
  assert.ok(
    maxConcurrentAgents === undefined ||
      (Number.isSafeInteger(maxConcurrentAgents) && maxConcurrentAgents > 0),
    "--max-concurrent-agents must be a positive integer",
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
            ...(command === "run-restoring" ? { agentLifecycle, maxConcurrentAgents } : {}),
            ...(command === "verify-restoring" ? { referenceBatchSize } : {}),
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
