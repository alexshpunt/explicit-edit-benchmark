import assert from "node:assert/strict";
import { prepareCoherentContract } from "./coherent-grade.mjs";
import { atomicFileTokens, atomicFileOwners, atomicFileDirectives } from "./atomic-frontier.mjs";

const keywords = new Set(
  "alignas alignof and and_eq asm auto bitand bitor bool break case catch char char16_t char32_t class compl const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq".split(
    " ",
  ),
);
const identifier = (token) => /^[A-Za-z_]\w*$/.test(token) && !keywords.has(token);
const ignored = new Set(["id", "count", "selector", "tokens", "masks", "occurrences"]);
const context = (record) =>
  JSON.stringify(
    Object.keys(record)
      .filter((key) => !ignored.has(key))
      .sort()
      .map((key) => [key, record[key]]),
  );

function conditionalIdentity(record) {
  return (
    !Object.hasOwn(record, "selector") &&
    Array.isArray(record.directives) &&
    record.directives.length > 0 &&
    record.directives.every(
      (directive) =>
        Array.isArray(directive) &&
        directive.length > 0 &&
        directive.every((token) => typeof token === "string" && token.length > 0),
    )
  );
}

function validateMasks(record, supplied, input = false) {
  assert.ok(Array.isArray(supplied), "Missing binding masks");
  const masks = new Map();
  for (const mask of supplied) {
    assert.ok(
      mask &&
        Number.isInteger(mask.index) &&
        mask.index >= 0 &&
        mask.index < record.tokens.length &&
        !masks.has(mask.index),
      "Invalid or repeated binding mask index",
    );
    assert.ok(
      ["current", "peer"].includes(mask.role) &&
        identifier(mask.from) &&
        identifier(mask.to) &&
        mask.from !== mask.to,
      "Invalid binding mask",
    );
    assert.ok(
      record.tokens[mask.index] === mask.to ||
        ((input || mask.role === "peer") && record.tokens[mask.index] === mask.from),
      "Binding mask differs from its trusted expected token",
    );
    masks.set(mask.index, mask);
  }
  return masks;
}

function validateOccurrenceFiles(supplied = []) {
  assert.ok(Array.isArray(supplied), "Invalid occurrence file witnesses");
  const files = new Map();
  for (const file of supplied) {
    assert.ok(
      file && typeof file.file === "string" && file.file && !files.has(file.file),
      "Invalid or repeated occurrence file",
    );
    assert.ok(
      Array.isArray(file.tokens) &&
        file.tokens.length &&
        file.tokens.every((token) => typeof token === "string" && token.length),
      "Invalid occurrence file tokens",
    );
    assert.ok(
      Array.isArray(file.directives) &&
        file.directives.every(
          (directive) =>
            typeof directive === "string" &&
            directive.startsWith("#") &&
            directive.trim() === directive,
        ),
      "Invalid or missing occurrence file directives",
    );
    assert.ok(Array.isArray(file.slots), "Missing occurrence file slots");
    const slots = new Set();
    for (const index of file.slots) {
      assert.ok(
        Number.isSafeInteger(index) &&
          index >= 0 &&
          index < file.tokens.length &&
          identifier(file.tokens[index]) &&
          !slots.has(index),
        "Invalid or repeated occurrence file slot",
      );
      slots.add(index);
    }
    files.set(file.file, { tokens: file.tokens, slots, directives: file.directives });
  }
  return files;
}

