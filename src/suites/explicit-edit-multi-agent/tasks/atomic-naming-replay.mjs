import { createHash } from "node:crypto";
import { prepareCoherentContract } from "../grading/coherent-grade.mjs";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

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

const ownerIndexes = new WeakMap();
const ownerKey = (file, scope, kind, conditions, tokens) =>
  JSON.stringify([file, scope, kind, conditions, tokens]);
function ownerRecord(contract, unit, tokens) {
  let index = ownerIndexes.get(contract);
  if (!index) {
    index = new Map();
    for (const record of contract.obligations) {
      const key = ownerKey(
        record.file,
        record.scope,
        record.kind,
        record.conditions,
        record.tokens,
      );
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(record);
    }
    ownerIndexes.set(contract, index);
  }
  const matches =
    index.get(
      ownerKey(unit.file, unit.scope, contractKind(unit), contractConditions(unit), tokens),
    ) ?? [];
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

/** Replay a trusted selected subset against unmodified group-start declarations.
 * Only preparation supplies these baselines and compiler-certified slots. The
 * result contains expected source, never candidate observations or gate credit.
 */
export function applyAtomicNamingBatch(tree, batch, selectedIDs) {
  return replayAtomicNamingBatch(tree, batch, selectedIDs);
}

const ownerLookupKey = (scope, kind, opaque, tokens) =>
  JSON.stringify([scope, kind, opaque, tokens]);

function replayAtomicNamingBatch(tree, batch, selectedIDs) {
  if (batch.version !== BATCH_VERSION || !Array.isArray(batch.ids) || !batch.owners.length)
    throw Error("Unsupported naming batch");
  if (!selectedIDs || typeof selectedIDs[Symbol.iterator] !== "function")
    throw Error("Missing naming batch selection");
  const selected = new Set(selectedIDs);
  const known = new Set(batch.ids);
  for (const id of selected) if (!known.has(id)) throw Error("Unknown selected naming binding ID");
  const current = Object.entries(tree).flatMap(([file, source]) =>
    owners(file, source).map((unit) => ({
      ...unit,
      contractTokens: contractTokens(source.slice(unit.start, unit.end)),
    })),
  );
  const byKey = new Map();
  for (const unit of current) {
    const key = ownerLookupKey(unit.scope, unit.kind, unit.opaque, texts(unit.contractTokens));
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(unit);
  }
  const unitIDs = new Map(current.map((unit, index) => [unit, index]));
  const locations = new Map();
  const uniformFamilies = new Map();
  for (const frame of batch.owners) {
    if (batchFingerprint(frame) !== frame.fingerprint)
      throw Error("Corrupt naming batch owner fingerprint");
    // Match complete trusted declarations; partial or ambiguous origins cannot
    // supply expected source for a barrier.
    let matches =
      byKey.get(ownerLookupKey(frame.scope, frame.syntaxKind, frame.opaque, frame.tokens)) ?? [];
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
  const repairScopes = new Map();
  const used = new Set();
  for (const frame of batch.owners) {
    const unit = locations.get(frame);
    if (used.has(unit)) throw Error("Repeated naming batch owner");
    used.add(unit);
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
    }
    let afterText = tree[unit.file].slice(unit.start, unit.end);
    for (const site of frame.sites
      .filter((item) => selected.has(item.nodeId))
      .sort((a, b) => b.index - a.index)) {
      const token = unit.contractTokens[site.index];
      afterText = afterText.slice(0, token.start) + site.to + afterText.slice(token.end);
    }
    const descriptors = [
      { file: unit.file, scope: unit.scope, selector: unitDeclarator(tree[unit.file], unit) },
      {
        file: unit.file,
        scope: unit.scope,
        selector: unitDeclarator(afterText, { start: 0, end: afterText.length, kind: unit.kind }),
      },
    ];
    for (const site of frame.sites) {
      if (!repairScopes.has(site.nodeId)) repairScopes.set(site.nodeId, []);
      repairScopes.get(site.nodeId).push(...descriptors);
    }
  }
  const result = { ...tree };
  for (const [file, list] of edits)
    for (const edit of list.sort((left, right) => right.start - left.start))
      result[file] = result[file].slice(0, edit.start) + edit.text + result[file].slice(edit.end);
  return { tree: result, repairScopes };
}
