import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTree, writeTree, treeIdentity } from "../generation/generator.mjs";
import {
  coherentStructureTasks,
  appendCoherentNamingTask,
  coherentTaskPrompt,
} from "./coherent-tasks.mjs";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { prepareCoherentContract, evaluateCoherentContract } from "../grading/coherent-grade.mjs";
import { applyCoherentStructure, coherentModuleCleanup } from "../reference/coherent-edit.mjs";
import {
  scopedNamingSession,
  applyScopedNamePlan,
  currentNamingSelectors,
} from "../cpp/scoped-names.mjs";

/** Prepare a separate coherent route and private cumulative obligation ledger from
 * the verified full inventory. No pairwise swaps are delivered. Scripted reference
 * planning uses current compiler bindings, not inverse offsets or copied endpoints.
 * Only tasks.json and the initial candidate may enter the editing sandbox.
 */
export async function prepareCoherent(proofPath, outputPath, { signal } = {}) {
  const proof = path.resolve(proofPath),
    output = path.resolve(outputPath);
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  const audit = await json(path.join(proof, "audit.json"));
  assert.equal(audit.status, "pass");
  assert.equal((await json(path.join(proof, "report.json"))).status, "pass");
  const bytes = await readFile(path.join(proof, "requests.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), audit.requestsSha256);
  const requests = JSON.parse(bytes);
  const initial = await readTree(path.join(proof, "checks/initial/source"));
  assert.equal(treeIdentity(initial), audit.initial);
  await mkdir(output);
  await mkdir(path.join(output, "contracts"));
  await writeTree(path.join(output, "initial"), initial);
  const contractHashes = {};
  const seal = async (id, tree) => {
    const content = JSON.stringify(prepareCoherentContract(tree)) + "\n";
    contractHashes[id] = createHash("sha256").update(content).digest("hex");
    await writeFile(path.join(output, "contracts", `${id}.json`), content);
  };
  await seal("initial", initial);
  const tasks = coherentStructureTasks(requests);
  let current = initial;
  for (const task of tasks) {
    signal?.throwIfAborted();
    for (const operation of task.operations) {
      if (operation.action === "remove-generated-declaration") {
        const owners = Object.entries(current).filter(
          ([file, source]) =>
            file.endsWith(".cpp") &&
            cppStructure(source, { expandNamespaceConditionals: true }).units.some(
              (unit) =>
                unit.kind === "declaration" &&
                !unit.definition &&
                (unit.scope || "::") === operation.selector.scope &&
                unitDeclarator(source, unit) === operation.selector.declarator,
            ),
        );
        if (owners.length !== 1)
          throw Error(`Missing or ambiguous moved temporary declaration: ${operation.id}`);
        operation.file = owners[0][0];
      }
      current = applyCoherentStructure(current, operation);
    }
    if (task.operations.some((operation) => operation.action === "implementation")) {
      const finalTask = tasks.at(-1);
      const cleanup = coherentModuleCleanup(
        current,
        task.subsystem,
        finalTask.operations.filter(
          (operation) => operation.action === "remove-generated-declaration",
        ),
      );
      const selected = new Set(cleanup.map((operation) => operation.id));
      finalTask.operations = finalTask.operations.filter(
        (operation) => !selected.has(operation.id),
      );
      task.operations.push(...cleanup);
      for (const operation of cleanup) current = applyCoherentStructure(current, operation);
    }
    task.prompt = coherentTaskPrompt(task.goal, task.operations);
    await seal(task.id, current);
    console.log(`PREPARED ${task.id}: ${task.subsystem}`);
  }
  const names = requests.filter((item) => item.phase === "names");
  let session,
    sessionKey,
    selectedOrigins = [],
    pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const modules = new Map();
    for (const entry of pending) {
      if (!modules.has(entry.subsystem)) modules.set(entry.subsystem, []);
      modules.get(entry.subsystem).push(entry);
    }
    const applied = [];
    for (const [subsystem, entries] of modules) {
      if (entries[0].operation.category === "functions-types") {
        const directory = path.join(output, `owners-${tasks.length}`);
        await mkdir(directory);
        const origins = entries.map((entry) =>
          entry.origins.map((origin) => ({
            ...origin,
            start:
              origin.start +
              applied
                .flatMap((plan) => plan.edits)
                .filter((edit) => edit.file === origin.file && edit.start < origin.start)
                .reduce((sum, edit) => sum + edit.new.length - edit.old.length, 0),
          })),
        );
        const selectors = await currentNamingSelectors(current, origins, directory);
        for (const [index, entry] of entries.entries())
          entry.operation = { ...entry.operation, selectors: selectors[index] };
      }
      for (const entry of entries) {
        current = applyScopedNamePlan(current, entry.plan, applied);
        applied.push(entry.plan);
      }
      const item = appendCoherentNamingTask(
        tasks,
        entries[0].operation.category,
        subsystem,
        entries.map((entry) => entry.operation),
      );
      await seal(item.id, current);
      console.log(`PREPARED ${item.id}: ${subsystem}, ${entries.length} owner groups`);
    }
    pending = [];
  };
  try {
    for (const operation of names) {
      signal?.throwIfAborted();
      const key =
        operation.category === "helpers"
          ? `${operation.category}:${operation.file}`
          : operation.category;
      if (sessionKey !== key) {
        await flush();
        session?.close();
        const directory = path.join(output, `analysis-${tasks.length}`);
        await mkdir(directory);
        session = await scopedNamingSession(current, directory, {
          file: operation.category === "helpers" ? operation.file : undefined,
          onSelection: (origins) => {
            selectedOrigins = origins;
          },
        });
        sessionKey = key;
      }
      const plan = await session.plan(operation);
      const counts = new Map();
      for (const origin of selectedOrigins)
        counts.set(origin.file, (counts.get(origin.file) ?? 0) + 1);
      const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (!ordered.length) throw Error("Missing current naming owner module");
      pending.push({ operation, plan, subsystem: ordered[0][0], origins: selectedOrigins });
    }
    await flush();
  } finally {
    session?.close();
  }
  const final = await readTree(path.join(proof, "checks/batch-155-attempt-1/source"));
  const finalResult = evaluateCoherentContract(current, prepareCoherentContract(final));
  assert.equal(finalResult.status, "pass", "Coherent route lost a full restoration obligation");
  const taskBytes = JSON.stringify(tasks, null, 2) + "\n";
  await writeFile(path.join(output, "tasks.json"), taskBytes);
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        version: "renderer-coherent-v1",
        profile: "coherent",
        status: "prepared",
        initial: audit.initial,
        inventorySha256: audit.requestsSha256,
        tasksSha256: createHash("sha256").update(taskBytes).digest("hex"),
        tasks: tasks.length,
        contractHashes,
        targets: tasks.reduce((sum, task) => sum + task.operations.length, 0),
        omittedLayoutSwaps: requests.filter((item) => item.action === "swap-definitions").length,
        final: treeIdentity(current),
        pixels: audit.pixels,
        policy: {
          trialTimeoutMs: null,
          attemptTimeoutMs: null,
          oracleRecoveries: 3,
          feedbackMode: "coarse",
        },
      },
      null,
      2,
    ) + "\n",
  );
  return tasks;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareCoherent(process.argv[2], process.argv[3]);
