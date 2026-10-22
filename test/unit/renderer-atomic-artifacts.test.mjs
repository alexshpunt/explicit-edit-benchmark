import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import {
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { ATOMIC_DISPATCH_POLICY } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import {
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { rotatingSchedule } from "../../src/suites/explicit-edit-multi-agent/tasks/concurrent-schedule.mjs";
import { checkpointContracts } from "../../src/suites/explicit-edit-multi-agent/grading/concurrent-contracts.mjs";
import { readTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(root) {
  const source = {
    "main.cpp":
      "#ifndef A_H\n#define A_H\nstruct A { int n; };\n#endif\n#ifndef B_H\n#define B_H\nstruct B { int n; };\n#endif\n",
  };
  const tasks = ["A", "B"].map((name, index) => ({
    id: `task-00${index + 1}`,
    phase: "structure",
    subsystem: `${name}.h`,
    goal: `Extract ${name}`,
    prompt: `Extract ${name}`,
    operations: [
      {
        id: name,
        phase: "structure",
        action: "header",
        file: `${name}.h`,
        guard: `${name}_H`,
        includes: [],
      },
    ],
  }));
  const coherent = path.join(root, "coherent");
  await mkdir(coherent);
  await mkdir(path.join(coherent, "contracts"));
  await writeTree(path.join(coherent, "initial"), source);
  const contractHashes = {};
  const seal = async (id, tree) => {
    const bytes = JSON.stringify(prepareCoherentContract(tree)) + "\n";
    await writeFile(path.join(coherent, "contracts", `${id}.json`), bytes);
    contractHashes[id] = digest(bytes);
  };
  await seal("initial", source);
  let current = source;
  for (const task of tasks) {
    current = task.operations.reduce(applyCoherentStructure, current);
    await seal(task.id, current);
  }
  const taskBytes = JSON.stringify(tasks) + "\n";
  await writeFile(path.join(coherent, "tasks.json"), taskBytes);
  const identity = {
    tasksSha256: digest(taskBytes),
    tasks: tasks.length,
    initial: treeIdentity(source),
    final: treeIdentity(current),
    contractHashes,
  };
  await writeFile(
    path.join(coherent, "manifest.json"),
    JSON.stringify({ ...identity, version: "renderer-coherent-v1", pixels: [] }),
  );
  await writeFile(
    path.join(coherent, "verification.json"),
    JSON.stringify({
      ...identity,
      status: "pass",
      acceptedTasks: tasks.length,
      checks: tasks.length + 1,
    }),
  );
  return { coherent, taskBytes, tasks };
}

await test("concurrent preparation binds separate public atomic requests, private batches and dispatch policy", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-artifacts-"));
  try {
    const { coherent, taskBytes } = await fixture(root);
    const output = path.join(root, "prepared");
    const manifest = await prepareConcurrent(coherent, output);
    assert.equal(await readFile(path.join(output, "tasks.json"), "utf8"), taskBytes);
    const atomic = await readFile(path.join(output, "atomic/tasks.json"));
    const batches = await readFile(path.join(output, "atomic/batches.json"));
    assert.equal(manifest.atomic.workloadSha256, digest(atomic));
    assert.equal(manifest.atomic.batchesSha256, digest(batches));
    assert.equal(
      manifest.atomic.dispatchPolicySha256,
      digest(JSON.stringify(ATOMIC_DISPATCH_POLICY)),
    );
    assert.equal(manifest.atomic.version, "renderer-atomic-stream-v1");
    assert.equal(manifest.atomic.edits, JSON.parse(atomic).nodes.length);
    assert.deepEqual(JSON.parse(batches), []);
    assert.ok(JSON.parse(atomic).nodes.every((node) => !Object.hasOwn(node, "plan")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("changed atomic requests, private batches or dispatch policy reject before driver startup", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-integrity-"));
  try {
    const { coherent } = await fixture(root);
    const preparation = path.join(root, "prepared");
    await prepareConcurrent(coherent, preparation);
    const neverOpen = async () => {
      throw Error("driver must not open");
    };
    for (const [file, message] of [
      ["atomic/tasks.json", /Atomic workload changed/],
      ["atomic/batches.json", /Private atomic bindings changed/],
    ]) {
      const target = path.join(preparation, file);
      const original = await readFile(target);
      await writeFile(target, Buffer.concat([original, Buffer.from(" ")]));
      await assert.rejects(
        runConcurrent(preparation, path.join(root, "measured"), { createDriver: neverOpen }),
        message,
      );
      await writeFile(target, original);
    }
    const file = path.join(preparation, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.atomic.dispatchPolicySha256 = "0".repeat(64);
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(
      runConcurrent(preparation, path.join(root, "measured"), { createDriver: neverOpen }),
      /Atomic dispatch policy changed/,
    );
    await assert.rejects(access(path.join(root, "measured")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("an old coarse team proof cannot open a driver or create a measured output", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-proof-"));
  try {
    const { coherent, tasks } = await fixture(root);
    const preparation = path.join(root, "prepared");
    const manifest = await prepareConcurrent(coherent, preparation);
    const json = async (file) => JSON.parse(await readFile(path.join(preparation, file), "utf8"));
    const schedule = rotatingSchedule(await json("graph.json"), 2);
    const transitions = await Promise.all(tasks.map((task) => json(`transitions/${task.id}.json`)));
    const contracts = checkpointContracts(
      await readTree(path.join(preparation, "initial")),
      await json("contracts/initial.json"),
      tasks,
      transitions,
      schedule,
    );
    const proof = {
      status: "pass",
      protocol: MULTI_AGENT_PROTOCOL,
      policy: MULTI_AGENT_POLICY,
      workloadSha256: manifest.workloadSha256,
      scheduleSha256: digest(JSON.stringify(schedule)),
      contractHashes: Object.fromEntries(
        [...contracts].map(([id, contract]) => [id, digest(JSON.stringify(contract))]),
      ),
      initial: manifest.initial,
      final: manifest.final,
      acceptedRounds: schedule.length,
      acceptedTasks: tasks.length,
    };
    await writeFile(path.join(preparation, "verification-2.json"), JSON.stringify(proof));
    let opened = 0;
    const output = path.join(root, "measured");
    await assert.rejects(
      runConcurrent(preparation, output, {
        agents: 2,
        createDriver: async () => {
          opened++;
          throw Error("must not open");
        },
      }),
      /atomic.*proof/i,
    );
    assert.equal(opened, 0);
    await assert.rejects(access(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
