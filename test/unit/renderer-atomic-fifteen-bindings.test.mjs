import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  scopedNamingSession,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { assembleAtomicBundle } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-bundle.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { appendCoherentNamingTask } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { readSharedSource } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-commit.mjs";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const decision = (result) =>
  result.status === "pass" ? true : result.status === "pending" ? "pending" : false;

async function untilReleased(promise, signal) {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function publicBinding(node) {
  const targets = node.prompt.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.mapping ? [value] : [];
    } catch {
      return [];
    }
  });
  assert.equal(targets.length, 1, "Only the current binding enters the delivery");
  const [target] = targets;
  assert.equal(target.mapping.length, 1);
  assert.ok(target.selectors.length > 0);
  for (const key of [
    "bindingCertification",
    "bindingGroups",
    "plan",
    "edits",
    "tokens",
    "declarations",
  ])
    assert.ok(
      !Object.hasOwn(target, key),
      `Private binding preparation reached the prompt: ${key}`,
    );
  assert.deepEqual(target.mapping, node.operations[0].mapping);
}

// Thirty real compiler-selected bindings over one tiny file, not a canonical
// preparation, full benchmark, model run or release proof. The workers receive
// current public requests only; private certification/batches remain here.
await test(
  "fifteen isolated participants reuse current-source compiler analysis for thirty certified bindings",
  { timeout: 90_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/atomic-fifteen-bindings-"));
    const workspace = path.join(root, "workspace");
    const tools = path.join(root, "executor");
    const workers = [];
    let session;
    try {
      const functions = Array.from({ length: 15 }, (_value, index) => ({
        name: `part_${index}`,
        left: `left_${index}`,
        right: `right_${index}`,
        index,
      }));
      const initial = {
        "main.cpp": [
          "namespace frond {",
          ...functions.map(
            ({ name, index }) => `int ${name}(int a, int b) { return a + b + ${index}; }`,
          ),
          "}",
          `int main() { return ${functions.map(({ name }) => `frond::${name}(1, 2)`).join(" + ")}; }`,
          "",
        ].join("\n"),
      };
      const requests = functions.map(({ name, left, right }) => ({
        id: `parameters-${name}`,
        phase: "names",
        category: "locals-parameters",
        mapping: [
          { from: "a", to: left },
          { from: "b", to: right },
        ],
        selectors: [
          {
            kind: "function",
            scope: `frond::${name}`,
            signature: "int (int, int)",
            definition: true,
          },
        ],
      }));
      const analysis = path.join(root, "certification");
      await mkdir(analysis);
      session = await scopedNamingSession(initial, analysis);
      const certifications = [];
      for (const request of requests) certifications.push(await session.atomicPlans(request));
      session.close();
      session = undefined;
      assert.ok(certifications.every((certification) => certification.atoms.length === 2));
      const tasks = [];
      const task = appendCoherentNamingTask(tasks, "locals-parameters", "main.cpp", requests);
      const plans = certifications.map((certification) => certification.plan);
      const record = coherentNamingPlans(initial, plans, [], certifications);
      let expected = initial;
      const applied = [];
      for (const plan of plans) {
        expected = applyScopedNamePlan(expected, plan, applied);
        applied.push(plan);
      }
      const bundle = assembleAtomicBundle(initial, tasks, {
        namingPlans: new Map([[task.id, record]]),
        contracts: new Map([[task.id, prepareCoherentContract(expected)]]),
      });
      const nodes = bundle.workload.nodes;
      assert.equal(nodes.length, 30);
      assert.ok(nodes.every((node) => node.dependencies.length === 0));
      assert.deepEqual(bundle.tree, expected);
      const checkpoint = createAtomicCheckpoint(initial, nodes, bundle.batches);
      await writeTree(workspace, initial);
      await prepareConcurrentExecutor(tools);
      for (let agent = 0; agent < 15; agent++)
        workers.push(concurrentExecutor(workspace, tools, { signal: t.signal }));
      const firstWave = Promise.withResolvers();
      const calls = [];
      const receipts = [];
      const occupied = new Set();
      let maximumOverlap = 0;
      const read = () => readSharedSource(workspace);
      const result = await runAtomicStream(nodes, {
        agents: 15,
        signal: t.signal,
        checkInputs: async (node, signal, context) =>
          decision(await checkpoint.observe(read, node.id, context, { input: true, signal })),
        execute: async (node, agent, signal) => {
          assert.ok(!occupied.has(agent), "A busy participant cannot receive another binding");
          occupied.add(agent);
          maximumOverlap = Math.max(maximumOverlap, occupied.size);
          calls.push({ id: node.id, agent });
          publicBinding(node);
          if (calls.length === 15) firstWave.resolve();
          try {
            // Every participant has a real current task before writes begin;
            // service serialization must not turn participant identities into one.
            await untilReleased(firstWave.promise, signal);
            const receipt = await workers[agent].execute(node);
            receipts.push({ agent, ...receipt });
            return receipt;
          } finally {
            occupied.delete(agent);
          }
        },
        verify: async (node, signal, _receipt, context) =>
          decision(await checkpoint.observe(read, node.id, context, { signal })),
      });
      assert.equal(result.status, "pass", JSON.stringify({ failed: result.failed, calls }));
      assert.equal(maximumOverlap, 15);
      assert.equal(calls.length, 30);
      assert.equal(new Set(calls.map((call) => call.id)).size, 30);
      assert.deepEqual(new Set(calls.map((call) => call.agent)), new Set(workers.keys()));
      assert.equal(result.completed.size, 30);
      assert.equal(new Set(receipts.map((receipt) => receipt.lifetime)).size, 15);
      for (const agent of workers.keys()) {
        const history = receipts.filter((receipt) => receipt.agent === agent);
        assert.deepEqual(
          history.map((receipt) => receipt.delivered),
          history.map((_receipt, index) => index + 1),
        );
      }
      const actual = await readTree(workspace);
      assert.deepEqual(actual, expected);
      assert.equal(
        checkpoint.revalidate(actual, { completed: result.completed, started: result.started })
          .completed.size,
        30,
      );
      const snapshots = Math.max(...receipts.map((receipt) => receipt.planner.snapshotAttempts));
      const cacheHits = Math.max(...receipts.map((receipt) => receipt.planner.cacheHits));
      assert.ok(snapshots >= 1, "The isolated service must analyze actual source");
      assert.ok(
        cacheHits > 0,
        "Current-source planning must reuse a previously opened compiler snapshot",
      );
      assert.ok(
        !(await readdir(workspace)).some((name) => /^\.renderer-(?:planner-|edit-lock)/.test(name)),
      );
      t.diagnostic(
        `Partial source: ${initial["main.cpp"].split("\n").length} lines; 30 compiler-certified bindings; 15 isolated persistent participants; ${snapshots} compiler snapshots, ${cacheHits} cache hits; no build, render or full benchmark proof.`,
      );
    } finally {
      session?.close();
      await Promise.allSettled(workers.map((worker) => worker.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
