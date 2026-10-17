import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { atomicWorkload } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-workload.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
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

function headerTarget(prompt) {
  const targets = prompt.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return typeof value.guard === "string" ? [value] : [];
    } catch {
      return [];
    }
  });
  assert.equal(targets.length, 1, "A participant receives exactly one current header target");
  return targets[0];
}

// A tiny filesystem/namespace integration, not a benchmark preparation or proof.
// Structural workers plan from actual shared source and commit through their CAS;
// expected trees and gates stay in this controller, outside their editing mount.
await test(
  "fifteen isolated persistent participants stream thirty tiny header edits exactly once",
  { timeout: 60_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/atomic-filesystem-stream-"));
    const workspace = path.join(root, "workspace");
    const tools = path.join(root, "executor");
    const workers = [];
    try {
      const tasks = Array.from({ length: 30 }, (_, index) => {
        const suffix = String(index + 1).padStart(3, "0");
        return {
          id: `task-${suffix}`,
          phase: "structure",
          operations: [
            {
              id: `header-${suffix}`,
              phase: "structure",
              action: "header",
              file: `part_${suffix}.h`,
              guard: `PART_${suffix}_H`,
              includes: [],
            },
          ],
        };
      });
      const initial = {
        "main.cpp":
          tasks
            .map(({ operations: [operation] }, index) =>
              [
                `#ifndef ${operation.guard}`,
                `#define ${operation.guard}`,
                `inline int part_${index + 1}(int value) { return value + ${index + 1}; }`,
                "#endif",
              ].join("\n"),
            )
            .join("\n") + "\nint main() { return part_1(0) - 1; }\n",
      };
      const { nodes } = atomicWorkload(tasks);
      assert.equal(nodes.length, 30);
      assert.ok(nodes.every((node) => node.dependencies.length === 0));
      const expected = tasks
        .flatMap((task) => task.operations)
        .reduce(applyCoherentStructure, initial);
      const checkpoint = createAtomicCheckpoint(initial, nodes, []);
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
          assert.ok(!occupied.has(agent), "A busy participant cannot receive another edit");
          occupied.add(agent);
          maximumOverlap = Math.max(maximumOverlap, occupied.size);
          calls.push({ id: node.id, agent });
          const [{ file, guard, includes }] = node.operations;
          assert.deepEqual(headerTarget(node.prompt), { file, guard, includes });
          if (calls.length === 15) firstWave.resolve();
          try {
            // Start the first fifteen callbacks together without sleeps. No
            // source writes occur before every pool member has its first task.
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
      assert.equal(
        result.status,
        "pass",
        JSON.stringify({ failed: result.failed, completed: [...result.completed], calls }),
      );
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
          "Each persistent participant keeps its own contiguous delivery history",
        );
      }
      const actual = await readTree(workspace);
      assert.deepEqual(actual, expected);
      assert.equal(
        checkpoint.revalidate(actual, {
          completed: result.completed,
          started: result.started,
        }).completed.size,
        30,
      );
      assert.ok(
        !(await readdir(workspace)).some((name) => /^\.renderer-(?:planner-|edit-lock)/.test(name)),
        "All reference transactions release their workspace controls before settlement",
      );
      t.diagnostic(
        `Partial synthetic source: ${initial["main.cpp"].split("\n").length} lines; 30 structural atoms; 15 persistent namespaces; no compiler, build, render or full benchmark proof.`,
      );
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
