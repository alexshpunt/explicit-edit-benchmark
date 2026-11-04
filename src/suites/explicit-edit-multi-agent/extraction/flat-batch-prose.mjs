import assert from "node:assert/strict";
import { ambiguityAnchorsProse, locateAnchoredFragment } from "./ambiguity-anchors.mjs";
import { assertFlatHintContexts } from "./flat-live-hints.mjs";
import { currentBatchAnchors } from "./flat-batch-live.mjs";
import { macroAmbiguityAnchors, macroAmbiguityAnchorsProse } from "./macro-anchors.mjs";
import { preambleContractProse } from "./preamble-contract.mjs";
import { symbolSpecifications } from "./symbol-spec.mjs";
import { prepareFlatVendorBatches } from "./flat-vendor-batches.mjs";

function contextAnchor(source, fragment) {
  assert.equal(source.slice(fragment.start, fragment.end), fragment.text);
  let left = fragment.start;
  let right = fragment.end;
  let radius = 1;
  while (
    source.indexOf(source.slice(left, right)) !== source.lastIndexOf(source.slice(left, right))
  ) {
    assert.ok(left > 0 || right < source.length, "Cannot isolate ambiguous fragment");
    const start = Math.max(0, fragment.start - radius);
    left = start ? source.lastIndexOf("\n", start - 1) + 1 : 0;
    const end = Math.min(source.length, fragment.end + radius);
    const newline = source.indexOf("\n", end);
    right = newline < 0 ? source.length : newline + 1;
    radius *= 2;
  }
  return {
    fragmentId: fragment.id,
    target: fragment.text,
    startLine: 1 + (source.slice(0, fragment.start).match(/\n/g) ?? []).length,
    endLine: 1 + (source.slice(0, fragment.end - 1).match(/\n/g) ?? []).length,
    targetSide: "context",
    anchor: source.slice(left, right),
    offset: fragment.start - left,
  };
}

/** Prepare only public per-fragment facts. The caller must validate each result
 * against the live source immediately before delivery. This does not protect a
 * later edit against simultaneous source changes.
 *
 * Flat vendor contracts use their own batch-scoped inventories.
 */
