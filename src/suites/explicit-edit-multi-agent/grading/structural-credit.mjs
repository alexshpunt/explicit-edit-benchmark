import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const physicalRecordKey = (record) =>
  createHash("sha256")
    .update(JSON.stringify([record.file, record.kind, record.scope ?? "", record.tokens]))
    .digest("hex");
const append = (map, key, id) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(id);
};
const key = (record) =>
  JSON.stringify([record.file, record.kind, record.scope ?? "", record.conditions, record.tokens]);
const header = (tokens) => {
  const end = tokens.findIndex((token) => token === "{" || token === "=" || token === ";");
  return tokens.slice(0, end < 0 ? tokens.length : end);
};
const mask = (tokens, slots) =>
  tokens.map((token, index) => (slots.has(index) && /^[A-Za-z_]\w*$/.test(token) ? null : token));

const macroHead = (tokens) => {
  const index = tokens.indexOf("define");
  return index > 0 && tokens[index - 1] === "#" ? tokens.slice(index - 1, index + 2) : undefined;
};
/** Attach trusted structural provenance without broadening a context-only write
 * into permission to damage an unchanged body. Names are projected using only
 * the sealed private batch, never observations from the editing candidate.
 */
export function prepareStructuralCredit({
  beforeTree,
  frames,
  contract,
  nodes,
  namingBatches,
  footprints,
  expectedSymbols,
}) {
  const structuralIds = nodes
    .filter((node) => node.operations[0].phase === "structure")
    .map(({ id }) => id);
  if (structuralIds.length) {
    assert.equal(
      footprints?.version,
      "renderer-round-footprints-v1",
      "Missing structural endpoint footprints",
    );
    assert.deepEqual(
      footprints.atoms.map(({ id }) => id).sort(),
      [...structuralIds].sort(),
      "Structural endpoint coverage differs",
    );
  } else
    assert.ok(
      !footprints || footprints.atoms.length === 0,
      "Unexpected structural endpoint footprints",
    );
  const plans = namingBatches.flatMap((batch) => batch.owners);
  const transformed = (record) => {
    let tokens = record.tokens;
    let copied = false;
    for (const owner of plans) {
      if (
        owner.scope !== (record.scope ?? "") ||
        owner.kind !== record.kind ||
        !same(owner.tokens, tokens)
      )
        continue;
      if (!copied) {
        tokens = Array.from(tokens);
        copied = true;
      }
      for (const site of owner.sites) tokens[site.index] = site.to;
    }
    return { ...record, tokens };
  };
  const canonical = new Map(contract.obligations.map((record) => [key(record), record]));
  const canonicalCore = new Map(
    contract.obligations.map((record) => [physicalRecordKey(record), record]),
  );
  const byFrame = new Map();
  for (const frame of frames) {
    const entry = key(frame);
    if (!byFrame.has(entry)) byFrame.set(entry, []);
    byFrame.get(entry).push(frame);
  }
  const recordOwners = new Map(),
    physicalOwners = new Map(),
    setupOwners = new Map();
  const roles = (record) => {
    if (!recordOwners.has(record.id))
      recordOwners.set(record.id, { physical: new Set(), context: new Set(), required: new Set() });
    return recordOwners.get(record.id);
  };
  const hints = [],
    countGoals = [],
    fileGoals = [],
    namespaceGoals = [];
  const own = (record, id, role) => {
    roles(record)[role].add(id);
    if (role === "physical") {
      append(physicalOwners, physicalRecordKey(record), id);
      hints.push({ ...record, ids: new Set([id]), slots: new Map() });
    }
    for (const frame of byFrame.get(key(record)) ?? []) {
      if (role === "physical") {
        frame.ids.add(id);
        frame.structuralIds.add(id);
      } else frame.contextIds.add(id);
    }
  };
  for (const atom of footprints?.atoms ?? []) {
    for (const { record, role } of atom.records) {
      const target = canonical.get(key(transformed(record)));
      assert.ok(target, "Missing projected structural endpoint record");
      own(target, atom.id, role);
    }
    for (const goal of atom.counts) {
      const projected = transformed(goal.record);
      const target = canonicalCore.get(physicalRecordKey(projected)) ?? projected;
      countGoals.push({ ...goal, record: target, id: atom.id });
      if (goal.role === "physical") {
        append(physicalOwners, physicalRecordKey(goal.record), atom.id);
        hints.push({ ...goal.record, ids: new Set([atom.id]), slots: new Map() });
      }
    }
    for (const goal of atom.namespaces ?? []) namespaceGoals.push({ ...goal, id: atom.id });
    for (const goal of atom.files) {
      fileGoals.push({ ...goal, id: atom.id });
      if (goal.present && !Object.hasOwn(beforeTree, goal.file))
        append(setupOwners, goal.file, atom.id);
    }
  }
  // Input-side hints are attribution only. They can recognize a damaged owner
  // still left in its old file, but cannot certify a correct destination.
  for (const hint of hints) {
    for (const owner of plans)
      if (
        owner.scope === hint.scope &&
        owner.kind === hint.kind &&
        same(owner.tokens, hint.tokens)
      ) {
        for (const site of owner.sites) hint.slots.set(site.index, site);
      }
  }
  const imports = contract.obligations.filter(
    (record) => record.kind === "using" && /^usingstd::[A-Za-z_]\w*;$/.test(record.tokens.join("")),
  );
  const dependencies = new Map();
  for (const record of imports) {
    const name = record.tokens.at(-2);
    const contexts = expectedSymbols.credit.translationUnits.filter((unit) =>
      unit.files.includes(record.file),
    );
    for (const frame of frames) {
      if (!frame.ids.size || frame.kind === "using") continue;
      if (
        !(
          record.scope === frame.scope ||
          !record.scope ||
          frame.scope.startsWith(record.scope + "::")
        )
      )
        continue;
      if (frame.file !== record.file && !contexts.some((unit) => unit.files.includes(frame.file)))
        continue;
      if (
        !frame.tokens.some(
          (token, index) => token === name && !["::", ".", "->"].includes(frame.tokens[index - 1]),
        )
      )
        continue;
      if (!dependencies.has(record.id)) dependencies.set(record.id, new Set());
      dependencies.get(record.id).add(frame);
      for (const id of frame.ids) {
        roles(record).required.add(id);
        for (const declaration of byFrame.get(key(record)) ?? []) declaration.requiredIds.add(id);
      }
    }
  }
  return {
    recordOwners,
    physicalOwners,
    setupOwners,
    hints,
    countGoals,
    fileGoals,
    namespaceGoals,
    imports,
    dependencies,
  };
}

/** Attribute unexpected source to an actual selected physical footprint. A
 * context-only guard does not own arbitrary extra or changed declaration bodies.
 */
export function structuralRecordOwners(record, plan) {
  const owners = new Set(plan.physicalOwners.get(physicalRecordKey(record)) ?? []);
  for (const hint of plan.hints) {
    if (
      hint.file !== record.file ||
      hint.kind !== record.kind ||
      (hint.scope ?? "") !== (record.scope ?? "")
    )
      continue;
    if (
      ["owner", "using", "conditional"].includes(record.kind) &&
      same(header(mask(record.tokens, hint.slots)), header(mask(hint.tokens, hint.slots)))
    ) {
      for (const id of hint.ids) owners.add(id);
    } else if (
      record.kind === "directive" &&
      macroHead(record.tokens) &&
      same(macroHead(record.tokens), macroHead(hint.tokens))
    ) {
      for (const id of hint.ids) owners.add(id);
    }
  }
  if (!["owner", "conditional"].includes(record.kind))
    for (const id of plan.setupOwners.get(record.file) ?? []) owners.add(id);
  return owners;
}
