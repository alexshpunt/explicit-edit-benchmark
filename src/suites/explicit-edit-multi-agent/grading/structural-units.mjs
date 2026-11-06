import { createHash } from "node:crypto";
import { diffArrays } from "diff";
import { STRUCTURAL_UNIT_VERSION, canonicalProjectUnits } from "./canonical-snapshot.mjs";

export const STRUCTURAL_UNIT_POLICY = Object.freeze({
  version: "renderer-structural-unit-diff-v1",
  units: STRUCTURAL_UNIT_VERSION,
  expected: "unit-multiset-change-from-trusted-start-to-trusted-endpoint",
  disagreement: "multiset-symmetric-difference-of-expected-and-actual-change",
  orderedUnits: "per-scope-sequence-diff",
  weight: 1,
});

const hash = (value) => createHash("sha256").update(value).digest("hex");
const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const emptyScope = Object.freeze({ ordered: [], unordered: new Map() });
const actions = Object.freeze({
  "missing-addition": "add",
  "unexpected-removal": "add",
  "missing-removal": "remove",
  "unexpected-addition": "remove",
});

/** Index units by content identity. Ordered units keep their sequence within a scope;
 * sortable definitions are a multiset because their placement is not scored.
 */
export async function structuralUnitInventory(tree) {
  const project = await canonicalProjectUnits(tree);
  const catalog = new Map(),
    scopes = new Map();
  for (const unit of project.units) {
    const id = hash(JSON.stringify([unit.file, unit.scope, unit.kind, unit.ordered, unit.text]));
    if (!catalog.has(id))
      catalog.set(
        id,
        Object.freeze({
          file: unit.file,
          scope: Object.freeze([...unit.scope]),
          kind: unit.kind,
          ordered: unit.ordered,
          text: unit.text,
        }),
      );
    const scopeId = JSON.stringify([unit.file, unit.scope]);
    let entry = scopes.get(scopeId);
    if (!entry) scopes.set(scopeId, (entry = { ordered: [], unordered: new Map() }));
    if (unit.ordered) entry.ordered.push(id);
    else entry.unordered.set(id, (entry.unordered.get(id) ?? 0) + 1);
  }
  const identity = hash(
    JSON.stringify(
      [...scopes]
        .sort(([left], [right]) => order(left, right))
        .map(([scope, entry]) => [
          scope,
          entry.ordered,
          [...entry.unordered].sort(([left], [right]) => order(left, right)),
        ]),
    ),
  );
  return {
    version: project.version,
    canonicalizer: project.canonicalizer,
    identity,
    catalog,
    scopes,
  };
}

function bump(map, id, count) {
  map.set(id, (map.get(id) ?? 0) + count);
}

/** Units that disappear and appear between two inventories, with multiplicity. */
function unitChange(before, after) {
  const removed = new Map(),
    added = new Map();
  for (const key of new Set([...before.scopes.keys(), ...after.scopes.keys()])) {
    const left = before.scopes.get(key) ?? emptyScope,
      right = after.scopes.get(key) ?? emptyScope;
    for (const id of new Set([...left.unordered.keys(), ...right.unordered.keys()])) {
      const delta = (right.unordered.get(id) ?? 0) - (left.unordered.get(id) ?? 0);
      if (delta > 0) bump(added, id, delta);
      else if (delta < 0) bump(removed, id, -delta);
    }
    if (
      left.ordered.length === right.ordered.length &&
      left.ordered.every((id, index) => id === right.ordered[index])
    )
      continue;
    for (const part of diffArrays(left.ordered, right.ordered)) {
      if (!part.added && !part.removed) continue;
      for (const id of part.value) bump(part.added ? added : removed, id, 1);
    }
  }
  return { removed, added };
}

function total(change) {
  let count = 0;
  for (const map of [change.removed, change.added])
    for (const value of map.values()) count += value;
  return count;
}

/** Trusted preparation: the expected change is fixed before any candidate exists. */
export async function prepareStructuralUnits(startTree, referenceTree) {
  const start = await structuralUnitInventory(startTree);
  const reference = await structuralUnitInventory(referenceTree);
  const expected = unitChange(start, reference);
  const totalUnits = total(expected);
  if (!totalUnits)
    throw Object.assign(new Error("The round has no observable reference unit changes"), {
      code: "STRUCTURAL_UNITS_EMPTY_REFERENCE",
    });
  return Object.freeze({
    version: STRUCTURAL_UNIT_POLICY.version,
    policy: STRUCTURAL_UNIT_POLICY,
    totalUnits,
    startIdentity: start.identity,
    referenceIdentity: reference.identity,
    start,
    reference,
    expected,
  });
}

/** Score-relevant comparison of one candidate inventory. Any candidate content is accepted. */
export function compareStructuralInventory(prepared, candidate) {
  const actual = unitChange(prepared.start, candidate);
  const lookup = (id) =>
    prepared.start.catalog.get(id) ??
    prepared.reference.catalog.get(id) ??
    candidate.catalog.get(id);
  const differences = [];
  for (const direction of ["removal", "addition"]) {
    const expected = direction === "removal" ? prepared.expected.removed : prepared.expected.added;
    const observed = direction === "removal" ? actual.removed : actual.added;
    for (const id of new Set([...expected.keys(), ...observed.keys()])) {
      const want = expected.get(id) ?? 0,
        have = observed.get(id) ?? 0;
      const kind = have < want ? `missing-${direction}` : `unexpected-${direction}`;
      for (let copy = 1; copy <= Math.abs(want - have); copy++)
        differences.push({
          id: `${kind}:${id}:${copy}`,
          kind,
          action: actions[kind],
          unitId: id,
          unit: lookup(id),
        });
    }
  }
  differences.sort(
    (left, right) =>
      order(left.unit.file, right.unit.file) ||
      order(JSON.stringify(left.unit.scope), JSON.stringify(right.unit.scope)) ||
      order(left.id, right.id),
  );
  return {
    version: STRUCTURAL_UNIT_POLICY.version,
    policy: STRUCTURAL_UNIT_POLICY,
    startIdentity: prepared.startIdentity,
    referenceIdentity: prepared.referenceIdentity,
    actualIdentity: candidate.identity,
    totalUnits: prepared.totalUnits,
    actualChanges: total(actual),
    differences,
    differenceIds: differences.map(({ id }) => id),
    files: [...new Set(differences.map(({ unit }) => unit.file))].sort(order),
  };
}

export async function compareStructuralUnits(prepared, candidateTree) {
  return compareStructuralInventory(prepared, await structuralUnitInventory(candidateTree));
}
