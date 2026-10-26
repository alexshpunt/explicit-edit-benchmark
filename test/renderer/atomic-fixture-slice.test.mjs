import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  readTree,
  prepareTree,
  packingPlan,
  pack,
  compactBlankLines,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { maskOrigin } from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import {
  scopedNamingSession,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { assembleAtomicBundle } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-bundle.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { runRetainedAtomicStream } from "../helpers/retained-atomic-stream.mjs";
import { readSharedSource } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-commit.mjs";
import {
  prepareConcurrentExecutor,
  concurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";

// Deliberately only four bindings from the canonical fixture. This does not
// prepare or execute the 71-task benchmark or create an admissible team proof.
await test(
  "four real-fixture bindings stream through private certification and isolated reference editing",
  { timeout: 240_000 },
  async (t) => {
    const started = performance.now();
    const stage = (label) =>
      console.log(`PARTIAL fixture ${label}: ${Math.round(performance.now() - started)}ms`);
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/atomic-fixture-slice-"));
    const workers = [];
    let session;
    t.after(async () => {
      session?.close();
      await Promise.all(workers.map((worker) => worker.close()));
      await rm(root, { recursive: true, force: true });
    });
    let initial = prepareTree(await readTree("fixtures/explicit-edit-multi-agent"));
    for (const operation of packingPlan(initial)) initial = pack(initial, operation).tree;
    initial = compactBlankLines(maskOrigin(initial, { name: "nacre" }).tree).tree;
    assert.deepEqual(Object.keys(initial), ["main.cpp"]);
    stage("packed and origin-masked");
    const requests = [
      {
        owner: "eval_camera",
        signature: "ray3f (const camera_data &, const vec2f &, const vec2f &)",
        mapping: [
          { from: "image_uv", to: "fixture_image_uv" },
          { from: "lens_uv", to: "fixture_lens_uv" },
        ],
      },
      {
        owner: "lookup_texture",
        signature: "vec4f (const texture_data &, int, int, bool)",
        mapping: [
          { from: "i", to: "fixture_pixel_i" },
          { from: "j", to: "fixture_pixel_j" },
        ],
      },
    ].map(({ owner, signature, mapping }) => ({
      id: owner,
      phase: "names",
      category: "locals-parameters",
      mapping,
      selectors: [{ kind: "function", scope: `nacre::${owner}`, signature, definition: true }],
    }));
    const analysis = path.join(root, "analysis");
    await mkdir(analysis);
    session = await scopedNamingSession(initial, analysis);
    stage("compiler snapshot opened");
    const certifications = [];
    for (const request of requests) certifications.push(await session.atomicPlans(request));
    session.close();
    session = undefined;
    stage("four bindings certified");
    assert.deepEqual(
      certifications.map((entry) => entry.atoms.length),
      [2, 2],
    );
    const tasks = [],
      namingPlans = new Map(),
      contracts = new Map(),
      applied = [];
    let expected = initial;
    for (const [index, certification] of certifications.entries()) {
      const id = `task-${String(index + 1).padStart(3, "0")}`;
      tasks.push({
        id,
        phase: "names",
        subsystem: "main.cpp",
        operations: [certification.operation],
      });
      namingPlans.set(
        id,
        coherentNamingPlans(expected, [certification.plan], applied, [certification]),
      );
      expected = applyScopedNamePlan(expected, certification.plan, applied);
      applied.push(certification.plan);
      contracts.set(id, prepareCoherentContract(expected));
    }
    const bundle = assembleAtomicBundle(initial, tasks, { namingPlans, contracts });
    stage("private atomic bundle assembled");
    assert.equal(bundle.workload.nodes.length, 4);
    assert.ok(bundle.workload.nodes.every((node) => node.dependencies.length === 0));
    const contract = prepareCoherentContract(expected);
    const tools = path.join(root, "executor"),
      workspace = path.join(root, "workspace");
    await prepareConcurrentExecutor(tools);
    await writeTree(workspace, initial);
    const controller = new AbortController();
    const abort = () => controller.abort(t.signal.reason);
    t.signal.addEventListener("abort", abort, { once: true });
    t.after(() => t.signal.removeEventListener("abort", abort));
    for (let index = 0; index < 2; index++)
      workers.push(concurrentExecutor(workspace, tools, { signal: controller.signal }));
    const receipts = [];
    const source = () => readSharedSource(workspace);
    const result = await runRetainedAtomicStream(bundle.workload.nodes, {
      evaluate: (tree) => evaluateCoherentContract(tree, contract),
      readSource: source,
      batchSize: 1,
      agents: 2,
      signal: controller.signal,
      execute: async (node, agent) => {
        const receipt = await workers[agent].execute(node);
        receipts.push(receipt);
        stage(`delivered ${node.id}`);
        return receipt;
      },
    });
    assert.equal(result.status, "pass");
    assert.ok(result.attempts >= 1);
    assert.ok(receipts.length >= 4);
    assert.equal(new Set(receipts.map((receipt) => receipt.lifetime)).size, 2);
    assert.ok(receipts.every((receipt) => receipt.planner.snapshotAttempts >= 1));
    assert.deepEqual(await readTree(workspace), expected);
    assert.equal(evaluateCoherentContract(await readTree(workspace), contract).status, "pass");
    t.diagnostic(
      `Partial canonical fixture: ${initial["main.cpp"].split("\n").length} lines; four bindings only; no builds, renders or full proof.`,
    );
  },
);
