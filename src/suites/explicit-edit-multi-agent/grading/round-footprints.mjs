import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareCoherentContract } from "./coherent-grade.mjs";
import { cppStructure, emptyNamespaceSpans } from "../cpp/cpp-structure.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fullId = ({ id: _id, count: _count, ...record }) => digest(record);
const core = (record) => ({
  file: record.file,
  kind: record.kind,
  scope: record.scope ?? "",
  ...(record.selector === undefined ? {} : { selector: record.selector }),
  tokens: record.tokens,
});
const coreKey = (record) => digest(core(record));
const transportKey = (record) => {
  const { file: _file, selector: _selector, ...body } = core(record);
  if (record.kind === "owner") {
    const opening = body.tokens.indexOf("{");
    body.tokens = body.tokens.filter(
      (token, index) => token !== "inline" || (opening >= 0 && index >= opening),
    );
  }
  return digest(body);
};
const union = (entries, field) => new Set(entries.flatMap((entry) => [...entry[field]]));
const addTo = (map, key, value) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
};

function validate(record) {
  assert.ok(Number.isSafeInteger(record.count) && record.count > 0, "Invalid trusted record count");
  assert.equal(record.id, fullId(record), "Invalid trusted record identity");
}
function counts(entries) {
  const result = new Map();
  for (const { record } of entries) {
    const key = coreKey(record);
    result.set(key, (result.get(key) ?? 0) + record.count);
  }
  return result;
}
function inventory(tree) {
  return prepareCoherentContract(tree).obligations;
}
function ordered(records) {
  return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

/** Count only empty/using-only namespace shells, not legitimate reopened scopes. */
export function namespaceShellCounts(tree) {
  const result = new Map();
  for (const [file, source] of Object.entries(tree))
    for (const { scope } of emptyNamespaceSpans(cppStructure(source))) {
      const key = JSON.stringify([file, scope]);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
  return result;
}
/** Project trusted structural effects through the complete round endpoint.
 * Physical writes and surrounding context changes have separate provenance.
 * These private requirements are not an editing journal or an atom-time gate;
 * only the drained candidate is compared with the final endpoint by the grader.
 * No candidate source enters preparation and no per-atom snapshots are retained.
 */
export function prepareAtomicRoundFootprints(beforeTree, effects, expectedTree) {
  assert.ok(Array.isArray(effects) && effects.length > 0, "Missing structural round effects");
  const ids = effects.map(({ id }) => id);
  assert.ok(
    ids.every((id) => typeof id === "string" && id.length > 0),
    "Missing structural atom identity",
  );
  assert.equal(new Set(ids).size, ids.length, "Repeated structural atom identity");
  const state = new Map(
    inventory(beforeTree).map((record) => [
      record.id,
      {
        record,
        physical: new Set(),
        context: new Set(),
      },
    ]),
  );
  let files = Object.keys(beforeTree).sort();
  const fileOwners = new Map(),
    removedGoals = new Map(),
    cleanupOwners = new Map();
  for (const { id, effect, filesBefore, filesAfter, cleanupScopes = [] } of effects) {
    assert.deepEqual(filesBefore, files, "Stale structural file frontier");
    assert.ok(
      Array.isArray(filesAfter) && filesAfter.every((file) => typeof file === "string"),
      "Missing structural destination files",
    );
    assert.deepEqual(
      filesAfter,
      [...new Set(filesAfter)].sort(),
      "Invalid structural destination file set",
    );
    assert.ok(
      Array.isArray(effect?.remove) && Array.isArray(effect.add),
      "Missing structural record effects",
    );
    assert.ok(Array.isArray(cleanupScopes), "Invalid namespace cleanup requirements");
    for (const { file, scope } of cleanupScopes) {
      assert.ok(
        filesBefore.includes(file) &&
          typeof scope === "string" &&
          /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(scope),
        "Invalid namespace cleanup scope",
      );
      addTo(cleanupOwners, JSON.stringify([file, scope]), id);
    }
    const previousCounts = counts(state.values());
    const removed = [];
    for (const record of effect.remove) {
      validate(record);
      const entry = state.get(record.id);
      assert.deepEqual(entry?.record, record, "Stale structural record removal");
      removed.push(entry);
      state.delete(record.id);
    }
    assert.equal(
      new Set(effect.add.map((record) => record.id)).size,
      effect.add.length,
      "Repeated structural record addition",
    );
    for (const record of effect.add) {
      validate(record);
      assert.ok(!state.has(record.id), "Structural addition overwrites an unremoved record");
    }
    // Compute final multiplicities for this transition before classifying a
    // same-body replacement as context-only or a real duplicate-count write.
    const nextCounts = counts([...state.values(), ...effect.add.map((record) => ({ record }))]);
    const physicalParents = new Map(),
      transportedParents = new Map();
    for (const entry of removed) {
      for (const [index, key] of [
        [physicalParents, coreKey(entry.record)],
        [transportedParents, transportKey(entry.record)],
      ]) {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(entry);
      }
    }
    for (const record of effect.add) {
      const key = coreKey(record);
      const samePhysical = physicalParents.get(key) ?? [];
      const transported = samePhysical.length
        ? samePhysical
        : (transportedParents.get(transportKey(record)) ?? []);
      const physical = union(transported, "physical");
      const context = union(transported, "context");
      const contextOnly =
        samePhysical.length > 0 && previousCounts.get(key) === nextCounts.get(key);
      (contextOnly ? context : physical).add(id);
      state.set(record.id, { record, physical, context });
    }
    for (const entry of removed) {
      const key = coreKey(entry.record);
      if (previousCounts.get(key) === nextCounts.get(key)) continue;
      if (!removedGoals.has(key))
        removedGoals.set(key, {
          record: core(entry.record),
          physical: new Set(),
          context: new Set(),
        });
      const goal = removedGoals.get(key);
      for (const owner of entry.physical) goal.physical.add(owner);
      for (const owner of entry.context) goal.context.add(owner);
      goal.physical.add(id);
    }
    for (const file of new Set([...filesBefore, ...filesAfter])) {
      if (filesBefore.includes(file) !== filesAfter.includes(file)) addTo(fileOwners, file, id);
    }
    files = filesAfter;
  }
  const expected = inventory(expectedTree);
  assert.deepEqual(files, Object.keys(expectedTree).sort(), "Structural endpoint files differ");
  assert.deepEqual(
    ordered([...state.values()].map(({ record }) => record)),
    ordered(expected),
    "Structural endpoint records differ",
  );
  const finalCounts = counts(state.values());
  const finalShells = cleanupOwners.size ? namespaceShellCounts(expectedTree) : new Map();
  const atoms = ids.map((id) => ({
    id,
    records: [...state.values()]
      .filter((entry) => entry.physical.has(id) || entry.context.has(id))
      .map((entry) => ({
        record: entry.record,
        role: entry.physical.has(id) ? "physical" : "context",
      })),
    counts: [...removedGoals]
      .filter(([, entry]) => entry.physical.has(id) || entry.context.has(id))
      .map(([key, entry]) => ({
        record: entry.record,
        count: finalCounts.get(key) ?? 0,
        role: entry.physical.has(id) ? "physical" : "context",
      })),
    files: [...fileOwners]
      .filter(([, owners]) => owners.has(id))
      .map(([file]) => ({ file, present: files.includes(file) }))
      .sort((left, right) => left.file.localeCompare(right.file)),
    namespaces: [...cleanupOwners]
      .filter(([, owners]) => owners.has(id))
      .map(([key]) => {
        const [file, scope] = JSON.parse(key);
        return { file, scope, count: finalShells.get(key) ?? 0 };
      }),
  }));
  return { version: "renderer-round-footprints-v1", atoms };
}
