import assert from "node:assert/strict";
import { treeIdentity } from "../generation/generator.mjs";
import { atomicOrder } from "../tasks/atomic-effects.mjs";
import { applyCoherentStructure } from "../reference/coherent-edit.mjs";
import { createAtomicInventory, isAtomicInventoryRecord } from "./atomic-inventory.mjs";
import {
  createAtomicNamingReplay,
  atomicFileTokens,
  atomicFileDirectives,
} from "./atomic-frontier.mjs";
import { evaluateAtomicBindingGate } from "./atomic-binding-gate.mjs";
import {
  prepareAtomicGate,
  projectAtomicGate,
  evaluateAtomicGate,
  checkAtomicInputs,
} from "./atomic-gate.mjs";

const naming = (node) => node.operations.every((operation) => operation.phase === "names");
const family = (record) =>
  JSON.stringify([
    record.kind,
    record.scope,
    record.kind === "conditional" ? record.directives : record.selector,
  ]);
const move = (tree, node) => node.operations.reduce(applyCoherentStructure, tree);

const descriptorIndexes = new WeakMap();
const descriptorKeys = new WeakMap();
const descriptorKey = (owner, tokens = owner.tokens) => {
  const reusable = tokens === owner.tokens && isAtomicInventoryRecord(owner);
  if (reusable && descriptorKeys.has(owner)) return descriptorKeys.get(owner);
  const key = JSON.stringify([owner.file, owner.kind, owner.scope, owner.conditions, tokens]);
  if (reusable) descriptorKeys.set(owner, key);
  return key;
};

function descriptorRecord(contract, owner, tokens = owner.tokens) {
  let index = descriptorIndexes.get(contract);
  if (!index) {
    index = new Map();
    for (const record of contract.obligations) {
      const key = descriptorKey(record);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(record);
    }
    descriptorIndexes.set(contract, index);
  }
  const matches = index.get(descriptorKey(owner, tokens)) ?? [];
  assert.equal(matches.length, 1, "Missing or ambiguous trusted binding owner record");
  return matches[0];
}

// Coherent identities aggregate equal owners. Distinct certified plans that
// converge need current ordered occurrences, not fabricated count-one records.
const projectionIndexes = new WeakMap();
function projectionIndex(combined) {
  let cached = projectionIndexes.get(combined);
  if (cached) return cached;
  const all = [...combined.owners.values()].flat();
  const families = new Map();
  const recordFor = new Map();
  for (const owner of all) {
    const record = descriptorRecord(combined.contract, owner);
    recordFor.set(owner, record);
    if (!families.has(record.id)) families.set(record.id, { record, owners: [] });
    families.get(record.id).owners.push(owner);
  }
  const shapes = new Map();
  const shapeKeys = new Map();
  for (const owner of all) {
    const slots = new Set(owner.sites.map((site) => site.index));
    const key = JSON.stringify([
      owner.file,
      owner.kind,
      owner.scope,
      owner.conditions,
      owner.macros,
      owner.tokens.map((token, index) => (slots.has(index) ? null : token)),
    ]);
    shapeKeys.set(owner, key);
    if (!shapes.has(key)) shapes.set(key, []);
    shapes.get(key).push(owner);
  }
  cached = { all, families, recordFor, shapes, shapeKeys };
  projectionIndexes.set(combined, cached);
  return cached;
}