function validateOccurrences(record, masks, files, input) {
  if (record.occurrences === undefined) return;
  assert.ok(
    Array.isArray(record.occurrences) && record.occurrences.length === record.count,
    "Occurrence count differs from its authoritative record",
  );
  const file = files.get(record.file);
  assert.ok(file, "Missing trusted occurrence file");
  const starts = new Set();
  const union = new Map();
  const occurrences = record.occurrences.map((occurrence) => {
    assert.ok(
      occurrence &&
        Number.isSafeInteger(occurrence.tokenStart) &&
        occurrence.tokenStart >= 0 &&
        occurrence.tokenStart + record.tokens.length <= file.tokens.length &&
        !starts.has(occurrence.tokenStart),
      "Invalid or repeated occurrence token start",
    );
    starts.add(occurrence.tokenStart);
    assert.deepEqual(
      file.tokens.slice(occurrence.tokenStart, occurrence.tokenStart + record.tokens.length),
      record.tokens,
      "Occurrence differs from its trusted expected record",
    );
    const local = validateMasks(record, occurrence.masks, input);
    for (const mask of local.values()) {
      assert.ok(
        file.slots.has(occurrence.tokenStart + mask.index),
        "Occurrence mask is outside certified file slots",
      );
      const options = union.get(mask.index) ?? [];
      options.push(mask);
      union.set(mask.index, options);
    }
    return { tokenStart: occurrence.tokenStart, masks: local };
  });
  assert.equal(masks.size, union.size, "Occurrence mask union differs from its record");
  for (const [index, mask] of masks)
    assert.ok(
      mask.role === "peer" &&
        union.get(index)?.some((local) => local.from === mask.from && local.to === mask.to),
      "Occurrence family masks must be the exact peer union",
    );
  return { file, occurrences };
}

function validate(records, physicalOnly, files, input) {
  assert.ok(Array.isArray(records) && records.length, "Missing private binding records");
  let current = 0;
  let reserved = 0;
  const ids = new Set();
  const entries = records.map((record) => {
    assert.ok(["owner", "conditional"].includes(record?.kind), "Invalid binding owner record");
    assert.ok(
      typeof record.id === "string" && record.id && !ids.has(record.id),
      "Repeated or missing binding record identity",
    );
    ids.add(record.id);
    assert.ok(
      typeof record.file === "string" && record.file && typeof record.scope === "string",
      "Invalid binding record location",
    );
    assert.ok(
      typeof record.macros === "string" &&
        Array.isArray(record.conditions) &&
        record.conditions.every(
          (condition) =>
            Array.isArray(condition) && condition.every((token) => typeof token === "string"),
        ),
      "Invalid binding record context",
    );
    assert.ok(
      Number.isSafeInteger(record.count) && record.count > 0,
      "Invalid binding record count",
    );
    assert.ok(
      Array.isArray(record.tokens) &&
        record.tokens.length &&
        record.tokens.every((token) => typeof token === "string" && token.length),
      "Invalid full binding record tokens",
    );
    assert.ok(
      record.kind === "conditional"
        ? conditionalIdentity(record)
        : typeof record.selector === "string" && headerLength(record) !== undefined,
      "Invalid binding record declarator or conditional directives",
    );
    const masks = validateMasks(record, record.masks, input);
    const occurrence = validateOccurrences(record, masks, files, input);
    const groups = occurrence ? occurrence.occurrences.map((copy) => copy.masks) : [masks];
    for (const group of groups)
      for (const mask of group.values()) {
        if (mask.role === "current") current++;
        reserved++;
      }
    return { record, masks, context: context(record), occurrence };
  });
  if (physicalOnly) {
    assert.equal(current, 0, "Physical-only projections accept peer masks only");
    assert.ok(reserved, "A physical-only projection requires peer masks");
  } else assert.ok(current, "A binding projection requires current masks");
  return entries;
}

function trustedFamilies(records, supplied) {
  const references = supplied ?? records;
  assert.ok(Array.isArray(references) && references.length, "Missing trusted family references");
  const byId = new Map();
  for (const record of references) {
    assert.ok(
      record && typeof record.id === "string" && record.id && !byId.has(record.id),
      "Repeated or missing trusted family reference identity",
    );
    assert.ok(
      typeof record.kind === "string" && typeof record.file === "string" && record.file,
      "Invalid trusted family reference",
    );
    assert.ok(
      Number.isSafeInteger(record.count) && record.count > 0,
      "Invalid trusted family reference count",
    );
    if (record.kind === "owner" || record.kind === "conditional")
      assert.ok(
        typeof record.scope === "string" &&
          Array.isArray(record.tokens) &&
          record.tokens.length &&
          record.tokens.every((token) => typeof token === "string" && token.length) &&
          (record.kind === "conditional"
            ? conditionalIdentity(record)
            : headerLength(record) !== undefined),
        "Invalid trusted family reference declarator or conditional directives",
      );
    const { masks: _masks, occurrences: _occurrences, ...reference } = record;
    byId.set(record.id, reference);
  }
  for (const { masks: _masks, occurrences: _occurrences, ...record } of records)
    assert.deepEqual(
      record,
      byId.get(record.id),
      "Family references do not cover the exact projection",
    );
  return references;
}

