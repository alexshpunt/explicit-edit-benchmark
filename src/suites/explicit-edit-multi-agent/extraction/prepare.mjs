import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readTree, treeIdentity } from "../generation/generator.mjs";
import { prepareHeaderExtraction } from "./plan.mjs";

const version = "renderer-module-extraction-v1";
const scope = "experimental-project-headers";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pixelsValid = (pixels) =>
  Array.isArray(pixels) && pixels.length === 2 && Array.from(pixels).every(sha256);
const modulesValid = (modules) =>
  Array.isArray(modules) &&
  modules.length > 0 &&
  modules.length <= 10 &&
  new Set(modules).size === modules.length &&
  Array.from(modules).every(
    (file) => typeof file === "string" && /^[A-Za-z_][A-Za-z_0-9]*\.h$/.test(file),
  );

/** Seal a header-only case from the current shuffled preparation, not a restored
 * route endpoint. Only guard/include provenance is retained from the old tasks.
 * Validate everything before creating a fresh private output directory.
 */
export async function prepareExtraction(preparationPath, outputPath, { modules } = {}) {
  const preparation = path.resolve(preparationPath);
  const source = JSON.parse(await readFile(path.join(preparation, "manifest.json"), "utf8"));
  assert.ok(record(source));
  assert.equal(source.version, "renderer-concurrent-v2");
  assert.ok(sha256(source.initial) && sha256(source.workloadSha256));
  assert.ok(pixelsValid(source.pixels));
  assert.ok(modulesValid(modules));
  const bytes = await readFile(path.join(preparation, "tasks.json"));
  assert.equal(hash(bytes), source.workloadSha256);
  const tasks = JSON.parse(bytes.toString("utf8"));
  assert.ok(
    Array.isArray(tasks) && tasks.every((task) => record(task) && Array.isArray(task.operations)),
  );
  const operations = tasks.flatMap((task) => task.operations);
  assert.ok(operations.every(record));
  const headers = operations
    .filter(({ action }) => action === "header")
    .map(({ file, guard, includes }) => ({ file, guard, includes }));
  const initial = await readTree(path.join(preparation, "initial"));
  assert.equal(treeIdentity(initial), source.initial);
  const plan = { ...prepareHeaderExtraction({ initial, headers, modules }), headers };
  const planBytes = JSON.stringify(plan) + "\n";
  const manifest = {
    version,
    scope,
    initial: plan.initialIdentity,
    expected: treeIdentity(plan.expected),
    modules: [...modules],
    pixels: [...source.pixels],
    planSha256: hash(planBytes),
    provenance: { initial: source.initial, workloadSha256: source.workloadSha256 },
  };
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, "plan.json"), planBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

/** Rebuild the sealed plan from its current-source snapshot and guard provenance.
 * A matching hash alone is not a substitute for valid ownership and scaffolding.
 * The resulting artifact is private preparation, not a published observation.
 */
export async function loadExtraction(preparedPath) {
  const prepared = path.resolve(preparedPath);
  const manifest = JSON.parse(await readFile(path.join(prepared, "manifest.json"), "utf8"));
  assert.ok(record(manifest));
  assert.equal(manifest.version, version);
  assert.equal(manifest.scope, scope);
  assert.ok(sha256(manifest.initial) && sha256(manifest.expected) && sha256(manifest.planSha256));
  assert.ok(pixelsValid(manifest.pixels) && modulesValid(manifest.modules));
  assert.ok(record(manifest.provenance) && sha256(manifest.provenance.workloadSha256));
  assert.equal(manifest.provenance.initial, manifest.initial);
  const bytes = await readFile(path.join(prepared, "plan.json"));
  assert.equal(hash(bytes), manifest.planSha256);
  const plan = JSON.parse(bytes.toString("utf8"));
  assert.ok(record(plan));
  assert.equal(plan.version, "renderer-module-extraction-plan-v1");
  const expected = prepareHeaderExtraction({
    initial: plan.initial,
    headers: plan.headers,
    modules: manifest.modules,
  });
  assert.deepEqual(plan, { ...expected, headers: plan.headers });
  assert.equal(plan.initialIdentity, manifest.initial);
  assert.equal(treeIdentity(plan.expected), manifest.expected);
  assert.deepEqual(
    plan.tasks.map(({ file }) => file),
    manifest.modules,
  );
  return { manifest, plan };
}