function bindingProjection(combined, include, masksFor) {
  // Only topology belongs to the exact expected frontier. Current/peer masks
  // remain fresh when writer reservations or verified completion roles change.
  const { all, families, recordFor, shapes, shapeKeys } = projectionIndex(combined);
  const selected = new Set();
  const occurrenceOwners = new Set();
  for (const seed of all.filter(include)) {
    if (selected.has(seed)) continue;
    const component = new Set([seed]);
    const queue = [seed];
    for (const owner of queue) {
      const record = recordFor.get(owner);
      for (const neighbor of [
        ...families.get(record.id).owners,
        ...shapes.get(shapeKeys.get(owner)),
      ])
        if (!component.has(neighbor)) {
          component.add(neighbor);
          queue.push(neighbor);
        }
    }
    for (const owner of component) {
      selected.add(owner);
      if (component.size > 1) occurrenceOwners.add(owner);
    }
  }
  const records = [];
  for (const { record, owners } of families.values()) {
    if (!owners.some((owner) => selected.has(owner))) continue;
    if (!owners.some((owner) => occurrenceOwners.has(owner))) {
      records.push({ ...record, masks: masksFor(owners[0]) });
      continue;
    }
    const occurrences = owners.flatMap((owner) =>
      owner.tokenStarts.map((tokenStart) => ({ tokenStart, masks: masksFor(owner) })),
    );
    assert.equal(occurrences.length, record.count, "Incomplete convergent owner coverage");
    const masks = new Map();
    for (const occurrence of occurrences)
      for (const mask of occurrence.masks)
        if (!masks.has(mask.index)) masks.set(mask.index, { ...mask, role: "peer" });
    records.push({ ...record, masks: [...masks.values()], occurrences });
  }
  const files = new Set(
    records.filter((record) => record.occurrences).map((record) => record.file),
  );
  const occurrenceFiles = [...files].map((file) => ({
    file,
    tokens: atomicFileTokens(combined.tree[file]),
    directives: atomicFileDirectives(combined.tree[file]),
    slots: [
      ...new Set(
        all
          .filter((owner) => owner.file === file)
          .flatMap((owner) =>
            owner.tokenStarts.flatMap((start) => owner.sites.map((site) => start + site.index)),
          ),
      ),
    ].sort((left, right) => left - right),
  }));
  return { records, occurrenceFiles };
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
  const structuralNodes = ordered.filter((item) => !naming(item));
  let canonical = initialTree;
  for (const node of structuralNodes) {
    const after = move(canonical, node);
    templates.set(
      node.id,
      prepareAtomicGate(canonical, after, { writesOnly: true, readInventory: readTrusted }),
    );
    canonical = after;
  }

  function replayExpected(selection, reservations = new Set()) {
    const selected = new Set(selection);
    for (const id of selected) assert.ok(byId.has(id), `Unknown atomic checkpoint node: ${id}`);
    // Template construction already proved this exact full structural endpoint.
    // Reuse it only when every structural atom is selected; partial frontiers
    // still replay their own moves in dependency order before applying names.
    const completeStructure = structuralNodes.every((node) => selected.has(node.id));
    let tree = completeStructure ? canonical : initialTree;
    const structural = new Map();
    for (const node of ordered) {
      if (naming(node) || !selected.has(node.id)) continue;
      if (!completeStructure) tree = move(tree, node);
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
    // Reservations only decide which complete naming batches are present; the
    // identity of the atom that reserved a batch does not change expected bytes.
    const groups = batches
      .filter((entry) => entry.batch.ids.some((id) => reservations.has(id)))
      .map((entry) => entry.taskId);
    const key = JSON.stringify([[...selection].sort(), groups]);
    if (cached?.key !== key) {
      const result = replayExpected(selection, reservations);
      cached = { key, ...result, contract: readTrusted(result.tree) };
    }
    return cached;
  }
  /** Return a detached trusted frontier, never the reusable private metadata. */
  function expected(selection, reservations = new Set()) {
    const { tree, owners, structural } = frontier(selection, reservations);
    return structuredClone({ tree, owners, structural });
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
    // Naming input masks admit old/new/partial identifiers. Share the unchanged
    // current frontier across ready atoms instead of applying each unstarted
    // atom merely to mask its new spelling again. Output checks still apply it.
    const namingInput = input && naming(node);
    const selected = new Set([...completed, ...settled, ...(namingInput ? [] : [id])]);
    const reservations = new Set([...started, ...writers, ...(namingInput ? [id] : [])]);
    const activeWrites = writers.size > 0;
    const combined = frontier(selected, reservations);
    if (naming(node)) {
      const contract = combined.contract;
      const projection = bindingProjection(
        combined,
        (owner) => owner.sites.some((site) => site.nodeId === id),
        (owner) =>
          owner.sites
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
      );
      return evaluateAtomicBindingGate(
        tree,
        { ...projection, familyRecords: contract.obligations },
        { input, activeWrites, readInventory: readCandidate },
      );
    }
    if (!input) {
      const gate = projectAtomicGate(combined.tree, combined.structural.get(id), {
        readInventory: readTrusted,
      });
      const expectedIds = new Set(gate.add.map((record) => record.id));
      const contract = combined.contract;
      const masksFor = (owner) =>
        owner.sites
          .filter(
            (site) =>
              !completed.has(site.nodeId) &&
              (started.has(site.nodeId) || settled.has(site.nodeId) || writers.has(site.nodeId)),
          )
          .map((site) => ({ index: site.index, from: site.from, to: site.to, role: "peer" }));
      const projection = bindingProjection(
        combined,
        (owner) =>
          expectedIds.has(descriptorRecord(contract, owner).id) && masksFor(owner).length > 0,
        masksFor,
      );
      return evaluateAtomicGate(tree, gate, {
        activeWrites,
        bindingRecords: projection.records,
        occurrenceFiles: projection.occurrenceFiles,
        familyRecords: contract.obligations,
        readInventory: readCandidate,
      });
    }
    // Inputs are checked before the current move. A settled descendant is not a
    // fresh dispatch and must instead use combined-frontier output revalidation.
    selected.delete(id);
    const before = frontier(selected).tree;
    const after = move(before, node);
    return checkAtomicInputs(
      tree,
      prepareAtomicGate(before, after, { writesOnly: true, readInventory: readTrusted }),
      {
        activeWrites,
        readInventory: readCandidate,
      },
    );
  }
  /** Observe twice around grading; peer writes or frontier advancement defer the
   * result without spending a correction. Access live context getters after each
   * await. A stable snapshot is evidence at that instant, not a filesystem lock.
   */
  async function observeOnce(readSource, id, context, { input = false, signal } = {}) {
    const snapshot = () => ({
      verified: JSON.stringify([[...context.completed].sort(), [...context.settled].sort()]),
      started: new Set(context.started ?? []),
      writers: new Set(context.writers ?? []),
    });
    signal?.throwIfAborted();
    const revision = snapshot();
    const invalidated = () => {
      const current = snapshot();
      return (
        revision.verified !== current.verified ||
        [...revision.started].some((id) => !current.started.has(id)) ||
        [...revision.writers].some((id) => !current.writers.has(id))
      );
    };
    try {
      const before = await readSource();
      signal?.throwIfAborted();
      if (invalidated()) return { status: "pending", reason: "frontier-changed" };
      const result = check(before, id, { ...context, input });
      const after = await readSource();
      signal?.throwIfAborted();
      if (invalidated() || treeIdentity(before) !== treeIdentity(after))
        return { status: "pending", reason: "source-or-frontier-changed" };
      // New reservations only relax peer slots. An unchanged-source pass stays
      // valid when another writer starts; verified-frontier changes and narrowed
      // reservations still invalidate it. Non-passes must defer to active writers.
      if (result.status !== "pass" && context.writers.size)
        return { ...result, status: "pending", reason: result.reason ?? "active-writers" };
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

  // Grading is synchronous CPU work. Finish one stable read/check/read span
  // before another observation can fill the event loop and stale its final read.
  // This FIFO lane never locks editors or retains decisions. Read live context
  // only after acquiring the lane; failures must not poison following spans.
  let observationQueue = Promise.resolve();
  function observe(readSource, id, context, options = {}) {
    const result = observationQueue.then(() => observeOnce(readSource, id, context, options));
    observationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
  const complete = frontier(new Set(byId.keys()));
  const finalContract = readTrusted(complete.tree);
  for (const owners of complete.owners.values())
    for (const owner of owners) {
      try {
        descriptorRecord(finalContract, owner);
      } catch (error) {
        throw Error("Distinct naming groups share an owner within one barrier", { cause: error });
      }
    }
  /** Drop reusable inventories/selection frontiers, not fixed trusted baselines
   * or caller-owned completion state.
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
