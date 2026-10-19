import { createHash } from "node:crypto";
import { prepareCoherentContract } from "./coherent-grade.mjs";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "../generation/generator.mjs";

const identifier = (text) => /^[A-Za-z_]\w*$/.test(text);

// Keep protected literals/comments and meaningful token boundaries, not layout.
function lexicalTokens(source) {
  const result = [];
  const gap = (text, offset) => {
    const pattern =
      /(?:0[xX][\da-fA-F']+(?:\.[\da-fA-F']*)?(?:[pP][+-]?[\d']+)?|(?:[\d']+(?:\.[\d']*)?|\.[\d']+)(?:[eE][+-]?[\d']+)?)[A-Za-z_0-9]*|[A-Za-z_]\w*|->\*|<<=|>>=|\.\.\.|::|->|\.\*|\+\+|--|&&|\|\||==|!=|<=|>=|<<|>>|[+*/%&|^-]=|[^\s]/g;
    for (const match of text.matchAll(pattern))
      result.push({
        text: match[0],
        start: offset + match.index,
        end: offset + match.index + match[0].length,
      });
  };
  let cursor = 0;
  for (const token of cppTokens(source).filter((item) => !identifier(item.text))) {
    gap(source.slice(cursor, token.start), cursor);
    result.push(token);
    cursor = token.end;
  }
  gap(source.slice(cursor), cursor);
  return result;
}

function logicalDirectives(source) {
  const protectedTokens = cppTokens(source).filter((token) => !identifier(token.text));
  return [...source.matchAll(/^[ \t]*#(?:[^\n\\]|\\[^\r\n]|\\\r?\n)*(?:\n|$)/gm)].filter(
    (match) =>
      !protectedTokens.some((token) => token.start <= match.index && match.index < token.end),
  );
}

function branches(source) {
  const result = [];
  let depth = 0,
    start = 0,
    condition;
  for (const directive of logicalDirectives(source)) {
    const kind = /^\s*#\s*(\w+)/.exec(directive[0])?.[1];
    if (["if", "ifdef", "ifndef"].includes(kind)) {
      if (!depth) {
        condition = lexicalTokens(directive[0]).map((item) => item.text);
        start = directive.index + directive[0].length;
      }
      depth++;
    } else if (kind === "endif") {
      depth--;
      if (!depth) result.push({ condition, start, source: source.slice(start, directive.index) });
    } else if (["else", "elif"].includes(kind) && depth === 1) {
      result.push({ condition, start, source: source.slice(start, directive.index) });
      condition = lexicalTokens(directive[0]).map((item) => item.text);
      start = directive.index + directive[0].length;
    }
  }
  if (depth || !result.length) throw Error("Incomplete naming frontier conditional");
  return result;
}

// Peel complete namespace-level branches. A declaration split across branches
// stays one explicit opaque conditional, never a whole-file fallback.
function owners(file, source) {
  function visit(text, offset = 0, inheritedScope = "", conditions = []) {
    const result = [];
    for (const unit of cppStructure(text).units) {
      const scope = [inheritedScope, unit.scope].filter(Boolean).join("::");
      const body = text.slice(unit.start, unit.end);
      const start = offset + unit.start;
      if (unit.kind === "conditional") {
        try {
          const children = branches(body).flatMap((part) =>
            visit(part.source, start + part.start, scope, [...conditions, part.condition]),
          );
          result.push(...children);
          continue;
        } catch {
          // The parent unit is the smallest supported coupled physical owner.
        }
      } else if (!/[};]\s*$/.test(body)) {
        throw Error("Incomplete namespace-level naming owner");
      }
      result.push({
        file,
        start,
        end: offset + unit.end,
        scope,
        kind: unit.kind,
        opaque: unit.kind === "conditional",
        conditions,
        selector: unitDeclarator(text, unit),
        tokens: lexicalTokens(body),
      });
    }
    return result;
  }
  return visit(source).sort((left, right) => left.start - right.start);
}

function texts(tokens) {
  return tokens.map((token) => token.text);
}
function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
const BATCH_VERSION = "private-atomic-naming-batch-v1";

// Use the cumulative grader's exact token indexing. The stricter lexer above
// still validates that a compiler site is a complete real identifier token.
function contractTokens(source) {
  const result = [];
  const gap = (text, offset) => {
    const pattern =
      /(?:\d+(?:\.\d*)?(?:[eEpP][+-]?\d+)?[\w]*)|(?:->\*|<<=|>>=|\.\.\.|::|->|\.\*|\+\+|--|&&|\|\||==|!=|<=|>=|<<|>>|[+*/%&|^-]=)|[^\s]/g;
    for (const match of text.matchAll(pattern))
      result.push({
        text: match[0],
        start: offset + match.index,
        end: offset + match.index + match[0].length,
      });
  };
  let cursor = 0;
  for (const token of cppTokens(source)) {
    gap(source.slice(cursor, token.start), cursor);
    result.push(token);
    cursor = token.end;
  }
  gap(source.slice(cursor), cursor);
  return result;
}
function contractKind(unit) {
  return unit.kind === "declaration" ? "owner" : unit.kind;
}
function contractConditions(unit) {
  return unit.conditions.map((condition) => texts(contractTokens(condition.join(" "))));
}
function batchFingerprint(frame) {
  return createHash("sha256")
    .update(JSON.stringify([frame.scope, frame.kind, frame.opaque, frame.tokens]))
    .digest("hex");
}

const slotPlan = (sites) =>
  sites
    .map((site) => [site.nodeId, site.index, site.from, site.to])
    .sort((left, right) => left[1] - right[1]);

function ownerRecord(contract, unit, tokens) {
  const matches = contract.obligations.filter(
    (record) =>
      record.file === unit.file &&
      record.scope === unit.scope &&
      record.kind === contractKind(unit) &&
      same(record.conditions, contractConditions(unit)) &&
      same(record.tokens, tokens),
  );
  if (matches.length !== 1) throw Error("Unsupported naming batch owner inventory alignment");
  return matches[0];
}

/** Seal non-overlapping binding slots against one trusted coarse-group baseline.
 * Every compiler plan uses that same tree's physical offsets, never an earlier
 * sibling's edited tree. Sites must be complete identifiers with one old/new pair
 * per binding. Physical overlaps, partial tokens and preprocessor edits reject.
 * Sharing a namespace-level owner does not impose a dependency between bindings.
 * Frames, fingerprints and slots are private expected answers, never worker input.
 * Compiler certification owns binding identity, use coverage and rename safety.
 */
export function prepareAtomicNamingBatch(beforeTree, bindings) {
  if (!Array.isArray(bindings) || !bindings.length) throw Error("Missing naming batch bindings");
  const ids = new Set();
  const edits = new Map();
  for (const binding of bindings) {
    if (typeof binding.id !== "string" || !binding.id || ids.has(binding.id))
      throw Error("Missing or repeated naming binding ID");
    ids.add(binding.id);
    if (!Array.isArray(binding.plan?.edits) || !binding.plan.edits.length)
      throw Error("Missing naming binding edits");
    let rename;
    for (const edit of binding.plan.edits) {
      const source = beforeTree[edit.file];
      if (
        typeof source !== "string" ||
        !Number.isSafeInteger(edit.start) ||
        edit.start < 0 ||
        typeof edit.old !== "string" ||
        typeof edit.new !== "string" ||
        !identifier(edit.old) ||
        !identifier(edit.new) ||
        edit.old === edit.new
      )
        throw Error("Invalid naming binding token edit");
      if (source.slice(edit.start, edit.start + edit.old.length) !== edit.old)
        throw Error("Stale naming binding token edit");
      if (rename && (rename.from !== edit.old || rename.to !== edit.new))
        throw Error("Naming binding contains unrelated substitutions");
      rename = { from: edit.old, to: edit.new };
      const list = edits.get(edit.file) ?? [];
      list.push({ ...edit, nodeId: binding.id });
      edits.set(edit.file, list);
    }
  }
  for (const list of edits.values()) {
    list.sort((left, right) => left.start - right.start);
    for (let index = 1; index < list.length; index++)
      if (list[index - 1].start + list[index - 1].old.length > list[index].start)
        throw Error("Overlapping naming binding edits");
  }
  const contract = prepareCoherentContract(beforeTree);
  const frames = [];
  for (const file of [...edits.keys()].sort()) {
    const source = beforeTree[file];
    const units = owners(file, source);
    const directives = logicalDirectives(source);
    const byUnit = new Map();
    for (const edit of edits.get(file)) {
      if (
        directives.some(
          (directive) =>
            directive.index <= edit.start && edit.start < directive.index + directive[0].length,
        )
      )
        throw Error("Naming binding changes preprocessor context");
      const unit = units.find(
        (item) => item.start <= edit.start && edit.start + edit.old.length <= item.end,
      );
      if (!unit) throw Error("Missing namespace-level naming binding owner");
      if (
        !unit.tokens.some(
          (token) =>
            unit.start + token.start === edit.start &&
            token.text === edit.old &&
            token.end - token.start === edit.old.length,
        )
      )
        throw Error("Partial or protected naming binding token");
      if (!byUnit.has(unit)) {
        const tokens = contractTokens(source.slice(unit.start, unit.end));
        const stream = texts(tokens);
        const record = ownerRecord(contract, unit, stream);
        const frame = {
          originFile: file,
          originConditions: unit.conditions,
          scope: unit.scope,
          kind: record.kind,
          syntaxKind: unit.kind,
          opaque: unit.opaque,
          tokens: stream,
          sites: [],
        };
        frame.fingerprint = batchFingerprint(frame);
        byUnit.set(unit, { frame, tokens });
      }
      const entry = byUnit.get(unit);
      const index = entry.tokens.findIndex(
        (token) =>
          unit.start + token.start === edit.start &&
          token.text === edit.old &&
          token.end - token.start === edit.old.length,
      );
      if (index < 0) throw Error("Naming binding token does not align with its inventory");
      entry.frame.sites.push({ nodeId: edit.nodeId, index, from: edit.old, to: edit.new });
    }
    for (const unit of units) if (byUnit.has(unit)) frames.push(byUnit.get(unit).frame);
  }
  return { version: BATCH_VERSION, ids: [...ids], owners: frames };
}

/** Apply a selected subset simultaneously to still-unmodified group-start owners.
 * The input is structural frontier plus earlier coarse naming groups, NOT previous
 * partial application of this batch. Owner location and token offsets are rebuilt.
 * Trusted current fileHint/conditionsHint may disambiguate origins as in the ordered
 * effect API. Opaque frames remain explicit; unsupported inventory alignment fails
 * rather than promoting ordinary owners to whole-file serialization.
 * Returns relocated owner descriptors with exact final coherent-contract tokens,
 * current contexts and ALL binding slots, including unselected nodes, for masked
 * gates. Identical copies are supported only when every physical copy is covered
 * by an identical complete slot plan; extra, missing or nonuniform copies reject.
 * Uniform projections coalesce by coherent identity without changing its count.
 * This operation does not verify candidate edits or unlock dependencies.
 */
export function applyAtomicNamingBatch(tree, batch, selectedIDs) {
  return createAtomicNamingReplay(batch)(tree, selectedIDs);
}

/** Reuse at most one exact trusted input tree's lexical owner inventory.
 * Each call hashes current paths and contents, including when the same object is
 * mutated. Changed source replaces the previous inventory; no frontier history,
 * selected outputs or pass/fail results are retained. Batch validation, sparse
 * application and output contract/context reconstruction still run on every call.
 * The baseline inventory stays private, and returned frontiers cannot mutate it.
 * This is trusted expected-state replay only, never a candidate acceptance cache.
 * clear() releases the retained baseline without invalidating the replay handle.
 */
export function createAtomicNamingReplay(batch) {
  let baseline;
  function inventory(tree) {
    const identity = treeIdentity(tree);
    if (baseline?.identity !== identity) {
      baseline = undefined;
      const current = Object.entries(tree).flatMap(([file, source]) =>
        owners(file, source).map((unit) => ({
          ...unit,
          contractTokens: contractTokens(source.slice(unit.start, unit.end)),
        })),
      );
      baseline = { identity, current };
    }
    return baseline.current;
  }
  const replay = (tree, selectedIDs) =>
    replayAtomicNamingBatch(tree, batch, selectedIDs, inventory);
  replay.clear = () => {
    baseline = undefined;
  };
  return replay;
}

function replayAtomicNamingBatch(tree, batch, selectedIDs, inventory) {
  if (batch.version !== BATCH_VERSION || !Array.isArray(batch.ids) || !batch.owners.length)
    throw Error("Unsupported naming batch");
  if (!selectedIDs || typeof selectedIDs[Symbol.iterator] !== "function")
    throw Error("Missing naming batch selection");
  const selected = new Set(selectedIDs);
  const known = new Set(batch.ids);
  for (const id of selected) if (!known.has(id)) throw Error("Unknown selected naming binding ID");
  const current = inventory(tree);
  const unitIDs = new Map(current.map((unit, index) => [unit, index]));
  const locations = new Map();
  const uniformFamilies = new Map();
  for (const frame of batch.owners) {
    if (batchFingerprint(frame) !== frame.fingerprint)
      throw Error("Corrupt naming batch owner fingerprint");
    let matches = current.filter(
      (unit) =>
        unit.scope === frame.scope &&
        unit.kind === frame.syntaxKind &&
        unit.opaque === frame.opaque &&
        same(texts(unit.contractTokens), frame.tokens),
    );
    if (matches.length > 1 && frame.fileHint !== undefined)
      matches = matches.filter((unit) => unit.file === frame.fileHint);
    if (matches.length > 1 && frame.conditionsHint !== undefined)
      matches = matches.filter((unit) => same(unit.conditions, frame.conditionsHint));
    if (!matches.length) throw Error("Missing group-start naming batch owner");
    if (matches.length === 1) locations.set(frame, matches[0]);
    else {
      const key = JSON.stringify(matches.map((unit) => unitIDs.get(unit)));
      if (!uniformFamilies.has(key)) uniformFamilies.set(key, { matches, frames: [] });
      uniformFamilies.get(key).frames.push(frame);
    }
  }
  for (const { matches, frames } of uniformFamilies.values()) {
    // Every pairing has the same effect for every selected-ID subset only when
    // all physical copies are covered by the same complete binding-slot plan.
    if (
      frames.length !== matches.length ||
      frames.some((frame) => !same(slotPlan(frame.sites), slotPlan(frames[0].sites)))
    )
      throw Error("Ambiguous naming batch owner");
    for (const [index, frame] of frames.entries()) locations.set(frame, matches[index]);
  }
  const edits = new Map();
  const located = [];
  const used = new Set();
  for (const frame of batch.owners) {
    const unit = locations.get(frame);
    if (used.has(unit)) throw Error("Repeated naming batch owner");
    used.add(unit);
    const stream = [...frame.tokens];
    const indexes = new Set();
    for (const site of frame.sites) {
      if (
        !known.has(site.nodeId) ||
        !Number.isSafeInteger(site.index) ||
        indexes.has(site.index) ||
        frame.tokens[site.index] !== site.from ||
        !identifier(site.from) ||
        !identifier(site.to)
      )
        throw Error("Invalid naming batch slot");
      indexes.add(site.index);
      if (!selected.has(site.nodeId)) continue;
      const token = unit.contractTokens[site.index];
      const list = edits.get(unit.file) ?? [];
      list.push({ start: unit.start + token.start, end: unit.start + token.end, text: site.to });
      edits.set(unit.file, list);
      stream[site.index] = site.to;
    }
    located.push({ unit, stream, sites: frame.sites.map((site) => ({ ...site })) });
  }
  const result = { ...tree };
  for (const [file, list] of edits)
    for (const edit of list.sort((left, right) => right.start - left.start))
      result[file] = result[file].slice(0, edit.start) + edit.text + result[file].slice(edit.end);
  const contract = prepareCoherentContract(result);
  const projected = new Map();
  for (const { unit, stream, sites } of located) {
    const record = ownerRecord(contract, unit, stream);
    const owner = {
      file: record.file,
      scope: record.scope,
      kind: record.kind,
      opaque: unit.opaque,
      conditions: record.conditions,
      ...(record.macros !== undefined ? { macros: record.macros } : {}),
      ...(record.selector !== undefined ? { selector: record.selector } : {}),
      tokens: stream,
      sites,
    };
    const previous = projected.get(record.id);
    if (previous) {
      if (
        !same(
          { ...previous, sites: slotPlan(previous.sites) },
          { ...owner, sites: slotPlan(sites) },
        )
      )
        throw Error("Nonuniform naming batch owner projection");
      continue;
    }
    // The authoritative coherent record retains the complete physical count.
    // Uniform copies need one mask projection, not duplicate record identities.
    projected.set(record.id, owner);
  }
  return { tree: result, owners: [...projected.values()] };
}
