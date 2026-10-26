import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  scopedNamingSession,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { appendCoherentNamingTask } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import {
  treeIdentity,
  writeTree,
  readTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quiet = () => {};

async function prepareNamingFixture(root, signal) {
  const initial = {
    "main.cpp": `#include <fstream>
#include <string>
namespace frond {
int North(int a, int b) { return a + b + 1; }
int South(int c, int d) { return c + d + 2; }
}
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int scene = 0; scene < 2; scene++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = float(i % 17 + frond::North(scene, 2) + frond::South(scene, 3));
    std::ofstream file(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    file.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`,
  };
  const requests = [
    {
      owner: "North",
      mappings: [
        { from: "a", to: "north_left" },
        { from: "b", to: "north_right" },
      ],
    },
    {
      owner: "South",
      mappings: [
        { from: "c", to: "south_left" },
        { from: "d", to: "south_right" },
      ],
    },
  ].map(({ owner, mappings }) => ({
    id: `parameters-${owner.toLowerCase()}`,
    phase: "names",
    category: "locals-parameters",
    mapping: mappings,
    selectors: [
      { kind: "function", scope: `frond::${owner}`, signature: "int (int, int)", definition: true },
    ],
  }));
  const coherent = path.join(root, "coherent");
  await mkdir(path.join(coherent, "contracts"), { recursive: true });
  await mkdir(path.join(coherent, "naming-plans"));
  await writeTree(path.join(coherent, "initial"), initial);
  const analysis = path.join(root, "compiler-certification");
  await mkdir(analysis);
  const session = await scopedNamingSession(initial, analysis);
  const certifications = [];
  try {
    for (const request of requests) certifications.push(await session.atomicPlans(request));
  } finally {
    session.close();
  }
  assert.deepEqual(
    certifications.map((certification) => certification.atoms.length),
    [2, 2],
  );
  const tasks = [];
  const contractHashes = {},
    namingPlanHashes = {};
  const applied = [];
  let current = initial;
  async function checkpoint(id) {
    const bytes = JSON.stringify(prepareCoherentContract(current)) + "\n";
    contractHashes[id] = digest(bytes);
    await writeFile(path.join(coherent, "contracts", `${id}.json`), bytes);
  }
  await checkpoint("initial");
  for (const [index, certification] of certifications.entries()) {
    const task = appendCoherentNamingTask(tasks, "locals-parameters", "main.cpp", [
      requests[index],
    ]);
    const plans = coherentNamingPlans(current, [certification.plan], applied, [certification]);
    const bytes = JSON.stringify(plans) + "\n";
    namingPlanHashes[task.id] = digest(bytes);
    await writeFile(path.join(coherent, "naming-plans", `${task.id}.json`), bytes);
    current = applyScopedNamePlan(current, certification.plan, applied);
    applied.push(certification.plan);
    await checkpoint(task.id);
  }
  const taskBytes = JSON.stringify(tasks) + "\n";
  await writeFile(path.join(coherent, "tasks.json"), taskBytes);
  const pixels = await buildCoherentCandidate(
    path.join(coherent, "initial"),
    path.join(root, "golden"),
    initial,
    { signal },
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
    signal,
    log: quiet,
  });
  assert.equal(coherentProof.status, "pass", JSON.stringify(coherentProof.terminal));
  const preparation = path.join(root, "prepared");
  const manifest = await prepareConcurrent(coherent, preparation);
  assert.equal(manifest.graphWidth, 2);
  assert.equal(manifest.atomic.edits, 4);
  const workload = JSON.parse(await readFile(path.join(preparation, "atomic/tasks.json"), "utf8"));
  assert.equal(workload.nodes.length, 4);
  assert.ok(
    workload.nodes.every((node) => node.dependencies.length === 0),
    "Disjoint bindings in one owner must not inherit a serial module chain",
  );
  assert.ok(
    workload.nodes.every(
      (node) => node.operations.length === 1 && node.operations[0].mapping.length === 1,
    ),
  );
  return { preparation, final: current, pixels, workload };
}

function atomicRows(report) {
  return report.executions.flatMap((row) =>
    row.atomicIds.map((atomicId, index) => ({
      ...row,
      atomicId,
      receipts: row.receipts ? [row.receipts[index]] : undefined,
    })),
  );
}
function deliveredBinding(prompt) {
  const targets = prompt.split("\n").flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row.mapping ? [row] : [];
    } catch {
      return [];
    }
  });
  assert.ok(targets.length > 0);
  return targets.map((target) => {
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
      assert.ok(!Object.hasOwn(target, key), `Private binding data reached the delivery: ${key}`);
    const owners = [...new Set(target.selectors.map((selector) => selector.owner?.scope))];
    assert.equal(owners.length, 1);
    assert.match(owners[0], /^frond::(?:North|South)$/);
    return { mapping: target.mapping[0], owner: owners[0] };
  });
}

