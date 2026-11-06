import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const help = `Experimental paired-module extraction

  prepare PREPARATION NEW_CASE --modules module_stem[,other_stem] --generation GENERATION [--agents N]
  verify CASE NEW_RUN
  run CASE NEW_RUN --config PRIVATE_JSON --proof REFERENCE_RUN/verification.json --allow-model-calls
  debug CASE NEW_RUN --config PRIVATE_JSON --proof REFERENCE_RUN/verification.json --allow-model-calls [--task TASK_ID]
  flat-prepare PARENT_CASE NEW_CASE
  flat-verify FLAT_CASE NEW_RUN
  flat-run FLAT_CASE NEW_RUN --config PRIVATE_JSON --proof REFERENCE_RUN/verification.json --allow-model-calls
  flat-debug FLAT_CASE NEW_RUN --config PRIVATE_JSON --proof REFERENCE_RUN/verification.json --allow-model-calls --task TASK_ID
  chunk-verify FLAT_CASE NEW_RUN
  chunk-smoke NEW_OUTPUT --config PRIVATE_JSON --allow-model-calls
  chunk-run FLAT_CASE NEW_RUN --config PRIVATE_JSON --proof REFERENCE_RUN/summary.json --allow-model-calls
  chunk-rescore FLAT_CASE SAVED_RUN NEW_OUTPUT
  assembly-verify FLAT_CASE NEW_RUN
  assembly-run FLAT_CASE NEW_RUN --config PRIVATE_JSON --proof REFERENCE_RUN/summary.json --allow-model-calls
  assembly-probe FLAT_CASE NEW_RUN [--deliveries N] [--regions FILE[,FILE]] (--scripted | --config PRIVATE_JSON --allow-model-calls)

Each selected module must have both an original .h and .cpp. Each file is one
complete assignment. Required header-only and vendor dependencies are additional
whole-file assignments, never pre-extracted from the initial monolith.
Fresh cases remove outer project-header guards through generation replay. Own
headers require #pragma once as their first non-empty line, not an include guard.
One to ten participants start together, with fixed ownership of their file tasks.
prepare and verify are model-free. verify uses isolated scripted participants,
then structural assessment, compilation and one renderer process on build success.
Score reuses the canonical structural credit and build/result factors. Recovery is
bounded to one structural wave, one build agent/attempt and one image agent/attempt.
Model execution requires a fresh version 5 explicit-contract case and a matching
clean-source reference proof. It spends model credit and requires explicit approval.
Earlier assignment contracts cannot authorize model execution.
After all original queues finish, structural recovery retains their live contexts.
Model tasks and repairs run one at a time with refreshed checks. Build and image
corrections use fresh isolated contexts. Closed saved
runs cannot resume their original contexts. There is no source reset or publication.
The debug command uses a clean project and new participant for every task. It
first verifies each selected task with a scripted reference. Its individual
structural assessments are diagnostic only: no benchmark score, build or render.
Inspect each completed debug task before starting the next.
Before each delivery batch, inspect the displayed snapshot and report. Enter
'approve <inspection number> <candidate hash>' to proceed, or interrupt to stop.
Chunk commands run ten-agent teams over small fragment assignments with a
120-second limit per delivery, then at most one structural, one build and one
result correction. Score counts structural unit differences from the trusted
start; see docs/module-extraction.md. chunk-verify is the scripted reference and
must report Score 100 from clean committed source. chunk-smoke spends one small
model delivery. chunk-rescore recomputes a saved run without participants.
Assembly commands run the two-phase observation: twenty fresh agents, each with a
300-second limit, move units into regions of main.cpp, new agents move each
region into its file, then the
common corrections run once and one structural unit score is computed.
assembly-verify is the scripted reference and must report Score 100 from clean
committed source. assembly-probe runs the first assembly deliveries of the queue
and/or the extraction of chosen regions, compares the result with the scripted
outcome of the same assignments and reports no observation score.
Use fresh ignored output directories and the shared renderer lock on a capable worker.
See docs/multi-agent.md for shared renderer prerequisites.
`;

