import assert from "node:assert/strict";
import { treeIdentity } from "../generation/generator.mjs";
import { atomicOrder } from "../tasks/atomic-effects.mjs";
import { applyCoherentStructure } from "../reference/coherent-edit.mjs";
import { createAtomicInventory } from "./atomic-inventory.mjs";
import { createAtomicNamingReplay } from "./atomic-frontier.mjs";
import { evaluateAtomicBindingGate } from "./atomic-binding-gate.mjs";
import {
  prepareAtomicGate,
  projectAtomicGate,
  evaluateAtomicGate,
  checkAtomicInputs,
} from "./atomic-gate.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const naming = (node) => node.operations.every((operation) => operation.phase === "names");
const family = (record) =>
  JSON.stringify([
    record.kind,
    record.scope,
    record.kind === "conditional" ? record.directives : record.selector,
  ]);
const move = (tree, node) => node.operations.reduce(applyCoherentStructure, tree);

function descriptorRecord(contract, owner, tokens = owner.tokens) {
  const matches = contract.obligations.filter(
    (record) =>
      record.file === owner.file &&
      record.kind === owner.kind &&
      record.scope === owner.scope &&
      same(record.conditions, owner.conditions) &&
      same(record.tokens, tokens),
  );
  assert.equal(matches.length, 1, "Missing or ambiguous trusted binding owner record");
  return matches[0];
}

/** Build private expected frontiers for one drained-barrier interval.
 * Batches are compiler-certified group-start sparse plans; nodes are public atomic
 * requests. Never derive either from candidate edits or mount this object in an
 * editing worker. Settled peers choose provisional context, while only completed
 * nodes may unlock dependencies. The caller owns stable source observation and
 * must recheck inputs immediately before dispatch. This API grants no task credit;
 * the full cumulative contract/build/pixel barrier remains authoritative.
 */
