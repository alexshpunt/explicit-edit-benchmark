import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { projectAst } from "../cpp/compiler-ast.mjs";
import { includeBoundaries } from "../cpp/compiler-includes.mjs";
import { cppTokens, treeIdentity, writeTree } from "./generator.mjs";

const flags = ["-std=c++17", "-pthread"];
// Compiler-generated anonymous/lambda type labels carry source coordinates, not binding identity.
const typeName = (node) => (node.type?.qualType ?? "").replace(/ at [^()]+:\d+:\d+(?=\))/g, "");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const physical = (location) =>
  Number.isInteger(location?.offset) && !location.spellingLoc && !location.expansionLoc;
const endOf = (node) =>
  physical(node.range?.end) ? node.range.end.offset + node.range.end.tokLen : null;
const bodyOf = (node) => node.inner?.find((child) => child.kind === "CompoundStmt");
const walk = (node, visit) => {
  visit(node);
  for (const child of node.inner ?? []) walk(child, visit);
};

function inventory(roots, bytes, repeatedIncludes = new Set()) {
  const declarations = new Map();
  const families = new Map();
  const definitions = [];
  const barriers = [];
  const using = new Set();
  const dependentNames = new Set();
  const types = [];
  let region = 0;
  function index(
    node,
    scope = "",
    context = "",
    namespaceRegion = 0,
    templated = false,
    free = true,
  ) {
    if (!node.kind) return;
    const nextScope =
      node.kind === "NamespaceDecl" ? `${scope}::${node.name ?? "(anonymous)"}` : scope;
    const nextRegion = node.kind === "NamespaceDecl" ? ++region : namespaceRegion;
    const key = node.mangledName ?? `${context}/${node.kind}:${node.name ?? ""}:${typeName(node)}`;
    if (node.id && node.kind.endsWith("Decl"))
      declarations.set(node.id, { node, key, scope: nextScope, free });
    if (
      free &&
      node.name &&
      !node.isImplicit &&
      [
        "CXXRecordDecl",
        "RecordDecl",
        "EnumDecl",
        "TypedefDecl",
        "TypeAliasDecl",
        "ClassTemplateDecl",
      ].includes(node.kind)
    )
      types.push({ node, scope: nextScope });
    if (node.kind === "FunctionDecl") {
      const family = `${nextScope}:${node.name}`;
      const entries = families.get(family) ?? [];
      entries.push(node);
      families.set(family, entries);
      const body = bodyOf(node);
      if (body)
        definitions.push({
          node,
          body,
          scope: nextScope,
          region: nextRegion,
          templated,
          free,
          family,
          key,
          start: node.range?.begin?.offset,
          end: endOf(node),
        });
    }
    if (node.kind === "UnresolvedLookupExpr") dependentNames.add(node.name);
    const childContext = node.kind.endsWith("Decl") && node.name ? key : context;
    for (const child of node.inner ?? [])
      index(
        child,
        nextScope,
        childContext,
        nextRegion,
        templated || node.kind === "FunctionTemplateDecl",
        ["NamespaceDecl", "FunctionTemplateDecl"].includes(node.kind),
      );
  }
  for (const root of roots) index(root);
  // Only namespace-level fixed declarations are barriers, not fields or body-local types.
  function fixed(node, scope = "") {
    if (node.kind === "NamespaceDecl") {
      const next = `${scope}::${node.name ?? "(anonymous)"}`;
      for (const child of node.inner ?? []) fixed(child, next);
      return;
    }
    if (node.kind === "FunctionDecl" || node.kind === "FunctionTemplateDecl" || node.isImplicit)
      return;
    if (node.kind === "UsingShadowDecl") return;
    if (node.kind === "UsingDirectiveDecl" || node.kind === "UsingDecl") {
      const key = `${scope}:${node.kind}:${node.nominatedNamespace?.name ?? node.name}`;
      if (using.has(key)) return;
      using.add(key);
    }
    if (
      [
        "CXXRecordDecl",
        "RecordDecl",
        "EnumDecl",
        "TypedefDecl",
        "TypeAliasDecl",
        "ClassTemplateDecl",
        "VarDecl",
      ].includes(node.kind)
    )
      return;
    const end = endOf(node);
    if (end !== null) barriers.push({ scope, end });
  }
  for (const root of roots) fixed(root);
  // Keep directive order; only preprocessor-proven transparent include boundaries may be crossed.
  const text = bytes.toString("utf8");
  for (const match of text.matchAll(/^[ \t]*#.*$/gm)) {
    const start = Buffer.byteLength(text.slice(0, match.index));
    if (!repeatedIncludes.has(start))
      barriers.push({ scope: "", end: start + Buffer.byteLength(match[0]) });
  }
  return { declarations, families, definitions, barriers, dependentNames, types };
}

function references(node, data) {
  const result = [];
  walk(node, (child) => {
    if (child.kind === "DeclRefExpr" && child.referencedDecl) {
      const reference = child.referencedDecl;
      result.push({
        kind: child.kind,
        key:
          data.declarations.get(reference.id)?.key ??
          `${reference.kind}:${reference.name}:${typeName(reference)}`,
        id: reference.id,
      });
    } else if (child.kind === "MemberExpr") {
      result.push({
        kind: child.kind,
        key:
          data.declarations.get(child.referencedMemberDecl)?.key ??
          `${child.name}:${typeName(child)}`,
      });
    } else if (child.kind === "UnresolvedLookupExpr") {
      const candidates = (child.lookups ?? [])
        .map(
          (decl) =>
            data.declarations.get(decl.id)?.key ?? `${decl.kind}:${decl.name}:${typeName(decl)}`,
        )
        .sort();
      result.push({ kind: child.kind, key: `${child.name}:${JSON.stringify(candidates)}` });
    } else if (["CXXDependentScopeMemberExpr", "DependentScopeDeclRefExpr"].includes(child.kind)) {
      result.push({
        kind: child.kind,
        key: `${child.member ?? child.name}:${typeName(child)}`,
      });
    }
  });
  return result;
}

function bindings(data) {
  const result = [];
  for (const definition of data.definitions) {
    result.push([
      definition.key,
      references(definition.body, data).map(({ kind, key }) => [kind, key]),
    ]);
  }
  // Moving functions must not alter lookup inside unchanged global initializers either.
  for (const { node, key } of data.declarations.values()) {
    if (node.kind === "VarDecl" && node.mangledName)
      result.push([
        key,
        references(node, data).map(({ kind, key: reference }) => [kind, reference]),
      ]);
  }
  return result.map((entry) => JSON.stringify(entry)).sort();
}

function checkBindings(before, after, label) {
  const expected = bindings(before);
  const actual = bindings(after);
  if (hash(JSON.stringify(expected)) === hash(JSON.stringify(actual))) return;
  const actualSet = new Set(actual);
  const missing = expected.find((entry) => !actualSet.has(entry));
  const [key, referencesBefore] = JSON.parse(missing ?? expected[0]);
  const candidate = actual.map((entry) => JSON.parse(entry)).find((entry) => entry[0] === key);
  const referencesAfter = candidate?.[1] ?? [];
  const index = referencesBefore.findIndex(
    (reference, i) => JSON.stringify(reference) !== JSON.stringify(referencesAfter[i]),
  );
  throw new Error(
    `${label} changed compiler bindings: ${key}; reference ${index}: ${JSON.stringify(referencesBefore[index])} -> ${JSON.stringify(referencesAfter[index])}; entries ${expected.length} -> ${actual.length}`,
  );
}
function replaceBytes(bytes, edits) {
  const chunks = [];
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > bytes.length)
      throw new Error("Overlapping or invalid function span");
    chunks.push(bytes.subarray(cursor, edit.start), Buffer.from(edit.text));
    cursor = edit.end;
  }
  chunks.push(bytes.subarray(cursor));
  return Buffer.concat(chunks).toString("utf8");
}

