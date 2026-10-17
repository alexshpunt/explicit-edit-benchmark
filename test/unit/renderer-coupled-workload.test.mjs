import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWorkload } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-workload.mjs";
import { appendCoherentNamingTask } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { assembleAtomicBundle } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-bundle.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import {
  applyScopedNamePlan,
  scopedNamingSession,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

// Controlled certification tests the trusted preparation format, not compiler
// coupling. Shared-call semantic evidence is exercised in the compiler tests.
function fixture() {
  const source = `namespace frond {
int old(int value) { return value; }
double old(double value) { return value; }
long old(long left, long right) { return left + right; }
template <typename T>
T use(T value) { return old(value); }
}
int main() { return frond::use(1) + (int)frond::use(2.0); }
`;
  const tree = { "main.cpp": source };
  const mapping = { from: "old", to: "restored" };
  const selectors = ["int (int)", "double (double)", "long (long, long)"].map((signature) => ({
    kind: "function",
    scope: "frond::old",
    owner: { scope: "frond::old", signature, definition: true },
  }));
  const groups = [
    { mapping, selectors: selectors.slice(0, 2), bindingCount: 2 },
    { mapping, selectors: selectors.slice(2), bindingCount: 1 },
  ];
  const original = {
    id: "overloads",
    phase: "names",
    category: "functions-types",
    mapping: [mapping],
    selectors,
  };
  const operation = {
    ...original,
    bindingGroups: groups,
    bindingCertification: certificate(groups),
  };
  const edits = [...source.matchAll(/\bold\b/g)].map((match) => ({
    file: "main.cpp",
    start: match.index,
    old: "old",
    new: "restored",
  }));
  const atoms = groups.map((group, bindingGroup) => ({
    bindingGroup,
    operation: { ...original, mapping: [mapping], selectors: group.selectors },
    plan: {
      id: original.id,
      edits: bindingGroup === 0 ? [edits[0], edits[1], edits[3]] : [edits[2]],
    },
  }));
  const certification = { operation, atoms, plan: { id: original.id, edits } };
  const task = {
    id: "task-001",
    phase: "names",
    goal: "Restore overloads",
    operations: [operation],
  };
  return { tree, certification, task };
}
function certificate(groups) {
  return {
    version: "renderer-atomic-bindings-v1",
    sha256: createHash("sha256").update(JSON.stringify(groups)).digest("hex"),
  };
}
function reseal(value) {
  value.certification.operation.bindingCertification = certificate(
    value.certification.operation.bindingGroups,
  );
}
function seal(value) {
  return coherentNamingPlans(value.tree, [value.certification.plan], [], [value.certification]);
}

test("one inseparable overload delivery preserves distinct semantic binding counts", () => {
  const { task } = fixture();
  const before = structuredClone(task);
  const result = atomicWorkload([task]);
  assert.deepEqual(task, before);
  assert.equal(result.nodes.length, 2);
  assert.deepEqual(
    result.nodes.map((node) => node.bindingCount),
    [2, 1],
  );
  assert.deepEqual(
    result.nodes.map((node) => node.dependencies),
    [[], []],
  );
  assert.equal(result.summary.groups, 1);
  assert.equal(result.summary.originalOperations, 1);
  assert.equal(result.summary.renameMappings, 1);
  assert.equal(result.summary.atomicEdits, 2);
  assert.equal(result.summary.namingBindings, 3);
  assert.equal(result.summary.namingEdits, 2);
  assert.equal(result.summary.coupledNamingEdits, 1);
  for (const node of result.nodes) {
    assert.equal(node.taskId, "task-001");
    assert.equal(node.operations[0].mapping.length, 1);
    assert.ok(!Object.hasOwn(node.operations[0], "bindingCount"));
  }
});

test("certified overload counts survive sealing and complete private bundle replay", async () => {
  const value = fixture();
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/coupled-private-preparation-"));
  let session;
  try {
    session = await scopedNamingSession(value.tree, directory);
    const {
      bindingGroups: _groups,
      bindingCertification: _certificate,
      ...original
    } = value.certification.operation;
    value.certification = await session.atomicPlans({
      ...original,
      prompt: "Legacy inventory prose",
      dependsOn: ["earlier-inventory-item"],
    });
    const tasks = [];
    appendCoherentNamingTask(tasks, original.category, "main.cpp", [value.certification.operation]);
    value.task = tasks[0];
    const record = seal(value);
    const before = structuredClone(record);
    const final = applyScopedNamePlan(value.tree, value.certification.plan);
    const result = assembleAtomicBundle(value.tree, [value.task], {
      namingPlans: new Map([[value.task.id, record]]),
      contracts: new Map([[value.task.id, prepareCoherentContract(final)]]),
    });
    assert.deepEqual(record, before);
    assert.deepEqual(
      record.bindings[0].operation.bindingGroups.map((group) => group.bindingCount),
      [2, 1],
    );
    assert.ok(record.bindings[0].atoms[0].coupling.origin);
    assert.deepEqual(result.tree, final);
    assert.equal(result.batches[0].batch.ids.length, 2);
    assert.equal(result.workload.summary.namingBindings, 3);
    assert.equal(result.workload.summary.namingEdits, 2);
    const missing = structuredClone(value);
    delete missing.certification.atoms[0].coupling;
    assert.throws(() => seal(missing), /Missing compiler-certified/);
  } finally {
    session?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("coupling evidence rebases after earlier length changes and reseals without losing its origin", async () => {
  const value = fixture();
  value.tree["main.cpp"] = "int prefix = 0;\n" + value.tree["main.cpp"];
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/coupled-origin-rebase-"));
  let session;
  try {
    const {
      bindingGroups: _groups,
      bindingCertification: _certificate,
      ...original
    } = value.certification.operation;
    session = await scopedNamingSession(value.tree, directory);
    const certified = await session.atomicPlans(original);
    const earlier = {
      id: "earlier-module",
      edits: [{ file: "main.cpp", start: 4, old: "prefix", new: "longer_prefix" }],
    };
    const current = applyScopedNamePlan(value.tree, earlier);
    const record = coherentNamingPlans(current, [certified.plan], [earlier], [certified]);
    const coupled = record.bindings[0].atoms.find((atom) => atom.coupling);
    const originalCoupling = certified.atoms.find((atom) => atom.coupling).coupling;
    const delta = "longer_prefix".length - "prefix".length;
    assert.deepEqual(coupled.coupling.origin, originalCoupling);
    assert.deepEqual(
      coupled.coupling.sites.map((site) => site.start),
      originalCoupling.sites.map((site) => site.start + delta),
    );
    assert.deepEqual(
      coupled.coupling.members.map((member) => member.map((site) => site.start)),
      originalCoupling.members.map((member) => member.map((site) => site.start + delta)),
    );
    const sealedAgain = coherentNamingPlans(
      current,
      record.plans,
      [],
      record.bindings.map((binding, index) => ({ ...binding, plan: record.plans[index] })),
    );
    assert.deepEqual(sealedAgain, record);
  } finally {
    session?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing or impossible binding counts cannot enter workload or private preparation", () => {
  for (const count of [undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", 3]) {
    const value = fixture();
    value.certification.operation.bindingGroups[0].bindingCount = count;
    reseal(value);
    assert.throws(() => atomicWorkload([value.task]), /binding|Binding|certification/i);
    assert.throws(() => seal(value), /binding|Binding|certification/i);
  }
});

test("inseparable groups cannot claim several non-function bindings", () => {
  const value = fixture();
  for (const selector of value.certification.operation.bindingGroups[0].selectors)
    selector.kind = "variable";
  reseal(value);
  assert.throws(() => atomicWorkload([value.task]), /binding|Binding|certification/i);
  assert.throws(() => seal(value), /binding|Binding|certification/i);
});
