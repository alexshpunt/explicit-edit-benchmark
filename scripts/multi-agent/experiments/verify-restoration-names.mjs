import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import {
  readTree,
  treeIdentity,
  writeTree,
  compactBlankLines,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  referenceNameSteps,
  referenceRoute,
  referenceLayoutSteps,
} from "../../../src/suites/explicit-edit-multi-agent/generation/reference-route.mjs";
import { restorationTargets } from "../../../src/suites/explicit-edit-multi-agent/tasks/restoration-targets.mjs";
import { buildAndRender } from "../../../src/suites/explicit-edit-multi-agent/generation/run.mjs";

/** Verify each atomic reference state with a fresh build and both repeated scenes.
 * Retain sources, pixels and a running report, including the first failing state. This is
 * reference verification only: it does not prove the full independent request workload.
 */
async function verifyRestorationReference(
  generation,
  output,
  phase,
  { compiler = "clang++", log = console.log } = {},
) {
  generation = path.resolve(generation);
  output = path.resolve(output);
  const manifest = JSON.parse(await readFile(path.join(generation, "operations.json"), "utf8"));
  const payload = await readTree(path.join(generation, "payload"));
  const route = referenceRoute(payload, manifest);
  const targets = restorationTargets(manifest);
  const initial =
    phase === "names"
      ? route.stages.findLast((stage) => stage.phase === "structure")?.tree
      : payload;
  if (!initial) throw new Error("Missing reference start");
  const steps = () =>
    phase === "names"
      ? referenceNameSteps(payload, manifest)
      : referenceLayoutSteps(payload, manifest);
  const final =
    phase === "names"
      ? route.final
      : treeIdentity(
          compactBlankLines(
            route.stages.findLast(
              (stage) =>
                stage.phase === "structure" && Object.keys(stage.tree).join() === "main.cpp",
            ).tree,
          ).tree,
        );
  let expectedTransitions = phase === "names" ? targets.naming.length + targets.helpers.length : 0;
  if (phase === "layout")
    for (const step of steps()) {
      if (!step.target) throw new Error("Missing layout target");
      expectedTransitions++;
    }
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const report = {
    version: `renderer-atomic-${phase}-reference-v1`,
    status: "running",
    initial: treeIdentity(initial),
    final,
    expectedTransitions,
    coverage: targets.counts,
    checks: [],
  };
  const save = () =>
    writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  let golden;
  async function check(tree, target, category) {
    const index = report.checks.length;
    const directory = path.join(output, String(index).padStart(4, "0"));
    await mkdir(directory);
    await writeTree(path.join(directory, "source"), tree);
    const item = { index, target, category, identity: treeIdentity(tree), status: "running" };
    report.checks.push(item);
    await save();
    log(`BUILD ${phase}/${index}: ${target}`);
    const pixels = await buildAndRender(
      path.join(directory, "source"),
      path.join(directory, "build"),
      tree,
      compiler,
    );
    golden ??= pixels;
    if (JSON.stringify(pixels) !== JSON.stringify(golden))
      throw new Error("Atomic reference changed rendered pixels");
    Object.assign(item, { status: "pass", pixels });
    await save();
    await rm(path.join(directory, "build/renderer"));
    log(`PASS ${phase}/${index}: fresh build, two exact scenes, repeat render`);
  }
  try {
    await check(initial, phase === "names" ? "structure-complete" : "monolith", "initial");
    for (const step of steps()) await check(step.tree, step.target, step.category ?? step.action);
    if (
      report.checks.length !== report.expectedTransitions + 1 ||
      report.checks.at(-1).identity !== report.final
    )
      throw new Error("Incomplete atomic reference route");
    report.status = "pass";
    await save();
    log(
      `VERIFIED ${phase.toUpperCase()} REFERENCE: ${report.expectedTransitions} transitions; full workload E2E not yet verified`,
    );
    return report;
  } catch (error) {
    report.status = "fail";
    const latest = report.checks.at(-1);
    if (latest?.status === "running") latest.status = "fail";
    report.error = error.message;
    await save();
    throw error;
  }
}

/** Verify all owner/family naming transitions from a structure-complete reference start. */
export function verifyRestorationNames(generation, output, options) {
  return verifyRestorationReference(generation, output, "names", options);
}

/** Verify every two-definition swap and individual generated-prototype cleanup transition. */
export function verifyRestorationLayout(generation, output, options) {
  return verifyRestorationReference(generation, output, "layout", options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const layout = args.length === 3 && args[0] === "layout";
  const inputs = layout ? args.slice(1) : args;
  if (inputs.length !== 2) {
    console.error(
      "Usage: node scripts/multi-agent/experiments/verify-restoration-names.mjs [layout] GENERATION OUTPUT",
    );
    process.exitCode = 1;
  } else {
    const verify = layout ? verifyRestorationLayout : verifyRestorationNames;
    verify(inputs[0], inputs[1]).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
