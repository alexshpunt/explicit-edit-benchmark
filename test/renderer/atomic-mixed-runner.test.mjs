import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  scopedNamingSession,
  applyScopedNamePlan,
  currentNamingSelectors,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import {
  appendCoherentNamingTask,
  coherentTaskPrompt,
} from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quiet = () => {};

// Four tiny scoring groups, not the canonical workload or a release proof.
// Declaration/definition ownership moves before certification. The type rename
// then changes a later function selector and a use in the separate entry file.
await test(
  "a moved header and certified signature-changing renames execute through three partial barriers",
  { timeout: 90_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/atomic-mixed-runner-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const initial = {
      "main.cpp": `#include <fstream>
#include <string>
#ifndef CORE_H
#define CORE_H
namespace first { struct OldType { int value; }; }
namespace second { inline int old(first::OldType arg) { return arg.value + 1; } }
#endif
#ifndef EXTRA_H
#define EXTRA_H
namespace extra { inline int offset(int value) { return value + 2; } }
#endif
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int scene = 0; scene < 2; scene++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = float(i % 17 + second::old(first::OldType{scene}) + extra::offset(scene));
    std::ofstream file(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    file.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`,
    };
    const coherent = path.join(root, "coherent");
    await mkdir(path.join(coherent, "contracts"), { recursive: true });
    await mkdir(path.join(coherent, "naming-plans"));
    await writeTree(path.join(coherent, "initial"), initial);
    const contractHashes = {},
      namingPlanHashes = {};
    let current = initial;
    async function seal(id) {
      const bytes = JSON.stringify(prepareCoherentContract(current)) + "\n";
      contractHashes[id] = digest(bytes);
      await writeFile(path.join(coherent, "contracts", `${id}.json`), bytes);
    }
    await seal("initial");
    const move = {
      id: "header-core",
      phase: "structure",
      action: "header",
      file: "core.h",
      guard: "CORE_H",
      includes: [],
    };
    const goal = "Extract core.h and retain its current names";
    const tasks = [
      {
        id: "task-001",
        phase: "structure",
        subsystem: "core.h",
        goal,
        operations: [move],
        prompt: coherentTaskPrompt(goal, [move]),
      },
    ];
    current = applyCoherentStructure(current, move);
    assert.match(current["core.h"], /struct OldType/);
    assert.ok(!current["main.cpp"].includes("struct OldType"));
    await seal("task-001");
    const extra = {
      id: "header-extra",
      phase: "structure",
      action: "header",
      file: "extra.h",
      guard: "EXTRA_H",
      includes: [],
    };
    const extraGoal = "Extract extra.h without changing core.h";
    tasks.push({
      id: "task-002",
      phase: "structure",
      subsystem: "extra.h",
      goal: extraGoal,
      operations: [extra],
      prompt: coherentTaskPrompt(extraGoal, [extra]),
    });
    current = applyCoherentStructure(current, extra);
    await seal("task-002");
    const analysis = path.join(root, "certification");
    await mkdir(analysis);
    let selectedOrigins;
    const session = await scopedNamingSession(current, analysis, {
      onSelection: (origins) => {
        selectedOrigins = origins;
      },
    });
    let type, functionBinding, functionOrigins;
    try {
      type = await session.atomicPlans({
        id: "type",
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "OldType", to: "RestoredType" }],
        selectors: [{ kind: "type", scope: "first::OldType" }],
      });
      functionBinding = await session.atomicPlans({
        id: "function",
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "old", to: "restored" }],
        selectors: [
          {
            kind: "function",
            scope: "second::old",
            owner: { scope: "second::old", signature: "int (first::OldType)" },
          },
        ],
      });
      functionOrigins = structuredClone(selectedOrigins);
    } finally {
      session.close();
    }
    assert.equal(type.atoms.length, 1);
    assert.equal(functionBinding.atoms.length, 1);
    for (const binding of [type, functionBinding])
      assert.deepEqual(
        new Set(binding.plan.edits.map((edit) => edit.file)),
        new Set(["core.h", "main.cpp"]),
      );
    const applied = [];
    async function appendNaming(certification) {
      const record = coherentNamingPlans(current, [certification.plan], applied, [certification]);
      const task = appendCoherentNamingTask(tasks, "functions-types", "core.h", [
        certification.operation,
      ]);
      const bytes = JSON.stringify(record) + "\n";
      namingPlanHashes[task.id] = digest(bytes);
      await writeFile(path.join(coherent, "naming-plans", `${task.id}.json`), bytes);
      current = applyScopedNamePlan(current, certification.plan, applied);
      applied.push(certification.plan);
      await seal(task.id);
    }
    await appendNaming(type);
    const atomOrigins = functionBinding.atoms.map((atom) =>
      functionOrigins.filter((origin) =>
        atom.plan.edits.some((edit) => edit.file === origin.file && edit.start === origin.start),
      ),
    );
    const groups = [functionOrigins, ...atomOrigins].map((group) =>
      group.map((origin) => ({
        ...origin,
        start:
          origin.start +
          type.plan.edits
            .filter((edit) => edit.file === origin.file && edit.start < origin.start)
            .reduce((sum, edit) => sum + edit.new.length - edit.old.length, 0),
      })),
    );
    const refreshedDirectory = path.join(root, "refreshed-selectors");
    await mkdir(refreshedDirectory);
    const refreshed = await currentNamingSelectors(
      current,
      groups,
      refreshedDirectory,
      [functionBinding],
      applied,
    );
    functionBinding = refreshed.certifications[0];
    assert.ok(
      functionBinding.operation.selectors.some(
        (selector) => selector.owner?.signature === "int (first::RestoredType)",
      ),
    );
    assert.ok(
      functionBinding.atoms[0].operation.selectors.every(
        (selector) => !JSON.stringify(selector).includes("OldType"),
      ),
    );
    await appendNaming(functionBinding);
    const taskBytes = JSON.stringify(tasks) + "\n";
    await writeFile(path.join(coherent, "tasks.json"), taskBytes);
    const pixels = await buildCoherentCandidate(
      path.join(coherent, "initial"),
      path.join(root, "golden"),
      initial,
      { signal: t.signal },
    );
    await writeFile(
      path.join(coherent, "manifest.json"),
      JSON.stringify({
        version: "renderer-coherent-v1",
        initial: treeIdentity(initial),
        final: treeIdentity(current),
        tasks: tasks.length,
        tasksSha256: digest(taskBytes),
        contractHashes,
        namingPlanHashes,
        pixels,
      }),
    );
    const coherentProof = await runCoherent(coherent, path.join(root, "coherent-reference"), {
      signal: t.signal,
      log: quiet,
    });
    assert.equal(coherentProof.status, "pass", JSON.stringify(coherentProof.terminal));
    const preparation = path.join(root, "prepared");
    const manifest = await prepareConcurrent(coherent, preparation);
    assert.equal(manifest.atomic.edits, 4);
    assert.equal(manifest.graphWidth, 2);
    const workload = JSON.parse(
      await readFile(path.join(preparation, "atomic/tasks.json"), "utf8"),
    );
    assert.equal(workload.nodes.length, 4);
    for (const node of workload.nodes) {
      assert.equal(node.operations.length, 1);
      const operation = node.operations[0];
      if (operation.phase === "names") assert.equal(operation.mapping.length, 1);
      for (const key of [
        "bindingCertification",
        "bindingGroups",
        "edits",
        "declarations",
        "tokens",
      ])
        assert.ok(
          !node.prompt.includes(`"${key}"`),
          `Private binding data reached the current prompt: ${key}`,
        );
    }
    const output = path.join(root, "reference");
    const report = await runConcurrent(preparation, output, {
      agents: 2,
      signal: t.signal,
      log: quiet,
    });
    assert.equal(
      report.status,
      "pass",
      JSON.stringify({
        terminal: report.terminal,
        barriers: report.atomicBarriers,
        executions: report.executions,
      }),
    );
    assert.equal(report.deliveries, 4);
    assert.equal(report.repairs, 0);
    assert.equal(report.acceptedTasks, 4);
    assert.equal(report.acceptedRounds, 3);
    assert.ok(
      report.executions.every((row) => row.attempt === 1 && row.atomicCheck.status === "pass"),
    );
    assert.deepEqual(
      report.executions.map((row) => row.atomicId).sort(),
      workload.nodes.map((node) => node.id).sort(),
    );
    const receipts = report.executions.map((row) => row.receipts[0]);
    assert.equal(new Set(receipts.map((receipt) => receipt.lifetime)).size, 2);
    assert.ok(receipts.some((receipt) => receipt.delivered === 2));
    assert.deepEqual(await readTree(path.join(output, "workspace")), current);
    assert.deepEqual(report.checks.at(-1).pixels, pixels);
    assert.match(current["core.h"], /int restored\(first::RestoredType arg\)/);
    assert.match(current["main.cpp"], /second::restored\(first::RestoredType\{scene\}\)/);
    const proof = JSON.parse(await readFile(path.join(preparation, "verification-2.json"), "utf8"));
    assert.equal(proof.acceptedAtomicEdits, 4);
    assert.deepEqual(proof.atomic, report.atomic);
    t.diagnostic(
      "Partial mixed source: two header moves, two compiler-certified bindings, three barriers, two persistent participants; not a canonical release proof.",
    );
  },
);
