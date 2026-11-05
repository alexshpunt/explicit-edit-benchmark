import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalizeCpp, projectMacros } from "../grading/canonical-snapshot.mjs";
import { sortedExtractionCpp } from "./sorted-structure.mjs";
import { prepareExtractionStructure } from "./structure.mjs";
import { treeIdentity } from "../generation/generator.mjs";

const nodeKey = (node) => JSON.stringify([node.type, node.key]);
const nodeIdentity = (node) => (node.identity ? JSON.stringify([node.type, node.identity]) : null);
const signature = (nodes) => JSON.stringify(nodes.map(nodeKey));
const groupId = (key) => createHash("sha256").update(key).digest("hex");
const unavailable = (message) =>
  Object.assign(new Error(message), { code: "FRAGMENT_ATTRIBUTION_UNAVAILABLE" });

function text(value) {
  if (typeof value === "string" && value.isWellFormed()) return value;
  if (Buffer.isBuffer(value)) {
    const result = value.toString("utf8");
    if (Buffer.from(result).equals(value)) return result;
  }
  throw unavailable("Fragment source is not valid UTF-8");
}
async function nodes(source, macros) {
  const projection = (await canonicalizeCpp(source, { macros, projection: true })).projection;
  if (!projection || projection.type !== "translation_unit")
    throw unavailable("Missing C++ projection");
  return projection.children;
}
function inside(nodes, start, end) {
  const result = [];
  for (const node of nodes) {
    if (node.start >= end || node.end <= start) continue;
    if (node.start < start || node.end > end)
      throw unavailable("Fragment crosses a top-level C++ unit");
    result.push(node);
  }
  if (!result.length) throw unavailable("Fragment has no top-level C++ units");
  return result;
}
function matcher(patterns) {
  const first = new Map();
  for (const pattern of patterns) {
    const start = pattern.keys[0];
    if (!first.has(start)) first.set(start, []);
    first.get(start).push(pattern);
  }
  return first;
}
// Preparation is strict about the trusted plan. Candidate scans never refuse:
// the longest pattern wins and an overlapping later match stays unexplained.
function scan(current, patterns, { strict = true } = {}) {
  const keys = current.map(nodeKey),
    result = [],
    used = new Set();
  for (let i = 0; i < keys.length; i++) {
    const matches = (patterns.get(keys[i]) ?? []).filter((p) =>
      p.keys.every((key, j) => keys[i + j] === key),
    );
    if (strict && matches.length > 1) throw unavailable("Overlapping fragment identities");
    if (!matches.length) continue;
    const match = matches.reduce((a, b) => (b.keys.length > a.keys.length ? b : a));
    const indices = match.keys.map((_, j) => i + j);
    if (indices.some((j) => used.has(j))) {
      if (strict) throw unavailable("Overlapping fragment occurrences");
      continue;
    }
    for (const j of indices) used.add(j);
    result.push({ pattern: match, indices });
  }
  return result;
}
/** Read one candidate file. Invalid text or a missing projection is ordinary
 * candidate damage: the file contributes no fragments and fails preservation. */
async function candidateNodes(value, macros) {
  if (value === undefined) return { source: "", nodes: await nodes("", macros), damaged: false };
  let source;
  try {
    source = text(value);
    return { source, nodes: await nodes(source, macros), damaged: false };
  } catch (error) {
    if (error?.code !== "FRAGMENT_ATTRIBUTION_UNAVAILABLE") throw error;
    return { source: "", nodes: await nodes("", macros), damaged: true };
  }
}
function strip(source, nodes, indices) {
  let cursor = 0,
    result = "";
  for (const i of [...indices].sort(
    (a, b) => nodes[a].start - nodes[b].start || nodes[a].end - nodes[b].end,
  )) {
    const node = nodes[i];
    if (node.start < cursor) throw unavailable("Overlapping stripped nodes");
    result += source.slice(cursor, node.start);
    cursor = node.end;
  }
  return result + source.slice(cursor);
}
function allocate(matches, limits) {
  const counts = new Map(),
    used = new Set();
  for (const match of matches) {
    const id = match.pattern.id;
    if ((counts.get(id) ?? 0) >= (limits.get(id) ?? 0)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const i of match.indices) used.add(i);
  }
  return { counts, used };
}