export async function prepareFlatBatchProse(plan, contracts) {
  assert.equal(typeof plan.initial?.["main.cpp"], "string");
  assert.ok(contracts instanceof Map);
  const source = plan.initial["main.cpp"];
  const facts = new Map();
  const vendors = new Map();
  const ownership = new Map();
  const copiedMacros = new Map();
  const lineOffsets = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") lineOffsets.push(index + 1);
  for (const task of plan.tasks) {
    const contract = contracts.get(task.id);
    assert.ok(contract, "Missing batch contract");
    if (contract.flatVendor) {
      vendors.set(task.id, await prepareFlatVendorBatches(task, contract.flatVendor));
      continue;
    }
    assert.ok(!contract.vendor && !contract.vendorActivation, "Unsupported vendor contract");
    assert.ok(["header", "implementation"].includes(task.kind));
    assert.ok(!contract.conditionals?.length, "Conditional batch contract is unsupported");
    assert.ok(Array.isArray(contract.preamble));
    const allMacros = await macroAmbiguityAnchors(source, task);
    copiedMacros.set(
      task.id,
      allMacros.filter(({ action }) => action === "copy"),
    );
    const movedMacros = allMacros.filter(({ action }) => action === "move");
    for (const fragment of task.fragments) {
      assert.ok(!facts.has(fragment.id), "Duplicate fragment id");
      const entities = await symbolSpecifications(
        { fragments: [fragment], using: [] },
        { allowDuplicates: true },
      );
      assert.ok(entities.length > 0, "Fragment has no public entity");
      assert.ok(
        !fragment.beforeFragment && !fragment.afterFragment,
        "Neighbour anchor requires an explicit dependency",
      );
      const macros = movedMacros.filter(({ line }) => {
        const at = source.indexOf("#", lineOffsets[line - 1]);
        return at >= fragment.start && at < fragment.end;
      });
      // A public signature can also occur in residual source, not just another
      // assigned fragment. In that case provide a checked occurrence anchor.
      const needsAnchor = entities.some(({ signature }) => {
        const at = source.indexOf(signature);
        return at < 0 || at !== source.lastIndexOf(signature);
      });
      const fact = {
        fragment,
        task,
        entities,
        macros,
        anchors: needsAnchor ? [contextAnchor(source, fragment)] : [],
      };
      facts.set(fragment.id, fact);
      for (const { scope, kind, signature } of entities) {
        const key = JSON.stringify([scope, kind, signature]);
        if (!ownership.has(key)) ownership.set(key, new Set());
        ownership.get(key).add(fragment.id);
      }
    }
  }
  for (const owners of ownership.values()) {
    if (owners.size < 2) continue;
    for (const id of owners) {
      const fact = facts.get(id);
      if (!fact.anchors.length) fact.anchors.push(contextAnchor(source, fact.fragment));
    }
  }
  return {
    render(task, fragments, { currentSource, completed, projection } = {}) {
      assert.ok(fragments.length > 0);
      if (vendors.has(task.id)) {
        if (currentSource !== undefined)
          for (const fragment of fragments) {
            const start = currentSource.indexOf(fragment.text);
            assert.ok(
              start >= 0 && start === currentSource.lastIndexOf(fragment.text),
              "Vendor unit is missing or ambiguous",
            );
          }
        return { ...vendors.get(task.id).render(fragments), anchors: [], hints: [] };
      }
      const selected = fragments.map((fragment) => {
        const fact = facts.get(fragment.id);
        assert.ok(fact && fact.task === task && fact.fragment === fragment, "Unknown fragment");
        return fact;
      });
      const first = fragments.some((fragment) => fragment.id === task.fragments[0].id);
      const lines = [
        `Move the following complete entities from main.cpp into ${task.file}.`,
        "Preserve their existing code and original ordering relative to preprocessing directives and other destination entities. Preserve unrelated source and existing destination contents.",
        ...(first
          ? [
              preambleContractProse(contracts.get(task.id).preamble, { sorted: true }),
              ...(task.using ?? []).map(
                (entry) => `Copy this import into the destination: ${entry.text}`,
              ),
              task.replacement
                ? `Replace the first assigned source entity with ${task.replacement.trim()}.`
                : "Remove the first assigned source entity without replacement.",
            ]
          : ["Remove these assigned source entities without adding another replacement include."]),
        ...selected.flatMap(({ entities }) =>
          entities.map(
            ({ scope, kind, signature, members }) =>
              `${scope ? `In namespace ${scope}` : "In the global namespace"}, move the ${kind.replaceAll("-", " ")} ${signature}.${members?.length ? ` Its members include ${members.join(" ")}` : ""}`,
          ),
        ),
      ];
      let anchors = selected.flatMap(({ anchors }) => anchors);
      if (currentSource !== undefined) {
        assert.ok(completed instanceof Set);
        anchors = anchors.map((anchor) => {
          const fragment = facts.get(anchor.fragmentId).fragment;
          const [updated] = currentBatchAnchors(
            source,
            currentSource,
            task,
            {
              fragments: [
                { ...fragment, isolatedAnchor: { context: anchor.anchor, offset: anchor.offset } },
              ],
            },
            completed,
            projection,
          );
          return {
            ...anchor,
            anchor: updated.isolatedAnchor.context,
            offset: updated.isolatedAnchor.offset,
          };
        });
      }
      const macros = [
        ...selected.flatMap(({ macros }) => macros),
        ...(first ? copiedMacros.get(task.id) : []),
      ];
      const hints = [ambiguityAnchorsProse(anchors), macroAmbiguityAnchorsProse(macros)].filter(
        Boolean,
      );
      return { prompt: [...lines, ...hints].join("\n\n"), anchors, hints };
    },
    validate(currentSource, batch) {
      for (const anchor of batch.anchors) locateAnchoredFragment(currentSource, anchor);
      assertFlatHintContexts(currentSource, { fragments: [] }, batch.hints);
    },
  };
}