function matches(actual, expected, masks, limit = expected.length) {
  return (
    actual.length >= limit &&
    expected.length >= limit &&
    actual
      .slice(0, limit)
      .every((token, index) => (masks.has(index) ? identifier(token) : token === expected[index]))
  );
}

function headerLength(record) {
  if (record.kind !== "owner" || typeof record.selector !== "string") return;
  let text = "";
  for (let index = 0; index < record.tokens.length; index++) {
    text += record.tokens[index];
    if (text === record.selector) return index + 1;
    if (text.length > record.selector.length) return;
  }
}

function sameFamily(candidate, entry, header) {
  if (entry.record.kind === "conditional")
    return (
      candidate.kind === "conditional" &&
      candidate.scope === entry.record.scope &&
      JSON.stringify(candidate.directives) === JSON.stringify(entry.record.directives)
    );
  return (
    candidate.kind === "owner" &&
    candidate.scope === entry.record.scope &&
    headerLength(candidate) === header &&
    candidate.tokens[header] === entry.record.tokens[header] &&
    matches(candidate.tokens, entry.record.tokens, entry.masks, header)
  );
}

function occurrenceStatus(entry, actualRecords, tree, cache, input) {
  const { file, occurrences } = entry.occurrence;
  const name = entry.record.file;
  if (!cache.has(name)) {
    const source = tree[name];
    const tokens = typeof source === "string" ? atomicFileTokens(source) : [];
    const directives = typeof source === "string" ? atomicFileDirectives(source) : [];
    cache.set(name, { tokens, directives });
  }
  const view = cache.get(name);
  const { tokens } = view;
  const claims = [];
  if (
    tokens.length !== file.tokens.length ||
    JSON.stringify(view.directives) !== JSON.stringify(file.directives) ||
    !tokens.every((token, index) =>
      file.slots.has(index) ? identifier(token) : token === file.tokens[index],
    )
  )
    return { status: "unobservable", reason: "occurrence-file", claims };
  if (!view.owners) {
    try {
      view.owners = atomicFileOwners({ [name]: tree[name] });
    } catch {
      return { status: "unobservable", reason: "occurrence-boundary", claims };
    }
  }
  const outcome = { status: "pass", claims };
  for (const occurrence of occurrences) {
    const actual = tokens.slice(
      occurrence.tokenStart,
      occurrence.tokenStart + entry.record.tokens.length,
    );
    const located = view.owners.filter(
      (owner) =>
        owner.tokenStart === occurrence.tokenStart &&
        owner.tokenLength === entry.record.tokens.length &&
        context(owner.record) === entry.context &&
        JSON.stringify(owner.record.tokens) === JSON.stringify(actual),
    );
    const found =
      located.length === 1
        ? actualRecords.find((candidate) => candidate.id === located[0].record.id)
        : undefined;
    if (!found) {
      Object.assign(outcome, { status: "unobservable", reason: "occurrence-boundary" });
      continue;
    }
    claims.push({
      record: found,
      key: JSON.stringify([name, occurrence.tokenStart, entry.record.tokens.length]),
    });
    if (!matches(actual, entry.record.tokens, occurrence.masks)) {
      Object.assign(outcome, { status: "unobservable", reason: "occurrence-owner" });
      continue;
    }
    if (
      outcome.status !== "unobservable" &&
      !input &&
      [...occurrence.masks.values()].some(
        (mask) => mask.role === "current" && actual[mask.index] !== mask.to,
      )
    )
      outcome.status = "fail";
  }
  return outcome;
}
/** Evaluate a controller-only projection of one compiler-certified binding.
 * Supply full coherent `kind: "owner"` or `kind: "conditional"` records with zero-based indexes
 * into their exact token arrays. Current masks describe the required rename;
 * peer masks reserve only compiler-certified peer identifier positions. records
 * must enumerate all physical owners/conditional variants of the selected binding.
 * Optional familyRecords is the complete controller-owned coherent frontier's
 * obligations. It supplies global declarator multiplicity, including unrelated
 * file-local bindings with identical signatures in other translation units. It
 * must contain each projected record exactly, without altering its tokens/count.
 * Omit it only when records already enumerate the complete affected families.
 * Family references never mask or waive the selected records' physical checks.
 * Opaque conditional records require their exact directives and no selector.
 * Sparse slots can remain independent inside one such container: all unmasked
 * syntax, inactive branches, macros, conditions and directives still stay exact.
 * Conditional-family counts use scope plus directives, including all legitimate
 * blocks in familyRecords, so an added corrupted-body copy cannot disappear.
 * Preparation must still reject layouts whose lexical inventories disagree;
 * this API does not reclassify unsupported source or fall back to whole files.
 * No candidate-derived expected tokens, plans or gates may enter worker mounts.
 *
 * Current identifiers must equal `to`; peer identifiers may be old, new or wrong
 * without falsely failing this binding. Unmasked syntax and physical context stay
 * exact. Missing/ambiguous/corrupt observations are unobservable, not attributed
 * current-edit failures. Active writers defer both failures and uncertainty.
 * With `input: true`, current slots also accept any identifier, allowing a partial
 * failed rename to receive a repair without requiring its old spelling. Trusted
 * input records may retain `from`, so ready atoms can share one unchanged expected
 * frontier; output records still require `to`. Input success is not completion or
 * credit. The controller must own repair eligibility and verified prerequisites;
 * never mask predecessor positions as peer work.
 * Protected tokens, context, owner identity and multiplicity remain mandatory.
 * Uniform physical copies may appear as several inventory records while peer
 * identifiers differ. Their counts must sum to the exact expected record count;
 * every variant must satisfy every current mask. Each matching actual identity
 * is reserved, so intersecting projections become unobservable on both sides.
 * Nonuniform copies may carry occurrences with exact current-frontier file token
 * starts and separate masks. Their count must equal the authoritative record count.
 * occurrenceFiles supplies private ordered file tokens and certified identifier
 * slots. Raw trimmed logical directives are mandatory and remain exact, including
 * preprocessing-sensitive internal whitespace. Every non-slot token and token
 * count must match before those coordinates
 * can identify candidate copies. Whitespace may change; unexplained relocation or
 * order changes reject rather than borrowing baseline offsets. Per-copy current
 * masks and exact inventory-count reconciliation prevent wrong-copy completion.
 * Distinct expected records may claim distinct physical copies of one actual
 * aggregate. Across all occurrence entries, each real copy must be claimed once
 * and their total must equal that actual record's complete count. Aggregate-mask
 * entries still reserve whole actual identities and cannot overlap these claims.
 * observedIds includes an occurrence identity only after its full count is covered.
 * Outer masks are the peer-only union used for family matching, not completion.
 * Occurrence witnesses must come from trusted current replay, never a candidate.
 * With `physicalOnly: true`, all masks must be peer masks and at least one
 * must exist. This checks a structural owner's physical/context preservation
 * without granting any rename completion. It cannot be combined with input mode.
 * observedIds lists only actual record identities matched by the supplied masks;
 * callers may exclude those exact records from duplicate lexical comparisons,
 * never an entire family. Non-pass results must still prevent acceptance.
 * Optional readInventory is a controller-owned exact-source lexical reader. It
 * may reuse immutable records, never expected answers or earlier gate decisions.
 * This lexical projection is not semantic compilation or global preservation:
 * the controller must stabilize observations, block successors on non-pass, and
 * retain the drained full barriers and their whole-project checks.
 */