async function chunkCommand(values, positionals) {
  const [command, ...paths] = positionals;
  const modelCommand = ["chunk-smoke", "chunk-run"].includes(command);
  const count = { "chunk-verify": 2, "chunk-smoke": 1, "chunk-run": 2, "chunk-rescore": 3 }[
    command
  ];
  assert.ok(count !== undefined && paths.length === count, help);
  for (const option of ["modules", "generation", "agents", "task", "from-run", "source-receipt"])
    assert.equal(values[option], undefined, help);
  if (modelCommand) {
    assert.equal(
      values["allow-model-calls"],
      true,
      "Model calls require explicit --allow-model-calls",
    );
    assert.equal(typeof values.config, "string", help);
  } else assert.ok(!values.config && !values["allow-model-calls"], help);
  assert.equal(typeof values.proof === "string", command === "chunk-run", help);
  const chunk = await import("../src/suites/explicit-edit-multi-agent/extraction/chunk-run.mjs");
  const config = modelCommand ? JSON.parse(await readFile(values.config, "utf8")) : null;
  const signal = controller.signal;
  if (command === "chunk-verify") {
    const summary = await chunk.verifyChunkCase(paths[0], paths[1], { signal });
    console.log(JSON.stringify(summary));
    if (summary.status !== "pass") process.exitCode = 1;
  } else if (command === "chunk-smoke") {
    console.log(JSON.stringify(await chunk.chunkModelSmoke(paths[0], config)));
  } else if (command === "chunk-run") {
    const report = await chunk.runChunkModel(paths[0], paths[1], config, {
      proofPath: values.proof,
      signal,
    });
    console.log(
      JSON.stringify({
        status: report.status,
        totalUnits: report.totalUnits,
        initialDifferences: report.score.structural.initialDifferences.length,
        finalDifferences: report.score.structural.finalDifferences.length,
        score: report.score.score,
      }),
    );
  } else {
    const result = await chunk.rescoreChunkRun(paths[0], paths[1], paths[2], { signal });
    console.log(
      JSON.stringify({
        totalUnits: result.score.structural.totalUnits,
        initialDifferences: result.score.structural.initialDifferences.length,
        finalDifferences: result.score.structural.finalDifferences.length,
        rawBalance: result.score.structural.rawBalance,
        buildFactor: result.score.build.factor,
        imageFactor: result.score.images.factor,
        score: result.score.score,
      }),
    );
  }
}

async function assemblyCommand(values, positionals) {
  const [command, ...paths] = positionals;
  assert.ok(["assembly-verify", "assembly-run", "assembly-probe"].includes(command), help);
  assert.equal(paths.length, 2, help);
  for (const option of ["modules", "generation", "agents", "task", "from-run", "source-receipt"])
    assert.equal(values[option], undefined, help);
  const probe = command === "assembly-probe";
  if (!probe) assert.ok(!values.deliveries && !values.regions && !values.scripted, help);
  const modelCommand = command === "assembly-run" || (probe && !values.scripted);
  if (modelCommand) {
    assert.equal(
      values["allow-model-calls"],
      true,
      "Model calls require explicit --allow-model-calls",
    );
    assert.equal(typeof values.config, "string", help);
  } else assert.ok(!values.config && !values["allow-model-calls"], help);
  assert.equal(typeof values.proof === "string", command === "assembly-run", help);
  const assembly =
    await import("../src/suites/explicit-edit-multi-agent/extraction/assembly-run.mjs");
  const config = modelCommand ? JSON.parse(await readFile(values.config, "utf8")) : null;
  const signal = controller.signal;
  if (command === "assembly-verify") {
    const summary = await assembly.verifyAssemblyCase(paths[0], paths[1], { signal });
    console.log(JSON.stringify(summary));
    if (summary.status !== "pass") process.exitCode = 1;
    return;
  }
  const report = probe
    ? await assembly.probeAssembly(paths[0], paths[1], config, {
        deliveries: values.deliveries === undefined ? 0 : Number(values.deliveries),
        regions: values.regions ? values.regions.split(",") : [],
        scripted: values.scripted === true,
        signal,
      })
    : await assembly.runAssemblyModel(paths[0], paths[1], config, {
        proofPath: values.proof,
        signal,
      });
  const final = report.stages.at(-1);
  console.log(
    JSON.stringify({
      status: report.status,
      kind: report.kind,
      totalUnits: report.totalUnits,
      deliveries: report.deliveries.length,
      timedOut: report.deliveries.filter((row) => row.status === "timed-out").length,
      remainingMarkers: report.remainingMarkers,
      differences: final.structure.differenceIds.length,
      score: report.score?.score ?? null,
    }),
  );
}