function deliveredRepairBindings(options, source) {
  assert.deepEqual(options.atomicIds, []);
  assert.ok(options.repairTasks?.length > 0);
  const identifiers = cppTokens(source).filter((token) => /^[A-Za-z_]\w*$/.test(token.text));
  return options.repairTasks.flatMap((task) =>
    task.operations.map((operation) => {
      assert.equal(operation.phase, "repair");
      assert.ok(["rename-binding", "replace-identifier"].includes(operation.action));
      const token = identifiers[operation.target.identifier];
      assert.ok(token);
      assert.ok(token.text === operation.target.name || token.text === operation.required.name);
      const owner = [...source.matchAll(/int (North|South)\([^)]*\) \{[^}]*\}/g)].filter(
        (match) => match.index <= token.start && token.start < match.index + match[0].length,
      );
      assert.equal(owner.length, 1);
      return {
        mapping: { from: operation.target.name, to: operation.required.name },
        owner: `frond::${owner[0][1]}`,
        repairAction: operation.action,
      };
    }),
  );
}

async function waitForPeer(ready, signal) {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = Promise.withResolvers();
  const timer = setTimeout(
    () =>
      timeout.reject(
        Error("An independent binding was not dispatched while its peer remained active"),
      ),
    5000,
  );
  try {
    await Promise.race([ready, aborted.promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function bindingDrivers({ partialFirst = false } = {}) {
  const histories = [],
    calls = [];
  const concurrent = Promise.withResolvers();
  let writes = Promise.resolve(),
    deliveries = 0;
  const createDriver = async (workspace, _state, agent) => {
    const history = [];
    histories[agent] = history;
    let closed = false;
    return {
      get closed() {
        return closed;
      },
      async execute(prompt, options) {
        assert.equal(closed, false);
        const repair = options.deliveryKind === "barrier-repair";
        const bindings = repair
          ? deliveredRepairBindings(
              options,
              await readFile(path.join(workspace, "main.cpp"), "utf8"),
            )
          : deliveredBinding(prompt);
        assert.equal(
          bindings.length,
          repair ? options.repairTasks.length : options.atomicIds.length,
        );
        const selected = bindings.map((binding, index) => ({
          ...binding,
          ...options,
          atomicId: repair ? undefined : options.atomicIds[index],
          problemId: repair ? options.repairTasks[index].id : undefined,
          agent,
          sequence: history.length + 1,
        }));
        history.push(selected);
        calls.push(...selected);
        if (++deliveries >= 2) concurrent.resolve();
        await waitForPeer(concurrent.promise, options.signal);
        for (const call of selected) {
          writes = writes.then(async () => {
            const file = path.join(workspace, "main.cpp");
            const source = await readFile(file, "utf8");
            const functionName = call.owner.split("::").at(-1);
            const expression = new RegExp(`int ${functionName}\\([^)]*\\) \\{[^}]*\\}`);
            const selected = source.match(expression);
            assert.ok(selected, "The public owner must select one current function");
            assert.equal(source.match(new RegExp(expression.source, "g")).length, 1);
            const { from, to } = call.mapping;
            const positions = [...selected[0].matchAll(new RegExp(`\\b${from}\\b`, "g"))];
            if (partialFirst && from === "a" && options.attempt === 1) {
              assert.equal(positions.length, 2);
              call.partial = true;
            }
            const selectedPositions = call.partial ? positions.slice(0, 1) : positions;
            let result = selected[0];
            for (const position of selectedPositions.reverse())
              result =
                result.slice(0, position.index) + to + result.slice(position.index + from.length);
            call.before = selected[0];
            await writeFile(
              file,
              source.slice(0, selected.index) +
                result +
                source.slice(selected.index + selected[0].length),
            );
          });
          await writes;
        }
        return { sessionId: `naming-agent-${agent}`, sequence: history.length, status: "settled" };
      },
      async close() {
        closed = true;
      },
    };
  };
  return { createDriver, calls, histories };
}

await test(
  "partial compiler-certified atomic naming through preparation and the real runner",
  { timeout: 90_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/atomic-naming-runner-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await prepareNamingFixture(root, t.signal);
    const reference = await runConcurrent(fixture.preparation, path.join(root, "reference"), {
      signal: t.signal,
      log: quiet,
    });
    assert.equal(reference.status, "pass", JSON.stringify(reference.terminal));
    assert.equal(new Set(atomicRows(reference).map((row) => row.atomicId)).size, 4);
    assert.equal(reference.acceptedTasks, 2);
    assert.equal(reference.acceptedRounds, 1);
    assert.equal(reference.referencePlannerSlots, 2);
    assert.deepEqual(
      [...new Set(atomicRows(reference).map((row) => row.atomicId))].sort(),
      fixture.workload.nodes.map((node) => node.id).sort(),
    );
    const receipts = atomicRows(reference).map((row) => row.receipts[0]);
    assert.equal(new Set(receipts.map((receipt) => receipt.lifetime)).size, 2);
    assert.ok(receipts.every((receipt) => receipt.planner.snapshotAttempts >= 1));
    assert.ok(reference.referenceConcurrency.maxPlanning > 0);
    const proof = JSON.parse(
      await readFile(path.join(fixture.preparation, "verification-2.json"), "utf8"),
    );
    assert.equal(proof.acceptedAtomicEdits, 4);
    assert.deepEqual(proof.atomic, reference.atomic);
    assert.deepEqual(await readTree(path.join(root, "reference/workspace")), fixture.final);

    await t.test(
      "independent atomic bindings share ready batches while peer participants remain active",
      async () => {
        const drivers = bindingDrivers();
        const report = await runConcurrent(fixture.preparation, path.join(root, "live"), {
          createDriver: drivers.createDriver,
          signal: t.signal,
          log: quiet,
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        assert.equal(atomicRows(report).length, 4);
        assert.equal(report.repairs, 0);
        assert.ok(
          report.executions.every(
            (row) => !Object.hasOwn(row, "atomicCheck") && !Object.hasOwn(row, "atomicChecks"),
          ),
        );
        assert.ok(report.atomicBarriers.every((barrier) => !Object.hasOwn(barrier, "inputChecks")));
        assert.equal(report.acceptedTasks, 2);
        const northCalls = drivers.calls.filter((call) => call.owner === "frond::North");
        assert.deepEqual(northCalls.map((call) => call.mapping.from).sort(), ["a", "b"]);
        const firstPair = report.executions.filter((row) => row.attempt === 1);
        assert.equal(new Set(firstPair.map((row) => row.agent)).size, 2);
        assert.ok(
          Math.max(...firstPair.map((row) => row.startedMs)) <
            Math.min(...firstPair.map((row) => row.startedMs + row.elapsedMs)),
        );
        assert.ok(drivers.histories.every((history) => history.length >= 1));
        assert.equal(
          drivers.histories.reduce((sum, history) => sum + history.length, 0),
          report.deliveries,
        );
        assert.ok(report.agentsClosed.every(Boolean));
        assert.deepEqual(report.checks.at(-1).pixels, fixture.pixels);
        assert.deepEqual(await readTree(path.join(root, "live/workspace")), fixture.final);
      },
    );

    await t.test(
      "an incomplete binding is repaired by the next file queue after the full barrier",
      async () => {
        const drivers = bindingDrivers({ partialFirst: true });
        const report = await runConcurrent(fixture.preparation, path.join(root, "corrected"), {
          createDriver: drivers.createDriver,
          signal: t.signal,
          log: quiet,
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        assert.equal(report.acceptedTasks, 2);
        const first = drivers.calls.filter((call) => call.attempt === 1);
        assert.equal(first.length, 4);
        const failed = drivers.calls.filter((call) => call.mapping.from === "a");
        assert.equal(failed.length, 2);
        assert.ok(failed[0].partial);
        assert.deepEqual(
          failed.map((call) => call.attempt),
          [1, 2],
        );
        assert.notEqual(failed[1].agent, failed[0].agent);
        assert.equal(failed[1].repairAction, "replace-identifier");
        assert.deepEqual(failed[1].atomicIds, []);
        assert.ok(failed[1].problemId.startsWith("repair-round-001-attempt-2-"));
        assert.ok(
          report.executions
            .filter((row) => row.attempt > 1)
            .every(
              (row) =>
                row.tasks.length === 0 && row.atomicIds.length === 0 && row.repairIds.length > 0,
            ),
        );
        assert.match(failed[1].before, /int north_left, int north_right/);
        assert.match(failed[1].before, /return a \+ north_right/);
        const rejected = report.checks.find((check) => check.status === "fail");
        assert.equal(rejected.category, "structure");
        assert.equal(report.repairs, report.executions.filter((row) => row.attempt > 1).length);
        assert.ok(
          report.atomicBarriers.every(
            (barrier) =>
              !Object.hasOwn(barrier, "inputChecks") && !Object.hasOwn(barrier, "retained"),
          ),
        );
        assert.ok(report.executions.every((row) => !Object.hasOwn(row, "atomicChecks")));
        assert.deepEqual(report.checks.at(-1).pixels, fixture.pixels);
        assert.deepEqual(await readTree(path.join(root, "corrected/workspace")), fixture.final);
      },
    );
  },
);
