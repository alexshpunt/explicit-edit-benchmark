import assert from "node:assert/strict";
import { evaluateAtomicBindingGate } from "./atomic-binding-gate.mjs";
import { prepareCoherentContract, standardUsingContext } from "./coherent-grade.mjs";

function recordKey({ id: _id, count: _count, ...record }) {
  return JSON.stringify(record);
}

// Physical file and contextual hashes are checked in the record, not the family.
// Otherwise a moved duplicate or changed macro context would disappear from view.
function resource(record) {
  if (record.kind === "owner") return JSON.stringify([record.kind, record.scope, record.selector]);
  if (record.kind === "conditional")
    return JSON.stringify([record.kind, record.scope, record.directives]);
  return JSON.stringify([record.kind, record.scope ?? "", record.tokens]);
}

function sameImport(left, right) {
  return (
    left.kind === "using" &&
    right.kind === "using" &&
    left.scope === right.scope &&
    JSON.stringify(left.conditions) === JSON.stringify(right.conditions) &&
    JSON.stringify(left.tokens) === JSON.stringify(right.tokens)
  );
}

function literalImport(record) {
  return (
    record.kind === "using" &&
    !record.conditions.length &&
    record.tokens.join("") === "usingnamespacestd::string_literals;"
  );
}

/** Compile a private lexical gate from trusted immediate before/after trees.
 * remove/add contain the complete input/output record sets for affected families,
 * including unchanged declarations in those families, not just a set difference.
 * The gate is JSON-serializable but contains reference answers: never mount it in
 * an agent or reference editing worker. Callers must supply the current structural
 * frontier; namespace, macro and conditional context are not order-independent.
 * writesOnly selects physical writes rather than claiming an unchanged peer body
 * merely because surrounding context changed. Selected records still retain exact
 * macro/conditional metadata; full barriers check all untouched peer obligations.
 * Include-only or empty-wrapper edits without inventory effects are not supported.
 */
export function prepareAtomicGate(beforeTree, afterTree, { writesOnly = false } = {}) {
  const before = prepareCoherentContract(beforeTree);
  const after = prepareCoherentContract(afterTree);
  const inputs = new Map(before.obligations.map((record) => [recordKey(record), record]));
  const outputs = new Map(after.obligations.map((record) => [recordKey(record), record]));
  const resources = new Set();
  if (writesOnly) {
    const changes = new Map();
    for (const [records, sign] of [
      [before.obligations, -1],
      [after.obligations, 1],
    ])
      for (const record of records) {
        const key = JSON.stringify([
          record.file,
          record.kind,
          record.scope,
          record.selector,
          record.tokens,
          record.directives,
        ]);
        const previous = changes.get(key);
        changes.set(key, { record, count: (previous?.count ?? 0) + sign * record.count });
      }
    for (const { record, count } of changes.values()) if (count) resources.add(resource(record));
  } else {
    for (const [key, record] of inputs)
      if (outputs.get(key)?.count !== record.count) resources.add(resource(record));
    for (const [key, record] of outputs)
      if (inputs.get(key)?.count !== record.count) resources.add(resource(record));
  }
  const created = after.files.filter((file) => !Object.hasOwn(beforeTree, file));
  const deleted = before.files.filter((file) => !Object.hasOwn(afterTree, file));
  if (!resources.size && !created.length && !deleted.length)
    throw Error("Atomic edit has no structural effect");
  const remove = before.obligations.filter((record) => resources.has(resource(record)));
  const add = after.obligations.filter((record) => resources.has(resource(record)));
  const files = [
    ...new Set([...remove, ...add].map((item) => item.file).concat(created, deleted)),
  ].sort();
  return {
    remove,
    add,
    requiredFiles: {
      before: files.filter((file) => Object.hasOwn(beforeTree, file)),
      after: files.filter((file) => Object.hasOwn(afterTree, file)),
      created,
      deleted,
    },
    resources: [...resources].sort(),
  };
}

/** Rebase a previously selected output family onto a trusted combined frontier.
 * This avoids inverting an earlier move after its dependent moves have settled.
 * It does not add resources or grant completion; use only controller-owned trees.
 * Output file presence follows this frontier, not the canonical extraction order.
 * Input requirements still come from a freshly prepared before/after gate.
 */
