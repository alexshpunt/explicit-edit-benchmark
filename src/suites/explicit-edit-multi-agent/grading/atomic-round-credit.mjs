import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { atomicOwnerFrames } from "../tasks/atomic-naming-replay.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
  createStandardUsingContext,
} from "./coherent-grade.mjs";
import {
  prepareStructuralCredit,
  physicalRecordKey,
  structuralRecordOwners,
} from "./structural-credit.mjs";
import { namespaceShellCounts } from "./round-footprints.mjs";
import { encodeSourceBytes, decodeSourceBytes } from "../cpp/source-bytes.mjs";
import { createFrameAttribution } from "./frame-attribution.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const identifier = (text) => /^[A-Za-z_]\w*$/.test(text);
const slotIds = (site) => site.nodeIds ?? [site.nodeId];
const shape = (frame) => [frame.file, frame.scope, frame.kind, frame.conditions];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tokenKey = (frame) => digest([...shape(frame), frame.tokens]);
const originKey = (frame) =>
  digest([frame.file, frame.scope, frame.kind, frame.originConditions, frame.tokens]);
function append(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function frameRecords(tree) {
  const frames = [],
    invalid = [];
  for (const [file, source] of Object.entries(tree)) {
    try {
      frames.push(...atomicOwnerFrames({ [file]: source }));
    } catch (error) {
      invalid.push({ file, message: error.message });
    }
  }
  return { frames, invalid };
}

/** Seal private endpoint requirements, never candidate-derived expected answers.
 * Sibling binding slots share a physical owner but not a binary credit decision.
 * Unsupported atom kinds fail preparation rather than silently receiving credit.
 */
export function prepareAtomicRoundCredit({
  beforeTree,
  expectedTree,
  nodes,
  namingBatches = [],
  structuralFootprints,
  expectedSymbols,
}) {
  assert.ok(beforeTree && expectedTree, "Missing trusted round trees");
  assert.ok(
    nodes.length > 0 && new Set(nodes.map(({ id }) => id)).size === nodes.length,
    "Invalid round atom identities",
  );
  assert.ok(
    nodes.every(
      (node) =>
        node.operations.length > 0 &&
        node.operations.every(({ phase }) => ["names", "structure"].includes(phase)),
    ),
    "Unsupported endpoint atom kind",
  );
  assert.equal(expectedSymbols?.status, "pass", "Invalid trusted compiler endpoint");
  assert.equal(
    expectedSymbols.credit?.version,
    "renderer-binding-anchors-v1",
    "Missing trusted compiler anchors",
  );
  const ids = new Set(nodes.map(({ id }) => id));
  const frames = atomicOwnerFrames(expectedTree).map((frame) => ({
    ...frame,
    slots: new Map(),
    ids: new Set(),
    structuralIds: new Set(),
    contextIds: new Set(),
    requiredIds: new Set(),
  }));
  const byOrigin = new Map();
  for (const frame of frames) append(byOrigin, originKey(frame), frame);
  const covered = new Set();
  for (const batch of namingBatches) {
    assert.equal(batch.version, "private-atomic-naming-batch-v1", "Invalid endpoint naming batch");
    for (const owner of batch.owners) {
      const tokens = [...owner.tokens];
      for (const site of owner.sites) tokens[site.index] = site.to;
      const matches = byOrigin.get(originKey({ ...owner, file: owner.originFile, tokens })) ?? [];
      // Identical physical declarations may be a uniform family. Every copy must
      // satisfy the same binding slots; no convenient duplicate is selected.
      assert.ok(matches.length > 0, "Missing trusted naming endpoint owner");
      for (const frame of matches) {
        for (const site of owner.sites) {
          assert.ok(ids.has(site.nodeId), "Naming site outside this round");
          const previous = frame.slots.get(site.index);
          assert.ok(!previous || previous.to === site.to, "Conflicting endpoint naming slots");
          // Different original parameters can converge to identical prototypes.
          // Keep every obligation: an indistinguishable family must satisfy all
          // copies, never credit one convenient copy or overwrite a sibling atom.
          frame.slots.set(site.index, {
            ...site,
            nodeIds: [...new Set([...(previous ? slotIds(previous) : []), site.nodeId])],
          });
          frame.ids.add(site.nodeId);
          covered.add(site.nodeId);
        }
      }
    }
  }
  for (const node of nodes.filter((node) => node.operations[0].phase === "names"))
    assert.ok(covered.has(node.id), "Atom has no certified endpoint slots");
  const contract = prepareCoherentContract(expectedTree);
  const structural = prepareStructuralCredit({
    beforeTree,
    frames,
    contract,
    nodes,
    namingBatches,
    footprints: structuralFootprints,
    expectedSymbols,
  });
  const copies = new Map();
  for (const frame of frames) {
    frame.key = tokenKey(frame);
    copies.set(frame.key, (copies.get(frame.key) ?? 0) + 1);
  }
  return {
    version: "renderer-atomic-round-credit-v1",
    nodes,
    frames,
    expectedTree,
    expectedSymbols,
    contract,
    structural,
    copies,
    compiler: compilerView(expectedSymbols, frames, (frame) => frame.key),
  };
}

function matchFrames(actual, expected) {
  const matches = new Map(),
    reverse = new Map();
  const full = new Map(),
    shapes = new Map();
  for (const frame of actual) {
    append(full, tokenKey(frame), frame);
    append(shapes, JSON.stringify(shape(frame)), frame);
  }
  const expectedKeys = new Set(expected.map(tokenKey));
  for (const frame of expected) {
    const key = tokenKey(frame);
    const canonical = full.get(key) ?? [];
    const candidates = frame.slots.size
      ? (shapes.get(JSON.stringify(shape(frame))) ?? []).filter(
          (other) =>
            other.tokens.length === frame.tokens.length &&
            other.tokens.every(
              (token, index) =>
                (frame.slots.has(index) && identifier(token)) || token === frame.tokens[index],
            ),
        )
      : (full.get(tokenKey(frame)) ?? []);
    // Preserve distinct requested names even when masking would make two
    // physical owners identical. A complete canonical sibling is not evidence
    // for another, misspelled owner; ambiguous leftovers remain fail-closed.
    const selected = canonical.length
      ? canonical
      : candidates.filter((other) => !expectedKeys.has(tokenKey(other)));
    matches.set(frame, selected);
    for (const other of selected) append(reverse, other, frame);
  }
  return { matches, reverse };
}

function locate(frames, file, offset) {
  const candidates = frames.get(file) ?? [];
  let first = 0,
    last = candidates.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (candidates[middle].start <= offset) first = middle + 1;
    else last = middle;
  }
  const frame = candidates[first - 1];
  if (!frame || offset >= frame.end) return undefined;
  let low = 0,
    high = frame.positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frame.positions[middle].start <= offset) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  return index >= 0 && offset < frame.positions[index].end ? { frame, index } : undefined;
}

