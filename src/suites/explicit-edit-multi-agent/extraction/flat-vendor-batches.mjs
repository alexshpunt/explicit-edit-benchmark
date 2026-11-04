import assert from "node:assert/strict";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { flatVendorContract } from "./flat-vendor-contract.mjs";

function entityCounts(entities) {
  const counts = new Map();
  for (const { count = 1, ...entity } of entities) {
    const key = JSON.stringify(entity);
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right));
}

function describeDirective(item) {
  switch (item.kind) {
    case "pragma-once": {
      return "#pragma once";
    }
    case "include": {
      return `#include ${item.name}`;
    }
    case "macro": {
      return `the original definition of macro ${item.name}`;
    }
    case "undef": {
      return `#undef ${item.name}`;
    }
    default: {
      throw new Error("Unsupported vendor directive");
    }
  }
}

function describeEntity({ kind, signature, members, count = 1 }) {
  const fields = members?.length ? `, with members ${members.join(" ")}` : "";
  return `${kind.replaceAll("-", " ")} ${signature}${fields}${count > 1 ? ` (${count} occurrences)` : ""}`;
}

function identity(fact) {
  const outer = fact.directives.find((directive) => !directive.inside);
  if (outer) return describeDirective(outer);
  if (fact.entities.length === 1) return describeEntity(fact.entities[0]);
  throw new Error("Unsupported vendor positioning anchor");
}

/** Prepare source-ordered, batch-scoped vendor inventories.
 * Private source fragments and macro bodies are never returned in the prose.
 * The caller supplies live occurrence disambiguation and schedules batches of a
 * file in order; this function does not coordinate simultaneous edits.
 */
export async function prepareFlatVendorBatches(task, contract) {
  const role = task.kind === "vendor-header" ? "header" : "implementation";
  assert.ok(task.kind === "vendor-header" || task.kind === "implementation");
  assert.equal(contract.version, "flat-vendor-contract-v1");
  assert.equal(contract.role, role);
  assert.ok(Array.isArray(task.fragments) && task.fragments.length > 0);
  assert.equal(typeof task.preamble, "string");
  assert.ok(task.destination.startsWith(task.preamble));
  assert.equal(task.replacement, role === "header" ? `#include "${task.file}"\n` : "");
  assert.ok(!task.using?.length, "Copied imports in vendor tasks are unsupported");

  const preamble = await flatVendorContract(task.preamble, role);
  assert.deepEqual(preamble.entities, []);
  // The implementation's included header may live in a different directory.
  if (role === "header") assert.deepEqual(preamble.directives, [{ kind: "pragma-once" }]);
  else assert.ok(preamble.directives.length === 1 && preamble.directives[0].kind === "include");
  let cursor = task.preamble.length;
  const gaps = [];
  const facts = [];
  const ids = new Set();
  for (const fragment of task.fragments) {
    assert.ok(typeof fragment.id === "string" && !ids.has(fragment.id));
    ids.add(fragment.id);
    assert.equal(typeof fragment.text, "string");
    assert.ok(fragment.text.length > 0);
    const start = task.destination.indexOf(fragment.text, cursor);
    assert.ok(start >= cursor, "Vendor destination does not contain a source-ordered fragment");
    gaps.push(task.destination.slice(cursor, start));
    cursor = start + fragment.text.length;
    const result = await flatVendorContract(fragment.text, role);
    assert.ok(result.directives.length || result.entities.length, "Empty vendor unit unsupported");
    facts.push({ fragment, directives: result.directives, entities: result.entities });
  }
  gaps.push(task.destination.slice(cursor));
  assert.ok(
    cppTokens(gaps.join("\n")).every((token) => /^(?:\/\/|\/\*)/.test(token.text)),
    "Vendor destination contains unassigned source",
  );
  assert.deepEqual(
    [...preamble.directives, ...facts.flatMap((fact) => fact.directives)],
    contract.directives,
    "Vendor directives do not match their complete contract",
  );
  assert.deepEqual(
    entityCounts(facts.flatMap((fact) => fact.entities)),
    entityCounts(contract.entities),
    "Vendor entities do not match their complete contract",
  );
  const byId = new Map(facts.map((fact, index) => [fact.fragment.id, { ...fact, index }]));
  return {
    render(fragments) {
      assert.ok(Array.isArray(fragments) && fragments.length > 0);
      const selected = fragments.map((fragment) => {
        const fact = byId.get(fragment.id);
        assert.ok(fact && fact.fragment === fragment, "Unknown vendor fragment");
        return fact;
      });
      for (let index = 1; index < selected.length; index++)
        assert.equal(
          selected[index].index,
          selected[index - 1].index + 1,
          "Vendor batch must be contiguous and source ordered",
        );
      const first = selected[0].index === 0;
      const directives = selected.flatMap((fact) => fact.directives);
      const entities = selected.flatMap((fact) => fact.entities);
      const contents = selected.flatMap((fact) => [
        ...fact.entities.map((entity) => `Move ${describeEntity(entity)}.`),
        ...fact.directives.map(
          (directive) =>
            `${directive.inside ? `Inside ${directive.inside.signature}, preserve` : "Move"} ${describeDirective(directive)}${directive.kind === "macro" ? " with its existing replacement text" : ""}.`,
        ),
      ]);
      const lines = [
        `Move the following complete assigned vendor units from main.cpp into ${task.file}, preserving their original code and their order.`,
        first
          ? `Create the destination beginning with ${describeDirective(preamble.directives[0])}. ${task.replacement ? `Replace the first assigned source unit with ${task.replacement.trim()}.` : "Remove the assigned source units without a replacement include."}`
          : `Insert these units after ${identity(facts[selected[0].index - 1])} in the destination. This preceding unit is context, not part of this assignment. Remove the assigned units from main.cpp without adding an include.`,
        "Preserve the remaining source and destination units. Keep nested directives inside their existing function and keep all directive and unit ordering.",
        ...contents,
      ];
      return { prompt: lines.join("\n\n"), first, directives, entities };
    },
  };
}
