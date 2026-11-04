import assert from "node:assert/strict";
import { symbolSpecifications } from "./symbol-spec.mjs";
import { vendorSymbolSpecifications } from "./symbol-vendor.mjs";
import { ambiguityAnchors, ambiguityAnchorsProse } from "./ambiguity-anchors.mjs";
import { explicitFileContract } from "./explicit-contract.mjs";
import { macroAmbiguityAnchors, macroAmbiguityAnchorsProse } from "./macro-anchors.mjs";

/** Derive agent-visible inventories from a validated private extraction plan. */
export async function publicSymbolAssignments(
  plan,
  { deduplicateCopies = false, allowDuplicates = false, disambiguated = new Set() } = {},
) {
  assert.ok(Array.isArray(plan.tasks) && plan.tasks.length > 0);
  const assignments = new Map();
  const exclusive = new Map();
  for (const task of plan.tasks) {
    assert.equal(typeof task.id, "string");
    assert.ok(!assignments.has(task.id));
    const items = new Map();
    async function add(fragment, action) {
      for (const entity of await symbolSpecifications(
        { ...task, fragments: [fragment], using: [] },
        { allowDuplicates },
      )) {
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
      const copies = new Set();
      for (const entry of task.using ?? []) {
        const key = JSON.stringify([entry.scope, entry.text]);
        if (deduplicateCopies && copies.has(key)) continue;
        copies.add(key);
        await add({ ...entry, kind: "using" }, "copy");
      }
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
      assert.ok(
        !exclusive.has(key) ||
          (disambiguated.has(key) &&
            exclusive.get(key).kind !== "vendor-header" &&
            task.kind !== "vendor-header"),
        "Indistinguishable entities have different owners",
      );
      exclusive.set(key, { id: task.id, kind: task.kind });
      if (task.kind !== "vendor-header" && !disambiguated.has(key))
        assert.equal(entity.occurrences, undefined, "Indistinguishable definitions share an owner");
    }
    assignments.set(task.id, entities);
  }
  return assignments;
}

// Only definitions with the same public identity need source-level disambiguation.
async function definitionAnchors(source, tasks, neighbourAnchors) {
  const groups = new Map();
  for (const task of tasks) {
    if (task.kind === "vendor-header") continue;
    for (const fragment of task.fragments) {
      const entities = await symbolSpecifications(
        { ...task, fragments: [fragment], using: [] },
        { allowDuplicates: true },
      );
      for (const entity of entities) {
        if (
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
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ task, fragment });
      }
    }
  }
  const disambiguated = new Set();
  const hints = new Map();
  const hinted = new Set();
  for (const [key, occurrences] of groups) {
    if (occurrences.length < 2) continue;
    for (const { task, fragment } of occurrences) {
      if (neighbourAnchors.get(task.id).some((anchor) => anchor.fragmentId === fragment.id))
        continue;
      const hintKey = JSON.stringify([task.id, fragment.id]);
      if (hinted.has(hintKey)) continue;
      hinted.add(hintKey);
      assert.equal(source.slice(fragment.start, fragment.end), fragment.text, "Stale fragment");
      let left = fragment.start,
        right = fragment.end;
      assert.ok(right > left, "Empty ambiguous source fragment");
      let radius = 1;
      while (
        source.indexOf(source.slice(left, right)) !== source.lastIndexOf(source.slice(left, right))
      ) {
        assert.ok(left > 0 || right < source.length, "Cannot expand ambiguous source anchor");
        const before = Math.max(0, fragment.start - radius);
        const after = Math.min(source.length, fragment.end + radius);
        left = before ? source.lastIndexOf("\n", before - 1) + 1 : 0;
        const newline = source.indexOf("\n", after);
        right = newline < 0 ? source.length : newline + 1;
        radius *= 2;
      }
      const context = source.slice(left, right);
      let length = 3;
      for (const [run] of context.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
      const mark = "`".repeat(length);
      const start = 1 + (source.slice(0, fragment.start).match(/\n/g) ?? []).length;
      const end = 1 + (source.slice(0, fragment.end - 1).match(/\n/g) ?? []).length;
      if (!hints.has(task.id)) hints.set(task.id, []);
      hints
        .get(task.id)
        .push(
          `An assigned definition has a competing public signature. It was on snapshot lines ${start} through ${end}. Re-read main.cpp and proceed only if the following exact context occurs once. The assigned fragment starts ${fragment.start - left} JavaScript UTF-16 code units into that context and has length ${fragment.text.length} code units. If the context is missing or ambiguous, report the ambiguity. Snapshot lines may be stale.\n${mark}\n${context}${context.endsWith("\n") ? "" : "\n"}${mark}`,
        );
    }
    disambiguated.add(key);
  }
  return { disambiguated, hints };
}
/** Compose public file requirements, refusing ambiguity without a verified anchor. */
export async function publicExplicitAssignments(plan) {
  const source = plan.initial?.["main.cpp"];
  assert.equal(typeof source, "string");
  const neighbourAnchors = new Map();
  for (const task of plan.tasks)
    neighbourAnchors.set(task.id, await ambiguityAnchors(source, task));
  const { disambiguated, hints: definitionHints } = await definitionAnchors(
    source,
    plan.tasks,
    neighbourAnchors,
  );
  const symbols = await publicSymbolAssignments(plan, {
    deduplicateCopies: true,
    allowDuplicates: true,
    disambiguated,
  });
  const assignments = new Map();
  for (const task of plan.tasks) {
    const anchors = neighbourAnchors.get(task.id);
    const macros = task.kind === "vendor-header" ? [] : await macroAmbiguityAnchors(source, task);
    const contract = await explicitFileContract(task, {
      anchoredFragments: new Set(anchors.map(({ fragmentId }) => fragmentId)),
      anchoredMacros: new Set(macros.map(({ signature }) => signature)),
      disambiguated,
    });
    const hints = [
      ambiguityAnchorsProse(anchors),
      macroAmbiguityAnchorsProse(macros),
      ...(definitionHints.get(task.id) ?? []),
    ].filter(Boolean);
    assignments.set(task.id, { entities: symbols.get(task.id), contract, hints });
  }
  return assignments;
}
