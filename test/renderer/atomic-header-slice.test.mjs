import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  compactBlankLines,
  pack,
  packingPlan,
  prepareTree,
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { includeDirectives } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import {
  maskOrigin,
  neutralSourcePath,
} from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import { atomicWorkload } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-workload.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";

function publicHeader(prompt) {
  const targets = prompt.split("\n").flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return typeof row.guard === "string" ? [row] : [];
    } catch {
      return [];
    }
  });
  assert.equal(targets.length, 1, "A delivery exposes one current public header request");
  return targets[0];
}

// Two real guarded headers only. No full generation/preparation, compiler, build,
// render or benchmark proof; neither order authorizes a measured team run.
await test(
  "two real-fixture headers retain exact owners through either partial extraction order",
  { timeout: 90_000 },
  async (t) => {
    const started = performance.now();
    const stage = (label) =>
      console.log(`PARTIAL headers ${label}: ${Math.round(performance.now() - started)}ms`);
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/atomic-header-slice-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = prepareTree(await readTree("fixtures/explicit-edit-multi-agent"));
    let packed = fixture;
    for (const operation of packingPlan(packed)) packed = pack(packed, operation).tree;
    const masked = maskOrigin(packed, { name: "nacre" });
    const initial = compactBlankLines(masked.tree).tree;
    assert.deepEqual(Object.keys(initial), ["main.cpp"]);
    const tasks = ["yocto_noise.h", "yocto_sampling.h"].map((file, index) => {
      const guard = /^#ifndef\s+(\w+)/m.exec(fixture[file])?.[1];
      assert.ok(guard, `Missing canonical header guard for ${file}`);
      return {
        id: `task-00${index + 1}`,
        phase: "structure",
        operations: [
          {
            id: `header-${index + 1}`,
            phase: "structure",
            action: "header",
            file: neutralSourcePath(file, masked.record.name),
            guard: guard.replace("YOCTO", masked.record.name.toUpperCase()),
            includes: includeDirectives(fixture[file])
              .filter((include) => include.quoted)
              .map((include) => neutralSourcePath(include.file, masked.record.name)),
          },
        ],
      };
    });
    const workload = atomicWorkload(tasks);
    stage("packed and selected two headers");
    assert.equal(workload.nodes.length, 2);
    assert.ok(workload.nodes.every((node) => node.dependencies.length === 0));
    const expected = tasks
      .flatMap((task) => task.operations)
      .reduce(applyCoherentStructure, initial);
    assert.deepEqual(
      tasks
        .flatMap((task) => task.operations)
        .reverse()
        .reduce(applyCoherentStructure, initial),
      expected,
      "Independent real header extractions compose in either order",
    );
    const tools = path.join(root, "executor");
    await prepareConcurrentExecutor(tools);
    for (const reverse of [false, true]) {
      await t.test(
        reverse ? "sampling settles before noise" : "noise settles before sampling",
        async (subtest) => {
          const order = reverse ? [...workload.nodes].reverse() : workload.nodes;
          stage(reverse ? "sampling-first begin" : "noise-first begin");
          const workspace = path.join(root, reverse ? "sampling-first" : "noise-first");
          await writeTree(workspace, initial);
          const contract = prepareCoherentContract(expected);
          const firstTurn = Promise.withResolvers();
          const workers = Array.from({ length: 2 }, () =>
            concurrentExecutor(workspace, tools, { signal: subtest.signal }),
          );
          const receipts = [];
          try {
            const result = await runAtomicStream(order, {
              agents: 2,
              batchSize: 1,
              signal: subtest.signal,
              execute: async (node, agent, signal) => {
                if (node.id !== order[0].id) {
                  signal.throwIfAborted();
                  const aborted = Promise.withResolvers();
                  const abort = () => aborted.reject(signal.reason);
                  signal.addEventListener("abort", abort, { once: true });
                  try {
                    await Promise.race([firstTurn.promise, aborted.promise]);
                  } finally {
                    signal.removeEventListener("abort", abort);
                  }
                }
                stage(`executing ${node.id}`);
                const [{ file, guard, includes }] = node.operations;
                assert.deepEqual(publicHeader(node.prompt), { file, guard, includes });
                const receipt = await workers[agent].execute(node);
                receipts.push({ id: node.id, ...receipt });
                if (node.id === order[0].id) firstTurn.resolve();
                stage(`delivered ${node.id}`);
                return receipt;
              },
            });
            assert.equal(
              result.status,
              "drained",
              JSON.stringify({ delivered: [...result.delivered] }),
            );
            assert.equal(result.delivered.size, 2);
            assert.deepEqual(
              receipts.map((receipt) => receipt.id),
              order.map((node) => node.id),
            );
            const actual = await readTree(workspace);
            assert.deepEqual(actual, expected);
            for (const node of workload.nodes) {
              const [{ file, guard }] = node.operations;
              assert.ok(actual["main.cpp"].includes(`#include "${file}"`));
              assert.ok(!actual["main.cpp"].includes(`#ifndef ${guard}`));
              assert.equal(actual[file].split(`#ifndef ${guard}`).length - 1, 1);
              const duplicate = {
                ...actual,
                "main.cpp": actual["main.cpp"] + "\n" + actual[file],
              };
              assert.ok(
                evaluateCoherentContract(duplicate, contract).status !== "pass",
                "A retained guarded definition copy cannot satisfy the move",
              );
            }
            assert.equal(evaluateCoherentContract(actual, contract).status, "pass");
            assert.equal(
              new Set(receipts.map((receipt) => receipt.lifetime)).size,
              2,
              "The rotating two-participant pool must deliver through both persistent workers",
            );
            stage(reverse ? "sampling-first verified" : "noise-first verified");
          } finally {
            await Promise.all(workers.map((worker) => worker.close()));
          }
        },
      );
    }
    t.diagnostic(
      `Partial canonical fixture: ${initial["main.cpp"].split("\n").length} lines; two headers, both settlement orders; no compiler/build/render/full proof.`,
    );
  },
);