function compilerView(symbols, frames, identity) {
  assert.equal(
    symbols?.credit?.version,
    "renderer-binding-anchors-v1",
    "Missing actual compiler anchors",
  );
  const byFile = new Map();
  for (const frame of frames) {
    if (!byFile.has(frame.file)) byFile.set(frame.file, []);
    byFile.get(frame.file).push(frame);
  }
  for (const entries of byFile.values()) entries.sort((left, right) => left.start - right.start);
  const point = (row) => {
    const found = locate(byFile, row.file, row.offset);
    const key = found && identity(found.frame);
    return key ? JSON.stringify([key, found.index, row.kind]) : undefined;
  };
  const groups = new Map();
  for (const row of symbols.credit.anchors) {
    if (row.role !== "declaration") continue;
    const key = JSON.stringify([row.translationUnit, row.id]);
    const position =
      point(row) ?? (row.kind === "NAMESPACE" ? JSON.stringify(["namespace", row.id]) : undefined);
    if (!position) continue;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(JSON.stringify([position, row.namespaceContext ?? null]));
  }
  const identities = new Map(
    [...groups].map(([key, values]) => [key, JSON.stringify([...values].sort())]),
  );
  const usingTargets = new Map();
  for (const row of symbols.credit.anchors) {
    if (row.role !== "reference" || row.kind !== "USING_DECLARATION") continue;
    append(usingTargets, JSON.stringify([row.translationUnit, row.file, row.offset]), row.target);
  }
  const target = (row, reference, visited = new Set()) => {
    if (reference.namespace) return JSON.stringify(["namespace", reference.namespace]);
    if (reference.kind === "UNEXPOSED_DECL" && reference.file) {
      const key = JSON.stringify([row.translationUnit, reference.file, reference.offset]);
      const aliases = usingTargets.get(key);
      if (aliases) {
        if (visited.has(key)) return undefined;
        const next = new Set(visited).add(key);
        const candidates = aliases.map((declaration) => target(row, declaration, next));
        if (candidates.some((candidate) => candidate === undefined)) return undefined;
        return JSON.stringify(["using-targets", [...new Set(candidates)].sort()]);
      }
    }
    if (Array.isArray(reference.overloads)) {
      if (!reference.overloads.length) return undefined;
      const candidates = reference.overloads.map((declaration) =>
        target(row, declaration, visited),
      );
      if (candidates.some((candidate) => candidate === undefined)) return undefined;
      return JSON.stringify(["overload-set", [...new Set(candidates)].sort()]);
    }
    if (reference.external) {
      return JSON.stringify(
        reference.file && Number.isSafeInteger(reference.offset)
          ? ["system", reference.file, reference.offset, reference.kind]
          : ["system", reference.kind, reference.usr ?? reference.id],
      );
    }
    return identities.get(JSON.stringify([row.translationUnit, reference.id]));
  };
  const rows = new Map();
  for (const row of symbols.credit.anchors) {
    const found = locate(byFile, row.file, row.offset);
    if (!found) continue;
    const key = JSON.stringify([row.translationUnit, found.index, row.kind, row.role]);
    const value = target(row, row.role === "declaration" ? row : row.target);
    if (!rows.has(found.frame)) rows.set(found.frame, new Map());
    const facts = rows.get(found.frame);
    if (!facts.has(key)) facts.set(key, new Set());
    facts.get(key).add(value ?? "unresolved");
  }
  return {
    rows,
    units: new Map(symbols.credit.translationUnits.map((unit) => [unit.file, unit])),
  };
}

