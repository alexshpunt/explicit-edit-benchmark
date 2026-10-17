import assert from "node:assert/strict";
import { atomicOrder, atomicEffectGraph } from "./atomic-effects.mjs";
import { applyScopedNamePlan } from "../cpp/scoped-names.mjs";
import { applyCoherentStructure } from "../reference/coherent-edit.mjs";
import { prepareAtomicGate } from "../grading/atomic-gate.mjs";
import { evaluateCoherentContract } from "../grading/coherent-grade.mjs";

function bindingPlan(node, plan) {
  assert.ok(plan?.edits?.length, "Missing or empty private atomic binding plan");
  const mappings = node.operations.flatMap((operation) => operation.mapping);
  assert.equal(mappings.length, 1, "Atomic binding requires exactly one mapping");
  const [mapping] = mappings;
  assert.ok(
    plan.edits.every((edit) => edit.old === mapping.from && edit.new === mapping.to),
    "Private binding effect differs from the public mapping",
  );
  return plan;
}

/** Seal immediate private effects in a legal current-selector order.
 * Naming plans must be compiler-selected and bound by their preparation hash to
 * this group's starting tree. Their offsets share that snapshot; earlier atomic
 * edits are rebased during application. Structural atoms use only their public
 * operations. No gates, physical origins or expected source enter worker mounts.
 * An optional coarse endpoint proves this split preserves the original goal.
 * Returned gates describe this trusted order; callers must reconstruct structural
 * context for a different concurrent frontier before using them as live gates.
 */
export function sealAtomicEffects(before, nodes, { plans = new Map(), expected } = {}) {
  let current = before;
  const applied = [];
  const effects = [];
  const gates = new Map();
  for (const node of atomicOrder(nodes)) {
    assert.ok(node.operations.length, "Empty atomic operations");
    const phase = node.operations[0].phase;
    assert.ok(
      node.operations.every((operation) => operation.phase === phase),
      "Mixed atomic phases",
    );
    let after, plan;
    if (phase === "names") {
      plan = bindingPlan(node, plans.get(node.id));
      after = applyScopedNamePlan(current, plan, applied);
      applied.push(plan);
    } else {
      assert.equal(phase, "structure", "Unsupported atomic phase");
      after = node.operations.reduce(applyCoherentStructure, current);
    }
    const gate = prepareAtomicGate(current, after);
    effects.push({ id: node.id, gate, ...(plan ? { plan } : {}) });
    gates.set(node.id, gate);
    current = after;
  }
  if (expected)
    assert.equal(
      evaluateCoherentContract(current, expected).status,
      "pass",
      "Atomic split changed the coarse endpoint",
    );
  return { tree: current, graph: atomicEffectGraph(nodes, effects), gates };
}
