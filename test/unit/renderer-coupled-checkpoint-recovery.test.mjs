import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  applyScopedNamePlan,
  scopedNamingSession,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { assembleAtomicBundle } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-bundle.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { appendCoherentNamingTask } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";

const source = `namespace frond {
struct Float {}; struct Byte {};
template<class T> struct Box {};
void old(const Box<Float>&) {}
void old(const Box<Byte>&) {}
void old(int, int) {}
void direct() { old(1, 2); }
template<typename T> void shared(const Box<T>& value) { old(value); }
void follow() {}
}
int main() { frond::shared(frond::Box<frond::Float>{}); frond::shared(frond::Box<frond::Byte>{}); frond::direct(); }
`;
async function fixture(directory) {
  const initial = { "main.cpp": source };
  const session = await scopedNamingSession(initial, directory);
  try {
    const certifications = [];
    for (const [from, to] of [
      ["old", "restored"],
      ["follow", "finished"],
    ])
      certifications.push(
        await session.atomicPlans({
          id: `rename-${from}`,
          phase: "names",
          category: "functions-types",
          mapping: [{ from, to }],
          selectors: [{ kind: "function", scope: `frond::${from}` }],
        }),
      );
    const tasks = [];
    const task = appendCoherentNamingTask(
      tasks,
      "functions-types",
      "main.cpp",
      certifications.map((entry) => entry.operation),
    );
    const plans = certifications.map((entry) => entry.plan);
    const sealed = coherentNamingPlans(initial, plans, [], certifications);
    const final = applyScopedNamePlan(initial, {
      id: "all-names",
      edits: plans.flatMap((plan) => plan.edits),
    });
    const bundle = assembleAtomicBundle(initial, tasks, {
      namingPlans: new Map([[task.id, sealed]]),
      contracts: new Map([[task.id, prepareCoherentContract(final)]]),
    });
    const coupled = bundle.workload.nodes.find((node) => node.bindingCount === 2);
    const independent = bundle.workload.nodes.find(
      (node) => node.bindingCount === 1 && node.sourceOperations[0] === 0,
    );
    const dependent = bundle.workload.nodes.find((node) => node.sourceOperations[0] === 1);
    assert.ok(coupled && independent && dependent);
    assert.equal(bundle.workload.nodes.length, 3);
    assert.deepEqual(coupled.dependencies, []);
    assert.deepEqual(independent.dependencies, []);
    // Keep a controlled dependency edge without introducing intermediate checks.
    const nodes = [independent, coupled, { ...dependent, dependencies: [coupled.id] }];
    const byId = new Map(
      nodes.map((node) => [
        node.id,
        sealed.bindings[node.sourceOperations[0]].atoms[node.bindingGroup].plan,
      ]),
    );
    const coupledAtom = sealed.bindings[0].atoms[coupled.bindingGroup];
    assert.equal(coupledAtom.coupling.members.length, 2);
    assert.equal(coupledAtom.coupling.sites.length, 1);
    assert.equal(coupledAtom.plan.edits.length, 3);
    const missing = coupledAtom.plan.edits.find((edit) =>
      source.slice(edit.start).startsWith("old(const Box<Byte>&)"),
    );
    assert.ok(missing);
    return {
      initial,
      final,
      nodes,
      coupled,
      independent,
      dependent: nodes.find((node) => node.id === dependent.id),
      byId,
      missing,
    };
  } finally {
    session.close();
  }
}

await test("compiler-certified inseparable overloads preserve every site at the full barrier", async () => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/coupled-barrier-"));
  try {
    const { initial, final, nodes, coupled, independent, dependent, byId } =
      await fixture(directory);
    const contract = prepareCoherentContract(final);
    const all = nodes.flatMap((node) => byId.get(node.id).edits);
    const complete = applyScopedNamePlan(initial, { id: "complete", edits: all });
    assert.deepEqual(complete, final);
    assert.equal(evaluateCoherentContract(complete, contract).status, "pass");
    assert.deepEqual(dependent.dependencies, [coupled.id]);
    assert.deepEqual(independent.dependencies, []);
    for (const omitted of byId.get(coupled.id).edits) {
      const partial = applyScopedNamePlan(initial, {
        id: "incomplete",
        edits: all.filter((edit) => edit !== omitted),
      });
      assert.equal(evaluateCoherentContract(partial, contract).status, "fail");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
