import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { treeIdentity } from "../generation/generator.mjs";
import { projectCpuSource } from "./cpu-projection.mjs";
import { prepareFlatExtractionPlan } from "./flat-plan.mjs";
import { loadExtraction } from "./prepare.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** Create a separate local CPU case without modifying its authenticated parent. */
export async function prepareFlatCase(parentPath, outputPath) {
  const parent = path.resolve(parentPath);
  const { manifest: parentManifest, plan: parentPlan } = await loadExtraction(parent);
  assert.equal(parentManifest.version, "renderer-module-extraction-v5");
  const projection = projectCpuSource(parentPlan.initial["main.cpp"]);
  const plan = prepareFlatExtractionPlan(parentPlan, projection.lines);
  const planBytes = JSON.stringify(plan) + "\n";
  const manifest = {
    version: "renderer-flat-extraction-case-v1",
    parentPlanSha256: parentManifest.planSha256,
    planSha256: hash(planBytes),
    compiler: projection.compiler,
    flags: projection.flags,
    initial: plan.initialIdentity,
    expected: treeIdentity(plan.expected),
    pixels: parentManifest.pixels,
    files: plan.tasks.map(({ id, file }) => ({ id, file })),
  };
  const parentBytes = await Promise.all(
    ["manifest.json", "plan.json"].map((name) => readFile(path.join(parent, name))),
  );
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  await mkdir(path.join(output, "parent"), { mode: 0o700 });
  await Promise.all(
    parentBytes.map((bytes, index) =>
      writeFile(path.join(output, "parent", ["manifest.json", "plan.json"][index]), bytes, {
        flag: "wx",
        mode: 0o600,
      }),
    ),
  );
  await writeFile(path.join(output, "plan.json"), planBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

/** Re-run the compiler projection and original provenance reconstruction on load. */
export async function loadFlatCase(preparedPath) {
  const root = path.resolve(preparedPath);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "renderer-flat-extraction-case-v1");
  const { manifest: parentManifest, plan: parentPlan } = await loadExtraction(
    path.join(root, "parent"),
  );
  assert.equal(parentManifest.version, "renderer-module-extraction-v5");
  assert.equal(parentManifest.planSha256, manifest.parentPlanSha256);
  const projection = projectCpuSource(parentPlan.initial["main.cpp"]);
  assert.equal(projection.compiler, manifest.compiler, "CPU compiler changed");
  assert.deepEqual(projection.flags, manifest.flags);
  const derived = prepareFlatExtractionPlan(parentPlan, projection.lines);
  const bytes = await readFile(path.join(root, "plan.json"), "utf8");
  assert.equal(hash(bytes), manifest.planSha256);
  assert.deepEqual(JSON.parse(bytes), derived, "CPU plan did not rederive");
  assert.equal(derived.initialIdentity, manifest.initial);
  assert.equal(treeIdentity(derived.expected), manifest.expected);
  assert.deepEqual(manifest.pixels, parentManifest.pixels);
  assert.deepEqual(
    manifest.files,
    derived.tasks.map(({ id, file }) => ({ id, file })),
  );
  return { manifest, plan: derived };
}
