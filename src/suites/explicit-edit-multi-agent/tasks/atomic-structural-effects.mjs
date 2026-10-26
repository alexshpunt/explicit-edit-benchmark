import { prepareCoherentContract } from "../grading/coherent-grade.mjs";

const recordKey = ({ id: _id, count: _count, ...record }) => JSON.stringify(record);

/** Describe changes between two trusted preparation snapshots. These records only
 * derive structural dependencies; they never inspect or accept candidate edits.
 * Context-only changes are retained here and excluded by atomicEffectGraph when
 * deciding which declarations an operation physically writes.
 */
export function prepareAtomicEffect(
  beforeTree,
  afterTree,
  { readInventory = prepareCoherentContract } = {},
) {
  const before = readInventory(beforeTree);
  const after = readInventory(afterTree);
  const inputs = new Map(before.obligations.map((record) => [recordKey(record), record]));
  const outputs = new Map(after.obligations.map((record) => [recordKey(record), record]));
  const remove = before.obligations.filter(
    (record) => outputs.get(recordKey(record))?.count !== record.count,
  );
  const add = after.obligations.filter(
    (record) => inputs.get(recordKey(record))?.count !== record.count,
  );
  if (!remove.length && !add.length && JSON.stringify(before.files) === JSON.stringify(after.files))
    throw Error("Atomic edit has no structural effect");
  return { remove, add };
}