export function projectAtomicGate(
  expectedTree,
  template,
  { readInventory = prepareCoherentContract } = {},
) {
  const contract = readInventory(expectedTree);
  const families = new Set(template.resources);
  const add = contract.obligations.filter((record) => families.has(resource(record)));
  return {
    ...template,
    add,
    requiredFiles: {
      ...template.requiredFiles,
      after: [
        ...new Set([
          ...template.requiredFiles.after.filter((file) => Object.hasOwn(expectedTree, file)),
          ...add.map((record) => record.file),
        ]),
      ].sort(),
      deleted: template.requiredFiles.deleted.filter((file) => !Object.hasOwn(expectedTree, file)),
    },
  };
}
function evaluate(
  tree,
  gate,
  input,
  activeWrites,
  bindingRecords = [],
  familyRecords,
  readInventory = prepareCoherentContract,
  occurrenceFiles = [],
) {
  const obligations = [];
  const add = (id, status, detail) => obligations.push({ id, status, ...detail });
  const files = gate.requiredFiles;
  for (const file of input ? files.before : files.after)
    add(`file:${file}`, Object.hasOwn(tree, file) ? "pass" : "fail", { kind: "file", file });
  for (const file of input ? files.created : files.deleted)
    add(`absent:${file}`, Object.hasOwn(tree, file) ? "fail" : "pass", { kind: "absent", file });
  let actual;
  try {
    actual = readInventory(tree).obligations;
  } catch (error) {
    add("source", "fail", { kind: "source", message: error.message });
  }
  assert.ok(Array.isArray(bindingRecords), "Invalid delegated binding records");
  assert.ok(!input || !bindingRecords.length, "Input gates cannot delegate binding output");
  const selected = new Map(gate.add.map((record) => [record.id, record]));
  for (const { masks: _masks, occurrences: _occurrences, ...record } of bindingRecords)
    assert.deepEqual(
      record,
      selected.get(record.id),
      "Delegated binding differs from expected output",
    );
  const binding = bindingRecords.length
    ? evaluateAtomicBindingGate(
        tree,
        { records: bindingRecords, familyRecords, occurrenceFiles },
        { physicalOnly: true, readInventory },
      )
    : null;
  const delegated = new Set(bindingRecords.map((record) => record.id));
  const observed = new Set(binding?.observedIds ?? []);
  const expected = (input ? gate.remove : gate.add).filter((record) => !delegated.has(record.id));
  const families = new Set(gate.resources);
  const remaining = new Map(
    (actual ?? [])
      .filter((record) => families.has(resource(record)) && !observed.has(record.id))
      .map((record) => [recordKey(record), record]),
  );
  for (const record of expected) {
    const key = recordKey(record);
    const found = remaining.get(key)?.count ?? 0;
    const context = Boolean(actual) && standardUsingContext(tree, record);
    const inherited =
      found === 0 &&
      context &&
      (!literalImport(record) || actual.some((item) => sameImport(item, record)));
    add(
      record.id,
      (found === record.count && (!literalImport(record) || context)) || inherited
        ? "pass"
        : "fail",
      {
        kind: record.kind,
        file: record.file,
        scope: record.scope,
        selector: record.selector,
        expected: record.count,
        actual: found,
        ...(inherited ? { context: "inherited-or-unused" } : {}),
      },
    );
    remaining.delete(key);
  }
  for (const record of remaining.values()) {
    const harmless = literalImport(record)
      ? expected.some((item) => sameImport(item, record)) && standardUsingContext(tree, record)
      : standardUsingContext(tree, record, true);
    add(record.id, harmless ? "pass" : "fail", {
      kind: harmless ? "using-context" : "unexpected",
      file: record.file,
      scope: record.scope,
      selector: record.selector,
      actual: record.count,
    });
  }
  for (const record of binding?.records ?? [])
    add(record.id, record.status, {
      kind: "binding-owner",
      ...(record.reason ? { reason: record.reason } : {}),
    });
  if (binding?.reason === "source" && !binding.records.length)
    add("binding-source", "unobservable", { kind: "source", message: binding.message });
  const passed = obligations.filter((item) => item.status === "pass").length;
  const unobservable = obligations.some((item) => item.status === "unobservable");
  return {
    status:
      passed === obligations.length
        ? "pass"
        : activeWrites
          ? "pending"
          : unobservable
            ? "unobservable"
            : "fail",
    passed,
    total: obligations.length,
    obligations,
  };
}

/** Check an atomic output without imposing unrelated peer endpoints.
 * This is a lexical preservation gate, not a compilation or binding-resolution
 * proof. Mismatches while peer writers are active remain pending. The controller
 * must obtain a stable snapshot and recheck inputs before dispatching successors.
 * Optional bindingRecords delegate exact selected output owners to physical-only
 * peer-slot checks. Their complete unmasked records must equal gate.add entries;
 * only their matched actual record IDs leave lexical comparison. Other families,
 * including consumed old declarations, still detect retained copies. Supply only
 * private compiler-certified unverified peer slots, never candidate-derived masks.
 * Pass familyRecords from the complete trusted coherent frontier when delegated
 * owners share declarators with legitimate unprojected translation-unit copies.
 * This is forwarded only for global multiplicity, not additional lexical waivers.
 * Optional readInventory shares immutable exact-source lexical records between
 * controller gates. It must never reuse decisions or substitute expected source.
 */
export function evaluateAtomicGate(
  tree,
  gate,
  {
    activeWrites = false,
    bindingRecords = [],
    familyRecords,
    occurrenceFiles = [],
    readInventory = prepareCoherentContract,
  } = {},
) {
  return evaluate(
    tree,
    gate,
    false,
    activeWrites,
    bindingRecords,
    familyRecords,
    readInventory,
    occurrenceFiles,
  );
}

/** Require the consumed input records before dispatching an atomic edit.
 * Previously accepted predecessors do not waive this check: a peer may have
 * overwritten them. The caller owns snapshot stability and subsequent races.
 */
export function checkAtomicInputs(
  tree,
  gate,
  { activeWrites = false, readInventory = prepareCoherentContract } = {},
) {
  return evaluate(tree, gate, true, activeWrites, [], undefined, readInventory);
}