function typeBound(entry, data, signatureOnly = false) {
  const names = new Set();
  const collect = (node) => {
    for (const text of [node.type?.qualType, node.type?.desugaredQualType])
      for (const word of (text ?? "").matchAll(/[A-Za-z_][A-Za-z_0-9]*/g)) names.add(word[0]);
  };
  if (signatureOnly) collect(entry.node);
  else walk(entry.node, collect);
  const visible = new Map();
  for (const { node, scope } of data.types) {
    if (scope !== entry.scope && scope !== "") continue;
    if (!names.has(node.name) || endOf(node) === null) continue;
    if (node.kind === "CXXRecordDecl" && !node.completeDefinition) continue;
    visible.set(node.name, Math.min(visible.get(node.name) ?? Infinity, endOf(node)));
  }
  return Math.max(0, ...visible.values());
}

function reasonFor(entry, data, bytes) {
  const { node, body, scope, templated, start, end } = entry;
  if (!entry.free) return "nested or friend definition";
  if (!scope || scope.includes("(anonymous)")) return "global or anonymous namespace context";
  if (templated) return "template definition";
  if ((node.inner ?? []).some((child) => child.kind?.endsWith("Attr")))
    return "attributed definition";
  if (node.inline || node.constexpr) return "inline or constexpr definition";
  if (/\bauto\b/.test(node.type?.qualType ?? "")) return "auto return type";
  if ((node.inner ?? []).some((child) => child.kind === "ParmVarDecl" && child.init))
    return "default argument on definition";
  if (!physical(node.range?.begin) || !physical(body.range?.begin) || end === null)
    return "macro or nonphysical definition";
  const signature = bytes.subarray(start, body.range.begin.offset).toString("utf8");
  if (/\bauto\b/.test(signature)) return "auto return type";
  const source = bytes.subarray(start, end).toString("utf8");
  if (/^[ \t]*#/m.test(source)) return "directive inside function body";
  const macro = (child) =>
    !!(child.range?.begin?.expansionLoc || child.range?.end?.expansionLoc) ||
    (child.inner ?? []).some(macro);
  if (macro(node)) return "macro-dependent definition";
  if (data.dependentNames.has(node.name)) return "dependent lookup family";
  if (typeBound(entry, data) > start)
    return "type completion later than definition (unsupported early incomplete-type use)";
  return null;
}

// Trace a UTF-8 position back through prior UTF-16 naming/packing records for source provenance.
function sourceOrigin(text, byte, history, region) {
  if (!history.length) return `namespace-region-${region}`;
  let position = Buffer.from(text).subarray(0, byte).toString("utf8").length;
  for (const record of [...history].reverse()) {
    let shift = 0;
    let mapped;
    for (const edit of record.edits) {
      const start = record.kind === "rename" ? edit.afterStart : edit.start;
      const added = record.kind === "rename" ? edit.new.length : edit.insertedLength;
      const removed = record.kind === "rename" ? edit.old.length : edit.removed.length;
      if (position < start) break;
      if (position < start + added) {
        if (record.operation) return record.operation.source;
        mapped = edit.start + Math.min(position - start, removed);
        break;
      }
      shift += added - removed;
    }
    position = mapped ?? position - shift;
  }
  return "main.cpp";
}
/** Mix supported complete free functions in named namespaces; emit working declaration and relocation stages. */
export async function mixFunctions(
  tree,
  directory,
  { seed = "renderer-function-mix-v1", history = [] } = {},
) {
  if (JSON.stringify(Object.keys(tree)) !== JSON.stringify(["main.cpp"]))
    throw new Error("Function mixing requires a monolith");
  if (cppTokens(tree["main.cpp"]).some((token) => ["__LINE__", "__COUNTER__"].includes(token.text)))
    throw new Error("Line-sensitive macros cannot survive function relocation");
  await mkdir(directory, { recursive: true });
  async function analyze(name, current) {
    const source = path.join(directory, name);
    await writeTree(source, current);
    const bytes = Buffer.from(current["main.cpp"]);
    const sourcePath = path.resolve(source, "main.cpp");
    const proof =
      name === "original"
        ? await includeBoundaries(sourcePath, flags)
        : { repeated: [], inactive: [] };
    const repeated = new Set([...proof.repeated, ...proof.inactive]);
    const roots = await projectAst(sourcePath, flags);
    return {
      ...inventory(roots, bytes, repeated),
      includeProof: { repeated: [...proof.repeated], inactive: [...proof.inactive] },
    };
  }
  const bytes = Buffer.from(tree["main.cpp"]);
  const data = await analyze("original", tree);
  const excluded = [];
  const candidates = [];
  const seen = new Set();
  for (const entry of data.definitions) {
    const identity = Number.isInteger(entry.start)
      ? `offset:${entry.start}`
      : `binding:${entry.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const reason = reasonFor(entry, data, bytes);
    if (reason)
      excluded.push({
        name: entry.node.name,
        scope: entry.scope,
        start: entry.start ?? null,
        reason,
      });
    else candidates.push(entry);
  }
  const groups = new Map();
  for (const entry of candidates) {
    const boundary = Math.max(
      typeBound(entry, data, true),
      ...data.barriers
        .filter(
          (barrier) =>
            (!barrier.scope || barrier.scope === entry.scope) && barrier.end <= entry.start,
        )
        .map((barrier) => barrier.end),
    );
    const group = `${entry.scope}:${boundary}`;
    const entries = groups.get(group) ?? [];
    entries.push(entry);
    groups.set(group, entries);
  }
  const selected = [];
  const inserts = [];
  for (const entries of groups.values()) {
    entries.sort((a, b) => a.start - b.start);
    const anchor = entries[0].start;
    const supported = entries.filter((entry) => {
      const family = data.families.get(entry.family);
      const signatures = new Set(family.map((node) => node.type.qualType));
      const declared = [...signatures].every((signature) =>
        family.some(
          (node) =>
            node.type.qualType === signature && endOf(node) !== null && endOf(node) <= anchor,
        ),
      );
      if (signatures.size > 1 && !declared) {
        excluded.push({
          name: entry.node.name,
          scope: entry.scope,
          start: entry.start,
          reason: "overload family not fully declared before region",
        });
        return false;
      }
      return true;
    });
    if (supported.length < 2) {
      for (const entry of supported)
        excluded.push({
          name: entry.node.name,
          scope: entry.scope,
          start: entry.start,
          reason: "no compatible peer in fixed-declaration region",
        });
      continue;
    }
    const declarationText =
      supported
        .map(
          (entry) =>
            bytes.subarray(entry.start, entry.body.range.begin.offset).toString("utf8").trimEnd() +
            ";\n",
        )
        .join("") + "\n";
    inserts.push({
      start: supported[0].start,
      end: supported[0].start,
      text: declarationText,
      group: entries,
    });
    let prototypeOffset = 0;
    for (const entry of supported) {
      selected.push({ ...entry, group: entries, prototypeOffset });
      prototypeOffset += Buffer.byteLength(
        bytes.subarray(entry.start, entry.body.range.begin.offset).toString("utf8").trimEnd() +
          ";\n",
      );
    }
  }
  selected.sort((a, b) => a.start - b.start);
  if (selected.length < 2) throw new Error("No compatible functions can mix");
  inserts.sort((a, b) => a.start - b.start);
  const declaredTree = { "main.cpp": replaceBytes(bytes, inserts) };
  let shift = 0;
  const declarationEdits = inserts.map((edit) => {
    const start = edit.start + shift;
    shift += Buffer.byteLength(edit.text);
    return { start, text: edit.text };
  });
  const fingerprint = hash(JSON.stringify(bindings(data)));
  const declaredData = await analyze("declarations", declaredTree);
  checkBindings(data, declaredData, "Forward declarations");
  const declarationRecord = {
    kind: "function-declarations",
    seed,
    before: treeIdentity(tree),
    after: treeIdentity(declaredTree),
    edits: declarationEdits,
  };
  const shifted = (offset, inclusive = true) =>
    offset +
    inserts
      .filter((edit) => edit.start < offset || (inclusive && edit.start === offset))
      .reduce((total, edit) => total + Buffer.byteLength(edit.text), 0);
  const slots = selected.map((entry) => ({
    start: shifted(entry.start),
    end: shifted(entry.end, false),
  }));
  const indexOf = new Map(selected.map((entry, index) => [entry, index]));
  const permutation = selected.map((_, index) => index);
  for (const entries of groups.values()) {
    const peers = selected.filter((entry) => entry.group === entries);
    if (peers.length < 2) continue;
    const peerSymbols = new Set(peers.map((entry) => entry.key));
    const lower = new Map();
    for (const entry of peers) {
      let bound = typeBound(entry, data);
      for (const reference of references(entry.body, data)) {
        const declaration = data.declarations.get(reference.id);
        const start = declaration?.node.range?.begin?.offset;
        if (start >= entry.start && start < entry.end) continue;
        if (declaration?.node.kind === "VarDecl") {
          const ends = [...data.declarations.values()]
            .filter(
              (decl) => decl.free && decl.key === declaration.key && decl.node.kind === "VarDecl",
            )
            .map((decl) => endOf(decl.node))
            .filter((end) => end !== null);
          if (ends.length) bound = Math.max(bound, Math.min(...ends));
        }
        if (declaration?.node.kind !== "FunctionDecl") continue;
        if (peerSymbols.has(declaration.key)) continue;
        const ends = [...data.declarations.values()]
          .filter((decl) => decl.key === declaration.key && decl.node.kind === "FunctionDecl")
          .map((decl) => endOf(decl.node))
          .filter((end) => end !== null);
        if (ends.length) bound = Math.max(bound, Math.min(...ends));
      }
      lower.set(entry, bound);
    }
    const remaining = [...peers].sort((a, b) =>
      hash(`${seed}:${a.key}`).localeCompare(hash(`${seed}:${b.key}`)),
    );
    for (const slot of peers) {
      const position = remaining.findIndex((entry) => lower.get(entry) <= slot.start);
      if (position < 0)
        throw new Error("No legal function assignment at fixed dependency boundary");
      const [entry] = remaining.splice(position, 1);
      permutation[indexOf.get(slot)] = indexOf.get(entry);
    }
  }
  const declaredBytes = Buffer.from(declaredTree["main.cpp"]);
  const units = slots.map((slot) => declaredBytes.subarray(slot.start, slot.end));
  const mixedTree = {
    "main.cpp": replaceBytes(
      declaredBytes,
      slots.map((slot, index) => ({ ...slot, text: units[permutation[index]].toString("utf8") })),
    ),
  };
  const mixedData = await analyze("permutation", mixedTree);
  checkBindings(data, mixedData, "Function relocation");
  shift = 0;
  const finalSlots = slots.map((slot, index) => {
    const occupant = permutation[index];
    const start = slot.start + shift;
    const end = start + units[occupant].length;
    shift += units[occupant].length - (slot.end - slot.start);
    return { start, end, original: index, occupant, hash: hash(units[occupant]) };
  });
  const permutationRecord = {
    kind: "function-permutation",
    seed,
    before: treeIdentity(declaredTree),
    after: treeIdentity(mixedTree),
    slots: finalSlots,
  };
  const line = (buffer, offset) => buffer.subarray(0, offset).toString("utf8").split("\n").length;
  const mixedBytes = Buffer.from(mixedTree["main.cpp"]);
  const placements = selected.map((entry, index) => {
    const target = finalSlots.find((slot) => slot.occupant === index);
    const declaration =
      declarationEdits[inserts.findIndex((insert) => insert.group === entry.group)];
    const prototypeOriginal = declaration.start + entry.prototypeOffset;
    const prototypePosition =
      prototypeOriginal +
      slots.reduce(
        (delta, slot, i) =>
          delta +
          (slot.end <= prototypeOriginal
            ? units[permutation[i]].length - (slot.end - slot.start)
            : 0),
        0,
      );
    const prototypeText =
      bytes.subarray(entry.start, entry.body.range.begin.offset).toString("utf8").trimEnd() + ";\n";
    return {
      name: entry.node.name,
      scope: entry.scope,
      signature: typeName(entry.node),
      from: {
        byte: entry.start,
        line: line(bytes, entry.start),
        region: entry.region,
        source: sourceOrigin(tree["main.cpp"], entry.start, history, entry.region),
      },
      to: {
        byte: target.start,
        line: line(mixedBytes, target.start),
        region: selected[target.original].region,
        source: sourceOrigin(
          tree["main.cpp"],
          selected[target.original].start,
          history,
          selected[target.original].region,
        ),
      },
      declarationLine: line(mixedBytes, prototypePosition),
      declaration: {
        byte: prototypePosition,
        length: Buffer.byteLength(prototypeText),
        hash: hash(prototypeText),
      },
      body: {
        fromStart: entry.body.range.begin.offset,
        start: target.start + entry.body.range.begin.offset - entry.start,
        length: entry.end - entry.body.range.begin.offset,
      },
      bodyHash: hash(bytes.subarray(entry.body.range.begin.offset, entry.end)),
    };
  });
  const bySymbol = new Map(selected.map((entry, index) => [entry.key, index]));
  const related = [];
  for (const [index, entry] of selected.entries()) {
    const callees = new Set(
      references(entry.body, data)
        .map((reference) => {
          const decl = data.declarations.get(reference.id);
          return decl?.node.kind === "FunctionDecl" ? bySymbol.get(decl.key) : undefined;
        })
        .filter((callee) => callee !== undefined && callee !== index),
    );
    for (const callee of callees)
      related.push({
        caller: entry.node.name,
        callerSignature: typeName(entry.node),
        calleeSignature: typeName(selected[callee].node),
        callee: selected[callee].node.name,
        before: Math.abs(placements[index].from.line - placements[callee].from.line),
        after: Math.abs(placements[index].to.line - placements[callee].to.line),
      });
  }
  const summary = {
    seed,
    selected: placements.length,
    moved: permutation.filter((occupant, index) => occupant !== index).length,
    crossRegionMoves: placements.filter((entry) => entry.from.source !== entry.to.source).length,
    definitions: seen.size,
    coverage: placements.length / seen.size,
    includeProof: data.includeProof,
    bindings: { status: "unchanged", fingerprint },
    placements,
    related: related.sort((a, b) => b.after - b.before - (a.after - a.before)),
    excluded,
  };
  return {
    stages: [
      { tree: declaredTree, record: declarationRecord },
      { tree: mixedTree, record: permutationRecord },
    ],
    summary,
  };
}

/** Undo declarations or relocation from current source and guarded metadata, never saved bodies. */
export function undoFunctionMix(tree, record) {
  if (treeIdentity(tree) !== record.after)
    throw new Error("Function inverse source identity differs");
  const bytes = Buffer.from(tree["main.cpp"]);
  let edits;
  if (record.kind === "function-declarations") {
    edits = record.edits.map((edit) => {
      const end = edit.start + Buffer.byteLength(edit.text);
      if (bytes.subarray(edit.start, end).toString("utf8") !== edit.text)
        throw new Error("Declaration span differs");
      return { start: edit.start, end, text: "" };
    });
  } else if (record.kind === "function-permutation") {
    const units = new Map();
    for (const slot of record.slots) {
      const unit = bytes.subarray(slot.start, slot.end);
      if (hash(unit) !== slot.hash || units.has(slot.occupant))
        throw new Error("Function span differs");
      units.set(slot.occupant, unit);
    }
    edits = record.slots.map((slot) => ({
      start: slot.start,
      end: slot.end,
      text: units.get(slot.original)?.toString("utf8") ?? "",
    }));
  } else throw new Error("Unknown function inverse operation");
  const restored = { "main.cpp": replaceBytes(bytes, edits) };
  if (treeIdentity(restored) !== record.before)
    throw new Error("Function inverse identity differs");
  return restored;
}
