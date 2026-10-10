import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTree,
  treeIdentity,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { resolveObligations } from "./atomic-slice.mjs";
import { inspectCandidate } from "./candidate-grader.mjs";
import { GradeFailure } from "../../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import { createSliceContract, assertCandidateObligations } from "./candidate-obligations.mjs";

/** Grade every trusted slice state and a byte-different scripted final state.
 * Expected source trees are inputs to this proof only: the grader derives its
 * contract from the initial compiler inventory and never mounts reference answers.
 * Each check builds from scratch and renders both scenes twice in isolation.
 */
export async function verifyGrader(slice, alternative, output, { signal, log = console.log } = {}) {
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const report = { version: "renderer-grader-proof-v1", status: "running", checks: [] };
  const save = () =>
    writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await save();
  try {
    const workload = JSON.parse(await readFile(path.join(slice, "trusted/workload.json"), "utf8"));
    assert.equal(workload.version, "renderer-atomic-slice-v2");
    assert.equal(workload.steps.length, 11);
    const obligations = resolveObligations(workload.steps);
    assert.deepEqual(workload.obligations, obligations);
    const initialPath = path.join(slice, "workspace");
    const initial = await readTree(initialPath);
    assert.equal(treeIdentity(initial), workload.initial);
    log("GRADE initial: fresh compiler inventory and repeated scenes");
    const inspection = await inspectCandidate(initialPath, path.join(output, "initial"), {
      signal,
    });
    const contract = createSliceContract(initial, inspection);
    assertCandidateObligations(inspection, {}, contract);
    report.checks.push({ id: "initial", status: "pass", pixels: inspection.pixels });
    await save();
    log("PASS initial");
    for (const [index, step] of workload.steps.entries()) {
      assert.match(step.id, /^step-\d{2}$/);
      log(`GRADE ${step.id}: trusted state, cumulative obligations`);
      const workspace = path.join(slice, "trusted/states", step.id, "source");
      const current = await inspectCandidate(workspace, path.join(output, step.id), { signal });
      assertCandidateObligations(current, obligations[index], contract);
      report.checks.push({ id: step.id, status: "pass", pixels: current.pixels });
      await save();
      log(`PASS ${step.id}`);
    }
    const last = path.join(slice, "trusted/states", workload.steps.at(-1).id, "source");
    assert.notEqual(treeIdentity(await readTree(alternative)), treeIdentity(await readTree(last)));
    log("GRADE alternative: byte-different final workspace");
    const current = await inspectCandidate(alternative, path.join(output, "alternative"), {
      signal,
    });
    assertCandidateObligations(current, obligations.at(-1), contract);
    report.checks.push({ id: "alternative", status: "pass", pixels: current.pixels });
    report.status = "pass";
    await save();
    log(
      `VERIFIED GRADER: ${report.checks.length} isolated states; all reference requests and a byte-different solution`,
    );
  } catch (error) {
    report.status = signal?.aborted ? "cancelled" : "fail";
    report.failure = {
      category: error instanceof GradeFailure ? error.category : "infrastructure",
      message: error.message,
    };
    await save();
    log(`${report.status.toUpperCase()}: ${report.failure.message}`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3)
      throw new Error(
        "Usage: node scripts/multi-agent/experiments/verify-grader.mjs SLICE ALTERNATIVE_SOURCE NEW_OUTPUT",
      );
    const report = await verifyGrader(...args, { signal: controller.signal });
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