export function createAtomicCheckpoint(initialTree, nodes, batches) {
  const readTrusted = createAtomicInventory();
  const readCandidate = createAtomicInventory();
  const ordered = atomicOrder(nodes);
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const byBinding = new Map();
  const taskIds = new Set();
  for (const entry of batches) {
    assert.ok(!taskIds.has(entry.taskId), "Repeated checkpoint naming group");
    taskIds.add(entry.taskId);
  }
  for (const entry of batches)
    for (const id of entry.batch.ids) {
      assert.ok(byId.has(id) && naming(byId.get(id)), "Unknown naming binding in checkpoint");
      assert.equal(byId.get(id).taskId, entry.taskId, "Binding belongs to another scoring group");
      assert.ok(!byBinding.has(id), "Repeated checkpoint binding");
      byBinding.set(id, entry);
    }
  for (const node of ordered)
    if (naming(node)) assert.ok(byBinding.has(node.id), "Missing compiler binding batch");

  const replays = new Map(
    batches.map((entry) => [entry.taskId, createAtomicNamingReplay(entry.batch)]),
  );
  const templates = new Map();
  let canonical = initialTree;
  for (const node of ordered.filter((item) => !naming(item))) {
    const after = move(canonical, node);
    templates.set(node.id, prepareAtomicGate(canonical, after, { writesOnly: true }));
    canonical = after;
  }

  function expected(selection, reservations = new Set()) {
    const selected = new Set(selection);
    for (const id of selected) assert.ok(byId.has(id), `Unknown atomic checkpoint node: ${id}`);
    let tree = initialTree;
    const structural = new Map();
    for (const node of ordered) {
      if (naming(node) || !selected.has(node.id)) continue;
      tree = move(tree, node);
      structural.set(node.id, {
        ...templates.get(node.id),
        resources: [...templates.get(node.id).resources],
      });
    }
    const owners = new Map();
    for (const entry of batches) {
      const chosen = entry.batch.ids.filter((id) => selected.has(id));
      if (!chosen.length && !entry.batch.ids.some((id) => reservations.has(id))) continue;
      const before = structural.size ? readTrusted(tree) : null;
      const result = replays.get(entry.taskId)(tree, chosen);
      tree = result.tree;
      // Carry structural family identities through later certified renames. Do
      // not invert an old move after its renamed descendants have completed.
      const after = before ? readTrusted(tree) : null;
      for (const owner of before ? result.owners : []) {
        const oldTokens = [...owner.tokens];
        for (const site of owner.sites)
          if (selected.has(site.nodeId)) oldTokens[site.index] = site.from;
        const previous = descriptorRecord(before, owner, oldTokens);
        const next = family(descriptorRecord(after, owner));
        for (const template of structural.values())
          if (template.resources.includes(family(previous)))
            template.resources = [...new Set([...template.resources, next])];
      }
      owners.set(entry.taskId, result.owners);
    }
    return { tree, owners, structural };
  }

  // Bound replay reuse to one trusted frontier. Lexical readers retain one exact
  // source inventory each, never decisions: changed bytes must expose regressions.
  let cached;
  function frontier(selection, reservations = new Set()) {
    const key = JSON.stringify([[...selection].sort(), [...reservations].sort()]);
    if (cached?.key !== key) {
      const result = expected(selection, reservations);
      cached = { key, ...result, contract: readTrusted(result.tree) };
    }
    return cached;
  }
  function check(
    tree,
    id,
    {
      completed = new Set(),
      started = new Set(),
      settled = new Set(),
      writers = new Set(),
      input = false,
    } = {},
  ) {
    const node = byId.get(id);
    assert.ok(node, `Unknown atomic checkpoint node: ${id}`);
    const selected = new Set([...completed, ...settled, id]);
    const activeWrites = writers.size > 0;
    const combined = frontier(selected, new Set([...started, ...writers]));
    if (naming(node)) {
      const contract = combined.contract;
      const records = combined.owners
        .get(node.taskId)
        .filter((owner) => owner.sites.some((site) => site.nodeId === id))
        .map((owner) => ({
          ...descriptorRecord(contract, owner),
          masks: owner.sites
            .filter(
              (site) =>
                site.nodeId === id ||
                (!completed.has(site.nodeId) &&
                  (started.has(site.nodeId) ||
                    settled.has(site.nodeId) ||
                    writers.has(site.nodeId))),
            )
            .map((site) => ({
              index: site.index,
              from: site.from,
              to: site.to,
              role: site.nodeId === id ? "current" : "peer",
            })),
        }));
      return evaluateAtomicBindingGate(
        tree,
        { records, familyRecords: contract.obligations },
        { input, activeWrites, readInventory: readCandidate },
      );
    }
    if (!input) {
      const gate = projectAtomicGate(combined.tree, combined.structural.get(id), {
        readInventory: readTrusted,
      });
      const expectedIds = new Set(gate.add.map((record) => record.id));
      const contract = combined.contract;
      const bindingRecords = [...combined.owners.values()].flatMap((owners) =>
        owners.flatMap((owner) => {
          const record = descriptorRecord(contract, owner);
          if (!expectedIds.has(record.id)) return [];
          const masks = owner.sites
            .filter(
              (site) =>
                !completed.has(site.nodeId) &&
                (started.has(site.nodeId) || settled.has(site.nodeId) || writers.has(site.nodeId)),
            )
            .map((site) => ({ index: site.index, from: site.from, to: site.to, role: "peer" }));
          return masks.length ? [{ ...record, masks }] : [];
        }),
      );
      return evaluateAtomicGate(tree, gate, {
        activeWrites,
        bindingRecords,
        familyRecords: contract.obligations,
        readInventory: readCandidate,
      });
    }
    // Inputs are checked before the current move. A settled descendant is not a
    // fresh dispatch and must instead use combined-frontier output revalidation.
    selected.delete(id);
    const before = frontier(selected).tree;
    const after = move(before, node);
    return checkAtomicInputs(tree, prepareAtomicGate(before, after, { writesOnly: true }), {
      activeWrites,
      readInventory: readCandidate,
    });
  }
  /** Observe twice around grading; peer writes or frontier advancement defer the
   * result without spending a correction. Access live context getters after each
   * await. A stable snapshot is evidence at that instant, not a filesystem lock.
   */
  async function observe(readSource, id, context, { input = false, signal } = {}) {
    const stamp = () =>
      JSON.stringify([
        [...context.completed].sort(),
        [...(context.started ?? [])].sort(),
        [...context.settled].sort(),
        [...context.writers].sort(),
      ]);
    signal?.throwIfAborted();
    const revision = stamp();
    try {
      const before = await readSource();
      signal?.throwIfAborted();
      if (revision !== stamp()) return { status: "pending", reason: "frontier-changed" };
      const result = check(before, id, { ...context, input });
      const after = await readSource();
      signal?.throwIfAborted();
      if (revision !== stamp() || treeIdentity(before) !== treeIdentity(after))
        return { status: "pending", reason: "source-or-frontier-changed" };
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      // readSharedSource can observe a move mid-read or invalid candidate bytes.
      // Permission/storage failures remain infrastructure errors, never edit faults.
      if (
        error.code === "ENOENT" ||
        /^(?:Nonregular candidate entry|Invalid source UTF-8|Nonempty reference control directory):/.test(
          error.message,
        )
      )
        return {
          status: context.writers.size ? "pending" : "unobservable",
          reason: "source",
          message: error.message,
        };
      throw error;
    }
  }
  /** Revalidate retained work on a drained stable source before a correction.
   * Observable binding regressions are removed first so their partial slots do
   * not falsely revoke independent peers. Descendants lose readiness, not edits.
   * Unobservable results never grant credit or invent individual fault attribution.
   */
  function revalidate(
    tree,
    { completed, started = new Set(completed), settled = new Set(started) },
  ) {
    const retained = new Set(completed);
    const invalidated = [];
    while (retained.size) {
      const observations = [...retained].map((id) => ({
        id,
        ...check(tree, id, {
          completed: retained,
          started,
          settled,
          writers: new Set(),
        }),
      }));
      const namingFailures = observations.filter(
        (entry) => entry.status === "fail" && naming(byId.get(entry.id)),
      );
      const failures = namingFailures.length
        ? namingFailures
        : observations.filter((entry) => entry.status === "fail");
      const rejected = failures.length
        ? failures
        : observations.filter((entry) => entry.status !== "pass");
      if (!rejected.length) break;
      for (const entry of rejected) {
        retained.delete(entry.id);
        invalidated.push({ id: entry.id, status: entry.status, reason: entry.reason ?? "output" });
      }
      for (const node of ordered)
        if (
          retained.has(node.id) &&
          node.dependencies.some((dependency) => !retained.has(dependency))
        ) {
          retained.delete(node.id);
          invalidated.push({ id: node.id, status: "unverified", reason: "prerequisite" });
        }
    }
    return { completed: retained, invalidated };
  }
  // Coarse scheduling must separate naming groups that touch the same physical
  // owner. Prove this before dispatch instead of failing a retained earlier group
  // only after a later group's baseline has overwritten its descriptor.
  const complete = expected(new Set(byId.keys()));
  const finalContract = readTrusted(complete.tree);
  for (const owners of complete.owners.values())
    for (const owner of owners) {
      try {
        descriptorRecord(finalContract, owner);
      } catch (error) {
        throw Error("Distinct naming groups share an owner within one barrier", { cause: error });
      }
    }
  /** Drop reusable inventories/frontiers, not caller-owned completion state.
   * Eager endpoint validation must clear these before retaining future intervals.
   * Active corrections may rebuild them without changing their gate requirements.
   */
  function clearCaches() {
    cached = undefined;
    readTrusted.clear();
    readCandidate.clear();
    for (const replay of replays.values()) replay.clear();
  }
  return { expected, check, observe, revalidate, clearCaches };
}