const controller = new AbortController();
const stop = (signal) => {
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  controller.abort(
    Object.assign(new Error(`Extraction cancelled by ${signal}`), { code: "RUN_CANCELLED" }),
  );
};
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      modules: { type: "string" },
      generation: { type: "string" },
      agents: { type: "string" },
      config: { type: "string" },
      proof: { type: "string" },
      task: { type: "string" },
      "from-run": { type: "string" },
      "source-receipt": { type: "string" },
      "allow-model-calls": { type: "boolean" },
      deliveries: { type: "string" },
      regions: { type: "string" },
      scripted: { type: "boolean" },
    },
  });
  if (values.help) console.log(help);
  else if (positionals[0]?.startsWith("chunk-")) await chunkCommand(values, positionals);
  else if (positionals[0]?.startsWith("assembly-")) await assemblyCommand(values, positionals);
  else {
    const [command, input, output] = positionals;
    assert.equal(positionals.length, 3, help);
    assert.ok(
      [
        "prepare",
        "verify",
        "run",
        "recover",
        "debug",
        "flat-prepare",
        "flat-verify",
        "flat-run",
        "flat-debug",
      ].includes(command),
      help,
    );
    if (!["debug", "flat-debug"].includes(command)) assert.equal(values.task, undefined, help);
    if (command === "flat-debug") assert.equal(typeof values.task, "string", help);
    if (command !== "recover") assert.ok(!values["from-run"] && !values["source-receipt"], help);
    if (!["run", "recover", "debug", "flat-debug", "flat-run"].includes(command))
      assert.ok(!values.config && !values.proof && !values["allow-model-calls"], help);
    if (command !== "prepare")
      for (const option of ["modules", "generation", "agents"])
        assert.equal(values[option], undefined, help);
    if (command === "prepare") {
      assert.equal(typeof values.modules, "string", help);
      assert.equal(typeof values.generation, "string", help);
      if (values.agents !== undefined) assert.match(values.agents, /^\d+$/, help);
      const { prepareExtraction } =
        await import("../src/suites/explicit-edit-multi-agent/extraction/prepare.mjs");
      const manifest = await prepareExtraction(input, output, {
        modules: values.modules.split(","),
        generation: values.generation,
        agents: values.agents === undefined ? undefined : Number(values.agents),
      });
      console.log(
        JSON.stringify({
          version: manifest.version,
          modules: manifest.modules,
          agents: manifest.agents,
          files: manifest.files,
          initial: manifest.initial,
        }),
      );
    } else if (command === "flat-prepare") {
      const { prepareFlatCase } =
        await import("../src/suites/explicit-edit-multi-agent/extraction/flat-case.mjs");
      const manifest = await prepareFlatCase(input, output);
      console.log(
        JSON.stringify({
          version: manifest.version,
          files: manifest.files,
          initial: manifest.initial,
        }),
      );
    } else if (command === "flat-verify") {
      const { verifyFlatCase } =
        await import("../src/suites/explicit-edit-multi-agent/extraction/flat-proof.mjs");
      const proof = await verifyFlatCase(input, output, { signal: controller.signal });
      console.log(
        JSON.stringify({ status: proof.status, cleanSource: proof.sourceIdentity.sourceClean }),
      );
    } else if (command === "verify") {
      const { verifyExtraction } =
        await import("../src/suites/explicit-edit-multi-agent/extraction/case.mjs");
      const proof = await verifyExtraction(input, output, { signal: controller.signal });
      console.log(
        JSON.stringify({
          status: proof.status,
          kind: proof.kind,
          cleanSource: proof.sourceIdentity.sourceClean,
        }),
      );
      if (proof.status !== "pass") process.exitCode = 1;
    } else {
      assert.equal(
        values["allow-model-calls"],
        true,
        "Model calls require explicit --allow-model-calls",
      );
      assert.equal(typeof values.config, "string", help);
      assert.equal(typeof values.proof, "string", help);
      if (command === "recover")
        throw Object.assign(
          new Error(
            "Saved-run recovery cannot retain the original live contexts; start a separately authorized whole-file run instead",
          ),
          { code: "EXTRACTION_LIVE_CONTEXT_REQUIRED" },
        );
      const config = JSON.parse(await readFile(values.config, "utf8"));
      const {
        runModelExtraction,
        runModelIsolatedExtraction,
        runModelFlatExtraction,
        runModelFlatSequence,
      } = await import("../src/suites/explicit-edit-multi-agent/extraction/case.mjs");
      const { createTerminalInspector } =
        await import("../src/suites/explicit-edit-multi-agent/extraction/terminal-inspection.mjs");
      const inspect = createTerminalInspector();
      let report;
      try {
        report = await (
          command === "flat-run"
            ? runModelFlatSequence
            : command === "flat-debug"
              ? runModelFlatExtraction
              : command === "debug"
                ? runModelIsolatedExtraction
                : runModelExtraction
        )(input, output, config, {
          proofPath: values.proof,
          signal: controller.signal,
          inspect,
          ...(["debug", "flat-debug"].includes(command) ? { taskId: values.task } : {}),
        });
      } finally {
        inspect.close();
      }
      if (command === "flat-run") {
        console.log(
          JSON.stringify({
            status: report.status,
            agents: report.agents,
            rounds: report.rounds.map(({ id, structure }) => ({ id, status: structure.status })),
            buildPassed: report.integration?.buildPassed ?? false,
            resultMatched: report.integration?.resultMatched ?? false,
          }),
        );
        if (!report.passed) process.exitCode = 1;
      } else if (["debug", "flat-debug"].includes(command)) {
        console.log(
          JSON.stringify({
            status: report.status,
            kind: report.kind,
            tasks: report.tasks.map(({ id, structure }) => ({ id, status: structure.status })),
          }),
        );
        if (!report.passed) process.exitCode = 1;
      } else {
        console.log(
          JSON.stringify({
            status: report.status,
            strictPreservation: report.extraction.status,
            structure: report.structure.status,
            firstScore: report.first.score.score,
            score: report.score.score,
            buildPassed: report.integration.buildPassed,
            resultMatched: report.integration.resultMatched,
          }),
        );
        if (!report.passed) process.exitCode = 1;
      }
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode ??= 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
