import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { atomicOwnerFrames } from "../tasks/atomic-naming-replay.mjs";
import { prepareCoherentContract, evaluateCoherentContract } from "./coherent-grade.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const identifier = (text) => /^[A-Za-z_]\w*$/.test(text);
const shape = (frame) => [frame.file, frame.scope, frame.kind, frame.conditions];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tokenKey = (frame) => digest([...shape(frame), frame.tokens]);
const originKey = (frame) =>
  digest([frame.file, frame.scope, frame.kind, frame.originConditions, frame.tokens]);
function append(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
const masked = (tokens, slots) =>
  tokens.map((token, index) => (slots.has(index) && identifier(token) ? null : token));
const header = (tokens) => {
  const end = tokens.findIndex((token) => token === "{" || token === "=" || token === ";");
  return tokens.slice(0, end < 0 ? tokens.length : end);
};

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
  namingBatches,
  expectedSymbols,
}) {
  assert.ok(beforeTree && expectedTree, "Missing trusted round trees");
  assert.ok(
    nodes.length > 0 && new Set(nodes.map(({ id }) => id)).size === nodes.length,
    "Invalid round atom identities",
  );
  assert.ok(
    nodes.every((node) => node.operations.every(({ phase }) => phase === "names")),
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
          assert.ok(!previous || same(previous, site), "Conflicting endpoint naming slots");
          frame.slots.set(site.index, site);
          frame.ids.add(site.nodeId);
          covered.add(site.nodeId);
        }
      }
    }
  }
  for (const id of ids) assert.ok(covered.has(id), "Atom has no certified endpoint slots");
  const copies = new Map();
  for (const frame of frames) {
    frame.key = digest([...shape(frame), masked(frame.tokens, frame.slots)]);
    copies.set(frame.key, (copies.get(frame.key) ?? 0) + 1);
  }
  return {
    version: "renderer-atomic-round-credit-v1",
    nodes,
    frames,
    expectedTree,
    expectedSymbols,
    contract: prepareCoherentContract(expectedTree),
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
  for (const frame of expected) {
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
    matches.set(frame, candidates);
    for (const other of candidates) append(reverse, other, frame);
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
    groups.get(key).add(position);
  }
  const identities = new Map(
    [...groups].map(([key, values]) => [key, JSON.stringify([...values].sort())]),
  );
  const target = (row, reference) => {
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
    const source = Buffer.from(tree[file]),
      chunks = [];
    let start = 0;
    for (const edit of [...changes.values()].sort((left, right) => left.start - right.start)) {
      chunks.push(source.subarray(start, edit.start), Buffer.from(edit.text));
      start = edit.end;
    }
    chunks.push(source.subarray(start));
    projected[file] = Buffer.concat(chunks).toString("utf8");
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
  const { frames: expected } = prepared;
  const { matches, reverse } = matchFrames(actual, expected);
  const failures = new Map(prepared.nodes.map(({ id }) => [id, []]));
  const preservationFailures = [];
  const fail = (frame, category) => {
    for (const id of frame.ids) failures.get(id).push({ category, file: frame.file });
    // A failed TU cannot prove an unchanged owner's binding integrity, but it
    // also cannot prove collateral corruption. Only affected atom certification
    // is denied; direct lexical or successful-TU binding violations veto integrity.
    if (!frame.ids.size && category !== "compiler-context")
      preservationFailures.push({ category, file: frame.file });
  };
  const expectedView = prepared.compiler;
  const actualView = compilerView(candidateSymbols, actual, (frame) => {
    const candidates = reverse.get(frame) ?? [];
    return candidates.length && candidates.every((item) => item.key === candidates[0].key)
      ? candidates[0].key
      : undefined;
  });
  for (const frame of expected) {
    const candidates = matches.get(frame);
    const copies = prepared.copies.get(frame.key);
    if (candidates.length !== copies) {
      fail(frame, "protected-owner");
      continue;
    }
    for (const other of candidates) {
      for (const [index, site] of frame.slots)
        if (other.tokens[index] !== site.to)
          failures.get(site.nodeId).push({ category: "requested-name", file: frame.file });
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
            failures.get(site.nodeId).push({ category: "compiler-binding", file: frame.file });
          else fail(frame, "compiler-binding");
        }
      }
    }
  }
  // A failed matching owner may still be recognized by its protected declaration
  // header. This is attribution only: it can never establish successful credit.
  const attributed = (frame) => {
    const exact = reverse.get(frame) ?? [];
    if (exact.length) return exact;
    return expected.filter(
      (other) =>
        other.ids.size &&
        same(shape(frame), shape(other)) &&
        same(header(masked(frame.tokens, other.slots)), header(masked(other.tokens, other.slots))),
    );
  };
  for (const frame of actual) {
    if (!reverse.has(frame) && !attributed(frame).length)
      preservationFailures.push({ category: "unexpected-owner", file: frame.file });
  }
  const projected = lexicalProjection(tree, expected, matches);
  const lexical = evaluateCoherentContract(projected, prepared.contract);
  const records = new Map(prepared.contract.obligations.map((record) => [record.id, record]));
  try {
    for (const record of prepareCoherentContract(projected).obligations)
      records.set(record.id, record);
  } catch {
    // Missing trustworthy lexical coverage is an explicit integrity failure.
  }
  for (const obligation of lexical.obligations.filter(({ status }) => status === "fail")) {
    if (obligation.kind === "files") {
      for (const file of new Set([...prepared.contract.files, ...Object.keys(tree)])) {
        if (prepared.contract.files.includes(file) === Object.hasOwn(tree, file)) continue;
        const owners = expected.filter((frame) => frame.file === file);
        if (!owners.length || owners.some((frame) => !frame.ids.size))
          preservationFailures.push({ category: "physical-file", file });
      }
      continue;
    }
    const record = records.get(obligation.id);
    const relevant =
      record &&
      [...expected, ...actual].filter(
        (frame) =>
          frame.file === record.file &&
          (record.kind === "comment"
            ? frame.tokens.includes(record.tokens[0])
            : frame.scope === record.scope &&
              frame.kind === record.kind &&
              same(frame.conditions, record.conditions) &&
              same(frame.tokens, record.tokens)),
      );
    const owners =
      relevant?.flatMap((frame) => (expected.includes(frame) ? [frame] : attributed(frame))) ?? [];
    if (owners.length && owners.every((frame) => frame.ids.size)) {
      for (const frame of owners) fail(frame, "protected-context");
    } else {
      preservationFailures.push({
        category: "protected-context",
        file: obligation.file,
        kind: obligation.kind,
      });
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
