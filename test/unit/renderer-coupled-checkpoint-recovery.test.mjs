import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  applyScopedNamePlan,
  scopedNamingSession,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
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
const decision = (result) =>
  result.status === "pass" ? true : result.status === "pending" ? "pending" : false;

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
    // A controlled successor exercises verified-only readiness, independently of
    // the compiler's selector-dependency inference.
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
      dependent,
      byId,
      missing,
      checkpoint: createAtomicCheckpoint(initial, nodes, bundle.batches),
    };
  } finally {
    session.close();
  }
}

await test("compiler-certified inseparable overloads remain one checkpoint and repair unit", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/coupled-checkpoint-recovery-"));
  try {
    const value = await fixture(directory);
    const { initial, final, nodes, coupled, independent, dependent, byId, missing, checkpoint } =
      value;
    const coupledPlan = byId.get(coupled.id);
    const independentPlan = byId.get(independent.id);

    await t.test("each declaration and the shared callee are mandatory output sites", () => {
      const context = {
        completed: new Set([independent.id]),
        started: new Set([independent.id, coupled.id]),
        settled: new Set([independent.id, coupled.id]),
      };
      const complete = applyScopedNamePlan(initial, {
        id: "complete-pair",
        edits: [...independentPlan.edits, ...coupledPlan.edits],
      });
      assert.equal(checkpoint.check(complete, coupled.id, context).status, "pass");
      for (const omitted of coupledPlan.edits) {
        const partial = applyScopedNamePlan(initial, {
          id: "incomplete-pair",
          edits: [
            ...independentPlan.edits,
            ...coupledPlan.edits.filter((edit) => edit !== omitted),
          ],
        });
        assert.equal(checkpoint.check(partial, coupled.id, context).status, "fail");
        assert.equal(checkpoint.check(partial, independent.id, context).status, "pass");
      }
    });

    await t.test(
      "partial coupled output blocks its successor and repairs once without repeating its peer",
      async () => {
        let tree = initial;
        const applied = [];
        const deliveries = [];
        const outputs = [];
        const read = async () => ({ ...tree });
        const gates = {
          checkInputs: async (node, signal, context) => {
            for (const predecessor of node.dependencies) {
              const checked = await checkpoint.observe(read, predecessor, context, { signal });
              if (checked.status !== "pass") return decision(checked);
            }
            return decision(
              await checkpoint.observe(read, node.id, context, { input: true, signal }),
            );
          },
          verify: async (node, signal, _receipt, context) => {
            const checked = await checkpoint.observe(read, node.id, context, { signal });
            outputs.push({ id: node.id, status: checked.status });
            return decision(checked);
          },
        };
        const write = (plan) => {
          tree = applyScopedNamePlan(tree, plan, applied);
          applied.push(plan);
        };
        const first = await runAtomicStream(nodes, {
          agents: 2,
          ...gates,
          execute: async (node) => {
            deliveries.push(node.id);
            assert.notEqual(node.id, dependent.id);
            write(
              node.id === coupled.id
                ? { ...coupledPlan, edits: coupledPlan.edits.filter((edit) => edit !== missing) }
                : byId.get(node.id),
            );
          },
        });
        assert.equal(first.status, "blocked");
        assert.deepEqual([...first.completed], [independent.id]);
        assert.deepEqual(first.failed, [coupled.id]);
        assert.ok(!first.started.has(dependent.id));
        assert.ok(outputs.some((entry) => entry.id === coupled.id && entry.status === "fail"));
        assert.ok(tree["main.cpp"].includes("void old(const Box<Byte>&)"));
        assert.ok(tree["main.cpp"].includes("void restored(const Box<Float>&)"));
        assert.ok(tree["main.cpp"].includes("restored(value)"));

        const retained = checkpoint.revalidate(tree, {
          completed: first.completed,
          started: first.started,
          settled: first.started,
        });
        assert.deepEqual([...retained.completed], [independent.id]);
        assert.deepEqual(retained.invalidated, []);
        const repaired = await runAtomicStream(nodes, {
          agents: 2,
          completed: retained.completed,
          started: first.started,
          rotation: first.rotation,
          ...gates,
          execute: async (node) => {
            deliveries.push(node.id);
            assert.notEqual(node.id, independent.id);
            if (node.id === dependent.id) {
              assert.ok(
                outputs.some((entry) => entry.id === coupled.id && entry.status === "pass"),
              );
              write(byId.get(node.id));
            } else {
              assert.equal(node.id, coupled.id);
              write({ ...coupledPlan, edits: [missing] });
            }
          },
        });
        assert.equal(repaired.status, "pass");
        assert.equal(repaired.completed.size, 3);
        assert.deepEqual(deliveries, [independent.id, coupled.id, coupled.id, dependent.id]);
        assert.deepEqual(tree, final);
        for (const node of nodes)
          assert.equal(
            checkpoint.check(tree, node.id, { completed: repaired.completed }).status,
            "pass",
          );
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