export function evaluateAtomicBindingGate(
  tree,
  { records, familyRecords, occurrenceFiles },
  {
    input = false,
    activeWrites = false,
    physicalOnly = false,
    readInventory = prepareCoherentContract,
  } = {},
) {
  assert.ok(!(physicalOnly && input), "Physical-only projection is not an input gate");
  const files = validateOccurrenceFiles(occurrenceFiles);
  const entries = validate(records, physicalOnly, files, input);
  const references = trustedFamilies(records, familyRecords);
  let actual;
  try {
    actual = readInventory(tree).obligations;
  } catch (error) {
    return {
      status: activeWrites ? "pending" : "unobservable",
      passed: 0,
      total: entries.length,
      records: [],
      observedIds: [],
      reason: "source",
      message: error.message,
    };
  }
  const used = new Map();
  const physical = new Map();
  const fileTokens = new Map();
  function reserve(record, outcome, key) {
    let claims = used.get(record.id);
    if (!claims) {
      claims = { record, aggregates: new Set(), occurrences: [] };
      used.set(record.id, claims);
    }
    if (key === undefined) claims.aggregates.add(outcome);
    else {
      claims.occurrences.push({ key, outcome });
      const observers = physical.get(key) ?? [];
      observers.push(outcome);
      physical.set(key, observers);
    }
  }
  const outcomes = entries.map((entry) => {
    if (entry.occurrence) {
      const { claims, ...result } = occurrenceStatus(entry, actual, tree, fileTokens, input);
      const outcome = { id: entry.record.id, ...result };
      for (const claim of claims) reserve(claim.record, outcome, claim.key);
      return outcome;
    }
    const candidates = actual.filter(
      (record) =>
        context(record) === entry.context &&
        record.tokens.length === entry.record.tokens.length &&
        matches(record.tokens, entry.record.tokens, entry.masks),
    );
    const count = candidates.reduce((sum, record) => sum + record.count, 0);
    const outcome =
      !candidates.length || count !== entry.record.count
        ? { id: entry.record.id, status: "unobservable", reason: "owner-or-count" }
        : {
            id: entry.record.id,
            status:
              input ||
              candidates.every((record) =>
                [...entry.masks.values()].every(
                  (mask) => mask.role !== "current" || record.tokens[mask.index] === mask.to,
                ),
              )
                ? "pass"
                : "fail",
          };
    for (const found of candidates) reserve(found, outcome);
    return outcome;
  });
  const invalidate = (claims, reason) => {
    for (const outcome of claims)
      if (outcome.reason !== "ambiguous-owner")
        Object.assign(outcome, { status: "unobservable", reason });
  };
  for (const claims of physical.values())
    if (claims.length > 1) invalidate(claims, "ambiguous-owner");
  const observedIds = [];
  for (const [id, claims] of used) {
    const { record, aggregates, occurrences } = claims;
    if (aggregates.size) {
      observedIds.push(id);
      if (aggregates.size > 1 || occurrences.length)
        invalidate(
          [...aggregates, ...occurrences.map((claim) => claim.outcome)],
          "ambiguous-owner",
        );
    } else {
      const count = new Set(occurrences.map((claim) => claim.key)).size;
      if (count !== record.count || count !== occurrences.length)
        invalidate(
          occurrences.map((claim) => claim.outcome),
          "occurrence-count",
        );
      else observedIds.push(id);
    }
  }
  for (const [index, entry] of entries.entries()) {
    const header = headerLength(entry.record);
    // Opaque containers have no selector/header; their scope and complete
    // directive sequence identify the family independently of body spelling.
    // A retained definition cannot disappear merely because it moved to another
    // file or its body was corrupted. Count matching declarators and definition
    // boundaries globally; expected records enumerate legitimate copies.
    const expectedCount = references
      .filter((candidate) => sameFamily(candidate, entry, header))
      .reduce((sum, candidate) => sum + candidate.count, 0);
    const actualCount = actual
      .filter((candidate) => sameFamily(candidate, entry, header))
      .reduce((sum, candidate) => sum + candidate.count, 0);
    if (actualCount !== expectedCount && outcomes[index].reason !== "ambiguous-owner")
      Object.assign(outcomes[index], {
        status: "unobservable",
        reason: `${entry.record.kind}-family-count`,
      });
  }
  const passed = outcomes.filter((item) => item.status === "pass").length;
  const status = outcomes.some((item) => item.status === "unobservable")
    ? "unobservable"
    : passed === outcomes.length
      ? "pass"
      : "fail";
  return {
    status: activeWrites && status !== "pass" ? "pending" : status,
    passed,
    total: outcomes.length,
    records: outcomes,
    observedIds,
  };
}