function bindingKey(rows = new Map()) {
  if ([...rows.values()].some((values) => values.has("unresolved"))) return null;
  return digest(
    [...rows]
      .map(([key, values]) => [key, [...values].sort()])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
function bindingDifferences(expected = new Map(), actual = new Map()) {
  const differences = new Set();
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    const left = expected.get(key),
      right = actual.get(key);
    if (
      !left ||
      !right ||
      left.has("unresolved") ||
      right.has("unresolved") ||
      left.size !== right.size ||
      [...left].some((value) => !right.has(value))
    )
      differences.add(JSON.parse(key)[1]);
  }
  return differences;
}

// This projection exists ONLY to reuse lexical preservation/context checks.
// Compiler facts always come from the original candidate, never this projection.
function lexicalProjection(tree, expected, matches) {
  const edits = new Map();
  for (const frame of expected) {
    const candidates = matches.get(frame);
    if (candidates.length !== 1) continue;
    const actual = candidates[0];
    for (const [index, site] of frame.slots) {
      if (!edits.has(actual.file)) edits.set(actual.file, new Map());
      const span = actual.positions[index];
      edits.get(actual.file).set(span.start, { ...span, text: site.to });
    }
  }
  const projected = { ...tree };
  for (const [file, changes] of edits) {
    const source = encodeSourceBytes(tree[file]),
      chunks = [];
    let start = 0;
    for (const edit of [...changes.values()].sort((left, right) => left.start - right.start)) {
      chunks.push(source.subarray(start, edit.start), Buffer.from(edit.text));
      start = edit.end;
    }
    chunks.push(source.subarray(start));
    projected[file] = decodeSourceBytes(Buffer.concat(chunks));
  }
  return projected;
}

/** Evaluate exactly one drained original candidate using one compiler invocation.
 * Raw atom evidence survives a separate unattributed-preservation integrity veto.
 * No generated source, corrected compiler run or scheduling-edge propagation can
 * establish credit. Compiler recovery facts are never part of this view.
 */
export function evaluateAtomicRoundCredit(tree, prepared, { candidateSymbols }) {
  assert.equal(prepared.version, "renderer-atomic-round-credit-v1", "Invalid endpoint preparation");
  const { frames: actual, invalid } = frameRecords(tree);
  const { frames: expected, structural } = prepared;
  const { matches, reverse } = matchFrames(actual, expected);
  const failures = new Map(prepared.nodes.map(({ id }) => [id, []]));
  const preservationFailures = [];
  const counts = (records) => {
    const result = new Map();
    for (const record of records) {
      const key = physicalRecordKey(record);
      result.set(key, (result.get(key) ?? 0) + (record.count ?? 1));
    }
    return result;
  };
  const expectedFrames = counts(expected),
    actualFrames = counts(actual);
  const samePhysicalFrame = (frame) => {
    const key = physicalRecordKey(frame);
    return expectedFrames.get(key) === actualFrames.get(key);
  };
  const frameOwners = (frame) =>
    new Set([
      ...frame.ids,
      ...frame.requiredIds,
      ...(samePhysicalFrame(frame) ? frame.contextIds : []),
    ]);
  const charge = (ids, category, file, unknown = false) => {
    for (const id of ids) failures.get(id).push({ category, file });
    // Missing successful compiler evidence denies certification but is not proof
    // of collateral damage to a physically unchanged, unassigned owner.
    if (!ids.size && !unknown) preservationFailures.push({ category, file });
  };
  const fail = (frame, category) =>
    charge(frameOwners(frame), category, frame.file, category === "compiler-context");
  const expectedView = prepared.compiler;
  const actualView = compilerView(candidateSymbols, actual, (frame) => {
    const candidates = reverse.get(frame) ?? [];
    return candidates.length && candidates.every((item) => item.key === candidates[0].key)
      ? candidates[0].key
      : undefined;
  });
  const expectedBindings = new Map(
    expected.map((frame) => [frame, bindingKey(expectedView.rows.get(frame))]),
  );
  const actualBindings = new Map(
    actual.map((frame) => [frame, bindingKey(actualView.rows.get(frame))]),
  );
  const bindingCopies = new Map();
  for (const frame of expected) {
    const key = JSON.stringify([frame.key, expectedBindings.get(frame)]);
    bindingCopies.set(key, (bindingCopies.get(key) ?? 0) + 1);
  }
  for (const frame of expected) {
    let candidates = matches.get(frame);
    if (candidates.length !== prepared.copies.get(frame.key)) {
      fail(frame, "protected-owner");
      continue;
    }
    // Identical source copies can be active in different macro frontiers. Match
    // the complete multiset of real compiler facts, not every cross-product pair.
    const signature = expectedBindings.get(frame);
    if (signature !== null) {
      const compatible = candidates.filter((other) => actualBindings.get(other) === signature);
      if (compatible.length === bindingCopies.get(JSON.stringify([frame.key, signature])))
        candidates = compatible;
    }
    for (const other of candidates) {
      for (const [index, site] of frame.slots)
        if (other.tokens[index] !== site.to)
          charge(new Set(slotIds(site)), "requested-name", frame.file);
      const units = [...expectedView.units.values()].filter((unit) =>
        unit.files.includes(frame.file),
      );
      if (
        !units.length ||
        units.some((unit) => actualView.units.get(unit.file)?.status !== "pass")
      ) {
        fail(frame, "compiler-context");
      } else {
        for (const index of bindingDifferences(
          expectedView.rows.get(frame),
          actualView.rows.get(other),
        )) {
          const site = frame.slots.get(index);
          if (site)
            charge(
              new Set([...slotIds(site), ...frame.structuralIds]),
              "compiler-binding",
              frame.file,
            );
          else fail(frame, "compiler-binding");
        }
      }
    }
  }
  // Recognizing an old or damaged assigned declaration is attribution only. It
  // does not establish credit for the required canonical destination.
  const attributed = createFrameAttribution(expected, reverse);
  for (const frame of actual) {
    if (reverse.has(frame)) continue;
    const owners = new Set(attributed(frame).flatMap((other) => [...frameOwners(other)]));
    for (const id of structuralRecordOwners(frame, structural)) owners.add(id);
    charge(owners, "unexpected-owner", frame.file);
  }
  const projected = lexicalProjection(tree, expected, matches);
  const lexical = evaluateCoherentContract(projected, prepared.contract);
  let actualContract;
  try {
    actualContract = prepareCoherentContract(projected);
  } catch {
    preservationFailures.push({ category: "lexical-coverage" });
  }
  const expectedCounts = counts(prepared.contract.obligations);
  const actualCounts = counts(actualContract?.obligations ?? []);
  const samePhysicalRecord = (record) => {
    const key = physicalRecordKey(record);
    return expectedCounts.get(key) === actualCounts.get(key);
  };
  const records = new Map(
    [...prepared.contract.obligations, ...(actualContract?.obligations ?? [])].map((record) => [
      record.id,
      record,
    ]),
  );
  for (const obligation of lexical.obligations.filter(({ status }) => status === "fail")) {
    if (obligation.kind === "files") {
      for (const file of new Set([...prepared.contract.files, ...Object.keys(tree)])) {
        if (prepared.contract.files.includes(file) === Object.hasOwn(tree, file)) continue;
        const owners = new Set(
          structural.fileGoals.filter((goal) => goal.file === file).map(({ id }) => id),
        );
        for (const frame of expected.filter((frame) => frame.file === file))
          for (const id of frameOwners(frame)) owners.add(id);
        charge(owners, "physical-file", file);
      }
      continue;
    }
    const record = records.get(obligation.id);
    const owners = new Set();
    if (record) {
      const roles = structural.recordOwners.get(record.id);
      for (const id of [
        ...(roles?.physical ?? []),
        ...(roles?.required ?? []),
        ...(samePhysicalRecord(record) ? (roles?.context ?? []) : []),
      ])
        owners.add(id);
      for (const id of structuralRecordOwners(record, structural)) owners.add(id);
      for (const frame of [...expected, ...actual].filter(
        (frame) =>
          frame.file === record.file &&
          (record.kind === "comment"
            ? frame.tokens.includes(record.tokens[0])
            : frame.scope === record.scope &&
              frame.kind === record.kind &&
              same(frame.conditions, record.conditions) &&
              same(frame.tokens, record.tokens)),
      )) {
        for (const owner of expected.includes(frame) ? [frame] : attributed(frame))
          for (const id of frameOwners(owner)) owners.add(id);
      }
    }
    charge(owners, "protected-context", obligation.file);
  }
  for (const { id, record, count } of structural.countGoals) {
    if ((actualCounts.get(physicalRecordKey(record)) ?? 0) !== count)
      charge(new Set([id]), "physical-count", record.file);
  }
  for (const { id, file, present } of structural.fileGoals) {
    if (Object.hasOwn(tree, file) !== present) charge(new Set([id]), "physical-file", file);
  }
  const shellsByFile = new Map();
  for (const { id, file, scope, count } of structural.namespaceGoals) {
    if (!shellsByFile.has(file)) {
      try {
        shellsByFile.set(
          file,
          namespaceShellCounts(Object.hasOwn(tree, file) ? { [file]: tree[file] } : {}),
        );
      } catch {
        shellsByFile.set(file, undefined);
      }
    }
    const shells = shellsByFile.get(file);
    if (!shells || (shells.get(JSON.stringify([file, scope])) ?? 0) !== count)
      charge(new Set([id]), "namespace-cleanup", file);
  }
  const importContext = createStandardUsingContext(tree);
  for (const record of structural.imports) {
    for (const frame of structural.dependencies.get(record.id) ?? []) {
      for (const consumer of matches.get(frame)) {
        if (
          !importContext({ ...record, file: consumer.file, conditions: [] }, false, {
            consumer,
          })
        )
          charge(frameOwners(frame), "required-import", consumer.file);
      }
    }
  }
  for (const { file } of invalid) preservationFailures.push({ category: "lexical-coverage", file });
  const atoms = prepared.nodes.map(({ id }) => ({
    id,
    passed: failures.get(id).length === 0,
    failures: failures.get(id),
  }));
  return {
    version: prepared.version,
    atoms,
    passed: atoms.filter(({ passed }) => passed).length,
    total: atoms.length,
    integrityPassed: preservationFailures.length === 0,
    preservationFailures,
  };
}