/** Prepare the flat, top-level-only extraction inventory. Source and target
 * occurrences with identical source structure are one fungible group. A group
 * emits numbered deficit slots and never claims which identical copy failed.
 * Assessment always returns a result for any candidate. Code that cannot be
 * attributed to a failed fragment is charged as a preservation difference.
 */
export async function prepareFragmentStructure(plan, { signal } = {}) {
  signal?.throwIfAborted();
  assert.ok(plan?.initial && plan.expected && Array.isArray(plan.tasks) && plan.tasks.length);
  const initial = text(plan.initial["main.cpp"]),
    expectedMain = text(plan.expected["main.cpp"]);
  const macros = projectMacros(Object.values(plan.expected).map(text));
  const initialNodes = await nodes(initial, macros),
    groups = new Map(),
    ids = new Set();
  const files = new Map();
  for (const task of plan.tasks) {
    signal?.throwIfAborted();
    assert.equal(typeof task.file, "string");
    assert.ok(!files.has(task.file));
    const expected = text(plan.expected[task.file]);
    assert.equal(expected, task.destination);
    const targetNodes = await nodes(expected, macros);
    let cursor = 0;
    for (const fragment of task.fragments) {
      assert.ok(typeof fragment.id === "string" && !ids.has(fragment.id));
      ids.add(fragment.id);
      assert.equal(initial.slice(fragment.start, fragment.end), fragment.text);
      const at = expected.indexOf(fragment.text, cursor);
      if (at < cursor) throw unavailable("Fragment is absent from its trusted destination");
      cursor = at + fragment.text.length;
      const sourceUnits = inside(initialNodes, fragment.start, fragment.end);
      const targetUnits = inside(targetNodes, at, cursor);
      const sourceSignature = signature(sourceUnits);
      let group = groups.get(sourceSignature);
      if (!group) {
        group = {
          id: groupId(sourceSignature),
          sourceKeys: sourceUnits.map(nodeKey),
          sourcePrimary: nodeIdentity(sourceUnits[0]),
          total: 0,
          destinations: new Map(),
        };
        groups.set(sourceSignature, group);
      }
      group.total++;
      const targetSignature = signature(targetUnits);
      const destKey = JSON.stringify([task.file, targetSignature]);
      if (!group.destinations.has(destKey))
        group.destinations.set(destKey, {
          id: groupId(JSON.stringify([group.id, task.file, targetSignature])),
          file: task.file,
          taskId: task.id,
          keys: targetUnits.map(nodeKey),
          count: 0,
          primary: nodeIdentity(targetUnits[0]),
        });
      group.destinations.get(destKey).count++;
    }
    files.set(task.file, { expected, targetNodes });
  }
  const sourcePatterns = [...groups.values()].map((g) => ({ id: g.id, keys: g.sourceKeys }));
  const sourceMatcher = matcher(sourcePatterns);
  const sourceLimits = new Map([...groups.values()].map((g) => [g.id, g.total]));
  const initialScan = scan(initialNodes, sourceMatcher);
  const initialCounts = allocate(initialScan, sourceLimits).counts;
  for (const [id, total] of sourceLimits)
    if (initialCounts.get(id) !== total)
      throw unavailable("Source fragment multiplicity is ambiguous");
  const expectedSourceNodes = await nodes(expectedMain, macros);
  if (scan(expectedSourceNodes, sourceMatcher).length)
    throw unavailable("A moved fragment already appears in expected residual source");
  const sourceIdentities = new Map();
  for (const group of groups.values()) {
    if (!group.sourcePrimary) continue;
    if (!sourceIdentities.has(group.sourcePrimary))
      sourceIdentities.set(group.sourcePrimary, new Set());
    sourceIdentities.get(group.sourcePrimary).add(group);
  }
  const residualIdentities = new Set(expectedSourceNodes.map(nodeIdentity).filter(Boolean));
  for (const [file, info] of files) {
    signal?.throwIfAborted();
    const patterns = new Map(),
      limits = new Map(),
      identities = new Map();
    for (const group of groups.values())
      for (const destination of group.destinations.values()) {
        if (destination.file !== file) continue;
        const id = destination.id;
        const key = JSON.stringify(destination.keys);
        const existing = patterns.get(key);
        if (existing && existing.group !== group.id)
          throw unavailable("Target copies have ambiguous source groups");
        patterns.set(key, {
          id,
          group: group.id,
          keys: destination.keys,
          primary: destination.primary,
        });
        limits.set(id, (limits.get(id) ?? 0) + destination.count);
      }
    for (const pattern of patterns.values()) {
      if (!pattern.primary) continue;
      if (!identities.has(pattern.primary)) identities.set(pattern.primary, new Set());
      identities.get(pattern.primary).add(pattern.id);
    }
    info.patterns = matcher([...patterns.values()]);
    info.limits = limits;
    info.identities = identities;
    info.patternById = new Map([...patterns.values()].map((p) => [p.id, p]));
    const expectedScan = scan(info.targetNodes, info.patterns);
    const allocated = allocate(expectedScan, limits);
    for (const [id, count] of limits)
      if (allocated.counts.get(id) !== count)
        throw unavailable("Target fragment multiplicity is ambiguous");
    if (expectedScan.length !== [...limits.values()].reduce((sum, n) => sum + n, 0))
      throw unavailable("Target has indistinguishable unrelated copies");
    info.residualSource = strip(info.expected, info.targetNodes, allocated.used);
    info.residual = await sortedExtractionCpp(info.residualSource, { macros });
  }
  const planIdentity = createHash("sha256")
    .update(
      JSON.stringify({
        initial: treeIdentity(plan.initial),
        expected: treeIdentity(plan.expected),
        tasks: plan.tasks.map(({ id, file, fragments }) => ({
          id,
          file,
          fragments: fragments.map(({ id, start, end }) => ({ id, start, end })),
        })),
      }),
    )
    .digest("hex");
  const legacy = await prepareExtractionStructure(plan, { sorted: true });
  signal?.throwIfAborted();
  const expectedResidual = await sortedExtractionCpp(expectedMain, { macros });
  return async function assess(tree, { signal } = {}) {
    signal?.throwIfAborted();
    assert.ok(tree && typeof tree === "object");
    const sourceFile = await candidateNodes(tree["main.cpp"], macros),
      source = sourceFile.source,
      sourceNodes = sourceFile.nodes;
    const sourceMatches = scan(sourceNodes, sourceMatcher, { strict: false });
    const sourceFound = allocate(sourceMatches, sourceLimits);
    for (let i = 0; i < sourceNodes.length; i++) {
      if (sourceFound.used.has(i)) continue;
      const identity = nodeIdentity(sourceNodes[i]);
      const choices = sourceIdentities.get(identity);
      if (!identity || !choices?.size) continue;
      // An ambiguous changed unit stays in the residual and fails preservation.
      if (choices.size !== 1 || residualIdentities.has(identity)) continue;
      const [group] = choices;
      if ((sourceFound.counts.get(group.id) ?? 0) >= group.total) continue;
      const suffix = group.sourceKeys.slice(1);
      if (
        !suffix.every(
          (key, j) =>
            sourceNodes[i + j + 1] &&
            nodeKey(sourceNodes[i + j + 1]) === key &&
            !sourceFound.used.has(i + j + 1),
        )
      )
        continue;
      sourceFound.counts.set(group.id, (sourceFound.counts.get(group.id) ?? 0) + 1);
      for (let j = i; j < i + group.sourceKeys.length; j++) sourceFound.used.add(j);
    }
    const targetFound = new Map(),
      preservation = new Set();
    const legacyResult = await legacy(tree);
    signal?.throwIfAborted();
    for (const id of legacyResult.differenceIds)
      if (!plan.tasks.some((task) => task.id === id) && id !== "preservation:main.cpp")
        preservation.add(id);
    const remainingSource = strip(source, sourceNodes, sourceFound.used);
    const residualSource = await sortedExtractionCpp(remainingSource, { macros });
    if (sourceFile.damaged || residualSource !== expectedResidual)
      preservation.add("preservation:main.cpp");
    for (const [file, info] of files) {
      signal?.throwIfAborted();
      const target = await candidateNodes(tree[file], macros),
        current = target.source,
        currentNodes = target.nodes;
      const found = allocate(scan(currentNodes, info.patterns, { strict: false }), info.limits);
      for (const [id, n] of found.counts) targetFound.set(id, (targetFound.get(id) ?? 0) + n);
      // Attribute changed complete units only when their public syntax identity
      // names one expected group and its exact form is missing.
      for (let i = 0; i < currentNodes.length; i++) {
        if (found.used.has(i)) continue;
        const identity = nodeIdentity(currentNodes[i]);
        const choices = info.identities.get(identity);
        if (!identity || choices?.size !== 1) continue;
        const [id] = choices,
          pattern = info.patternById.get(id);
        if ((found.counts.get(id) ?? 0) >= info.limits.get(id)) continue;
        const suffix = pattern.keys.slice(1);
        if (
          !suffix.every(
            (key, j) =>
              currentNodes[i + j + 1] &&
              nodeKey(currentNodes[i + j + 1]) === key &&
              !found.used.has(i + j + 1),
          )
        )
          continue;
        found.counts.set(id, (found.counts.get(id) ?? 0) + 1);
        for (let j = i; j < i + pattern.keys.length; j++) found.used.add(j);
      }
      if (target.damaged) {
        preservation.add(`preservation:${file}`);
        continue;
      }
      const remaining = strip(current, currentNodes, found.used);
      const residual = await sortedExtractionCpp(remaining, { macros });
      if (residual === info.residual) continue;
      // Changed units of a missing fragment's kind, up to that kind's deficit,
      // are the damaged copies of fragments that already fail. Anything else,
      // including lost unrelated code, is a separate preservation difference.
      const deficits = new Map();
      for (const [id, count] of info.limits) {
        const missing = count - (found.counts.get(id) ?? 0);
        if (missing <= 0) continue;
        const type = JSON.parse(info.patternById.get(id).keys[0])[0];
        deficits.set(type, (deficits.get(type) ?? 0) + missing);
      }
      const known = new Map();
      for (const node of await nodes(info.residualSource, macros))
        known.set(nodeKey(node), (known.get(nodeKey(node)) ?? 0) + 1);
      let explained = true,
        attributed = 0;
      for (const node of await nodes(remaining, macros)) {
        const key = nodeKey(node),
          count = known.get(key) ?? 0;
        if (count) known.set(key, count - 1);
        else if ((deficits.get(node.type) ?? 0) > 0) {
          deficits.set(node.type, deficits.get(node.type) - 1);
          attributed++;
        } else explained = false;
      }
      if (!explained || !attributed || [...known.values()].some((count) => count > 0))
        preservation.add(`preservation:${file}`);
    }
    const differences = [],
      failures = [];
    let failed = 0;
    for (const group of groups.values()) {
      const retained = sourceFound.counts.get(group.id) ?? 0;
      const destinations = [...group.destinations.values()];
      const missing = destinations.map(
        (destination) => destination.count - (targetFound.get(destination.id) ?? 0),
      );
      // Identical copies are fungible. The group fails max(retained, missing)
      // copies; source copies beyond the target deficits are assigned to the
      // destinations in plan order, which leaves the count independent of order.
      let extra = Math.max(0, retained - missing.reduce((sum, count) => sum + count, 0));
      for (let index = 0; index < destinations.length; index++) {
        const destination = destinations[index];
        const take = Math.min(extra, destination.count - missing[index]);
        extra -= take;
        const count = missing[index] + take;
        failed += count;
        for (let i = 1; i <= count; i++) {
          const id = `fragment:${destination.id}:${i}`;
          differences.push(id);
          failures.push({ id, taskId: destination.taskId, file: destination.file });
        }
      }
    }
    signal?.throwIfAborted();
    // A whole-file failure that the fragment view does not localize still counts.
    if (legacyResult.status !== "pass" && !differences.length && !preservation.size)
      for (const id of legacyResult.differenceIds) {
        const task = plan.tasks.find((item) => item.id === id);
        preservation.add(task ? `preservation:${task.file}` : id);
      }
    const preservationIds = [...preservation].sort();
    const differenceIds = [...differences, ...preservationIds].sort();
    // Repair targets are never empty while a difference remains: failed fragments
    // name their tasks, and preservation-only failures fall back to their own IDs.
    const repairs = new Set([
      ...legacyResult.differenceIds,
      ...failures.map((failure) => failure.taskId),
    ]);
    if (!repairs.size) for (const id of preservationIds) repairs.add(id);
    const fileDifferenceIds = [...repairs].sort();
    return {
      version: "renderer-fragment-structure-v1",
      planIdentity,
      status: differenceIds.length ? "fail" : "pass",
      totalFragments: ids.size,
      failedFragments: failed,
      differenceIds,
      preservationIds,
      failures,
      files: legacyResult.files,
      fileDifferenceIds,
      diagnostics: legacyResult.diagnostics,
    };
  };
}
