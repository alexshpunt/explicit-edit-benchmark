import assert from "node:assert/strict";
import { symbolSpecifications } from "./symbol-spec.mjs";
import { vendorSymbolSpecifications } from "./symbol-vendor.mjs";

/** Derive agent-visible inventories from a validated private extraction plan. */
export async function publicSymbolAssignments(plan) {
  assert.ok(Array.isArray(plan.tasks) && plan.tasks.length > 0);
  const assignments = new Map();
  const exclusive = new Map();
  for (const task of plan.tasks) {
    assert.equal(typeof task.id, "string");
    assert.ok(!assignments.has(task.id));
    const items = new Map();
    async function add(fragment, action) {
      for (const entity of await symbolSpecifications({
        ...task,
        fragments: [fragment],
        using: [],
      })) {
        const key = JSON.stringify([entity.scope, entity.kind, entity.signature, action]);
        const existing = items.get(key);
        if (existing) existing.count++;
        else items.set(key, { entity, action, count: 1 });
      }
    }
    if (task.kind === "vendor-header") {
      for (const { count, ...entity } of await vendorSymbolSpecifications(task)) {
        const key = JSON.stringify([
          entity.scope,
          entity.kind,
          entity.signature,
          entity.members ?? [],
          "move",
        ]);
        assert.ok(!items.has(key));
        items.set(key, { entity, action: "move", count: count ?? 1 });
      }
    } else {
      for (const fragment of task.fragments) await add(fragment, "move");
      for (const entry of task.using ?? []) await add({ ...entry, kind: "using" }, "copy");
    }
    const entities = [...items.values()].map(({ entity, action, count }) => ({
      ...entity,
      ...(action === "copy" ? { action } : {}),
      ...(count > 1 ? { occurrences: count } : {}),
    }));
    entities.sort((a, b) => {
      const left = JSON.stringify([
        a.scope,
        a.kind,
        a.signature,
        a.members ?? [],
        a.action ?? "move",
      ]);
      const right = JSON.stringify([
        b.scope,
        b.kind,
        b.signature,
        b.members ?? [],
        b.action ?? "move",
      ]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    assert.ok(entities.length > 0, "An assignment has no identifiable entities");
    for (const entity of entities) {
      if (
        entity.action === "copy" ||
        !["function-definition", "struct", "class", "union", "enum", "variable"].includes(
          entity.kind,
        )
      )
        continue;
      const key = JSON.stringify([
        entity.scope,
        entity.kind,
        entity.signature,
        entity.members ?? [],
      ]);
      assert.ok(!exclusive.has(key), "Indistinguishable entities have different owners");
      exclusive.set(key, task.id);
      if (task.kind !== "vendor-header")
        assert.equal(entity.occurrences, undefined, "Indistinguishable definitions share an owner");
    }
    assignments.set(task.id, entities);
  }
  return assignments;
}
