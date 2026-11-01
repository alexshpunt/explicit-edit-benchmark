import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const help = `Experimental paired-module extraction

  prepare PREPARATION NEW_CASE --modules module_stem[,other_stem] --generation GENERATION [--agents N]
  verify CASE NEW_RUN
  run CASE NEW_RUN --config PRIVATE_JSON --proof REFERENCE_RUN/verification.json --allow-model-calls

Each selected module must have both an original .h and .cpp. Each file is one
complete assignment. Required header-only and vendor dependencies are additional
whole-file assignments, never pre-extracted from the initial monolith.
One to ten participants start together, with fixed ownership of their file tasks.
prepare and verify are model-free. verify uses isolated scripted participants,
then one final compilation attempt and one renderer process on success.
run spends model credit and requires a matching reference proof from clean source.
There are no repair waves, source restoration, Score weights or result publication.
Use fresh ignored output directories and the shared renderer lock on a capable worker.
See docs/multi-agent.md for shared renderer prerequisites.
`;

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
      "allow-model-calls": { type: "boolean" },
    },
  });
  if (values.help) console.log(help);
  else {
    const [command, input, output] = positionals;
    assert.equal(positionals.length, 3, help);
    assert.ok(["prepare", "verify", "run"].includes(command), help);
    if (command !== "run")
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
      const config = JSON.parse(await readFile(values.config, "utf8"));
      const { runModelExtraction } =
        await import("../src/suites/explicit-edit-multi-agent/extraction/case.mjs");
      const report = await runModelExtraction(input, output, config, {
        proofPath: values.proof,
        signal: controller.signal,
      });
      console.log(
        JSON.stringify({
          status: report.status,
          extraction: report.extraction.status,
          buildPassed: report.integration.buildPassed,
          resultMatched: report.integration.resultMatched,
        }),
      );
      if (
        report.extraction.status !== "pass" ||
        !report.integration.buildPassed ||
        !report.integration.resultMatched
      )
        process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode ??= 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
