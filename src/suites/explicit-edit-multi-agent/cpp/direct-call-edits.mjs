const references = new Set([
  "UnresolvedLookupExpr",
  "DeclRefExpr",
  "DependentScopeDeclRefExpr",
  "UnresolvedMemberExpr",
  "CXXDependentScopeMemberExpr",
  "MemberExpr",
]);
const identifier = /^[A-Za-z_]\w*$/;
const plainLocation = (location) =>
  Number.isInteger(location?.offset) &&
  !location.spellingLoc &&
  !location.expansionLoc &&
  !location.includedFrom &&
  !location.isMacroArgExpansion;
const nameOf = (node) => node.name ?? node.member ?? node.referencedDecl?.name;

function walk(roots, visit) {
  function descend(node) {
    visit(node);
    for (const child of node.inner ?? []) descend(child);
  }
  for (const root of roots) descend(root);
}
function complete(node) {
  return Number(!!node.loc) + Number(!!node.range) + Number(Array.isArray(node.inner));
}
function containsPack(node) {
  return node.kind === "PackExpansionExpr" || (node.inner ?? []).some(containsPack);
}

/** Refine compiler rename edits only for direct unresolved calls whose selected
 * function is provably impossible by fixed arity. AST identities/redeclarations,
 * not spelling or signatures, identify families. Every observation of the same
 * source token must support exclusion; resolved selected references and unknown
 * shapes retain the edit. Defaults, variadics, packs, macros and explicit template
 * callee ranges are deliberately unsupported and stay unchanged. The returned
 * predicate is KEEP: false removes only the surplus edit, never declarations.
 * AST/entry offsets are bytes; edit.start is a JavaScript UTF-16 source offset.
 * This private snapshot filter must be applied per selected declaration before
 * merging semantic edits, in both certification and current-task planning.
 */
export function createDirectCallEditFilter(roots, source) {
  const bytes = Buffer.from(source);
  const nodes = new Map();
  walk(roots, (node) => {
    if (node.id && complete(node) > complete(nodes.get(node.id) ?? {})) nodes.set(node.id, node);
  });
  function chain(id, kind) {
    const seen = new Set();
    const result = [];
    for (;;) {
      const node = nodes.get(id);
      if (!node || node.kind !== kind || seen.has(id)) return [];
      seen.add(id);
      result.push(id);
      if (!node.previousDecl) return result;
      id = node.previousDecl;
    }
  }
  const templateFamilies = new Map();
  const unsafeTemplates = new Set();
  for (const node of nodes.values()) {
    if (node.kind !== "FunctionTemplateDecl") continue;
    const ancestors = chain(node.id, "FunctionTemplateDecl");
    if (!ancestors.length) continue;
    const family = `template:${ancestors.at(-1)}`;
    if ((node.inner ?? []).some((child) => child.isParameterPack)) unsafeTemplates.add(family);
    for (const child of node.inner ?? []) {
      if (child.kind !== "FunctionDecl" || !child.id) continue;
      const families = templateFamilies.get(child.id) ?? new Set();
      families.add(family);
      templateFamilies.set(child.id, families);
    }
  }
  function familyOf(id) {
    const node = nodes.get(id);
    if (node?.kind === "FunctionTemplateDecl") {
      const ancestors = chain(id, node.kind);
      return ancestors.length ? `template:${ancestors.at(-1)}` : undefined;
    }
    if (node?.kind !== "FunctionDecl") return undefined;
    const ancestors = chain(id, node.kind);
    if (!ancestors.length) return undefined;
    const templates = new Set(ancestors.flatMap((item) => [...(templateFamilies.get(item) ?? [])]));
    if (templates.size > 1) return undefined;
    return templates.size ? [...templates][0] : `function:${ancestors.at(-1)}`;
  }
  const families = new Map();
  const declarations = new Map();
  for (const node of nodes.values()) {
    if (node.kind !== "FunctionDecl") continue;
    const key = familyOf(node.id);
    if (!key) continue;
    const family = families.get(key) ?? { safe: !unsafeTemplates.has(key), count: undefined };
    const parameters = (node.inner ?? []).filter((child) => child.kind === "ParmVarDecl");
    const count = parameters.length;
    family.safe &&=
      plainLocation(node.loc) &&
      !!node.range &&
      Array.isArray(node.inner) &&
      !node.variadic &&
      parameters.every(
        (parameter) =>
          parameter.init === undefined &&
          parameter.defaultArg === undefined &&
          !parameter.hasInheritedDefaultArg &&
          !parameter.isParameterPack &&
          !parameter.type?.qualType?.includes("..."),
      ) &&
      (family.count === undefined || family.count === count);
    family.count ??= count;
    families.set(key, family);
    if (plainLocation(node.loc)) {
      const selected = declarations.get(node.loc.offset) ?? new Set();
      selected.add(key);
      declarations.set(node.loc.offset, selected);
    }
  }
  const observations = new Map();
  const unknownNames = new Set();
  let unlocatedUnknown = false;
  const classified = new WeakSet();
  const add = (offset, observation) => {
    const rows = observations.get(offset) ?? [];
    rows.push(observation);
    observations.set(offset, rows);
  };
  function exactToken(node) {
    const name = nameOf(node);
    const begin = node.range?.begin;
    const end = node.range?.end;
    if (
      !identifier.test(name ?? "") ||
      !plainLocation(begin) ||
      !plainLocation(end) ||
      end.offset < begin.offset ||
      end.tokLen !== Buffer.byteLength(name) ||
      bytes.subarray(end.offset, end.offset + end.tokLen).toString("utf8") !== name
    )
      return undefined;
    return { name, offset: end.offset };
  }
  function unknown(node) {
    const name = nameOf(node);
    if (!identifier.test(name ?? "")) {
      const ranges = [];
      function locations(begin, end) {
        if (!begin && !end) return;
        if (end?.tokLen !== undefined && (!Number.isSafeInteger(end.tokLen) || end.tokLen < 1)) {
          unlocatedUnknown = true;
          return;
        }
        const length = end?.tokLen ?? 1;
        if (Number.isInteger(begin?.offset) || Number.isInteger(end?.offset)) {
          if (
            Number.isInteger(begin?.offset) &&
            Number.isInteger(end?.offset) &&
            begin.offset >= 0 &&
            end.offset >= begin.offset &&
            Number.isSafeInteger(end.offset + length) &&
            end.offset + length <= bytes.length
          )
            ranges.push([begin.offset, end.offset + length]);
          else unlocatedUnknown = true;
        }
        locations(begin?.spellingLoc, end?.spellingLoc);
        locations(begin?.expansionLoc, end?.expansionLoc);
      }
      locations(node.range?.begin, node.range?.end);
      locations(node.loc, node.loc);
      if (!ranges.length) unlocatedUnknown = true;
      for (const offset of observations.keys())
        if (ranges.some(([begin, end]) => begin <= offset && offset < end))
          add(offset, { kind: "unknown" });
      return;
    }
    const needle = Buffer.from(name);
    const positions = new Set();
    function location(value) {
      if (!value) return;
      if (
        Number.isInteger(value.offset) &&
        bytes.subarray(value.offset, value.offset + needle.length).equals(needle)
      )
        positions.add(value.offset);
      location(value.spellingLoc);
      location(value.expansionLoc);
    }
    location(node.range?.begin);
    location(node.range?.end);
    const begin = node.range?.begin?.offset;
    const end = node.range?.end?.offset;
    if (Number.isInteger(begin) && Number.isInteger(end) && begin <= end) {
      for (
        let offset = bytes.indexOf(needle, begin);
        offset >= 0 && offset <= end;
        offset = bytes.indexOf(needle, offset + 1)
      ) {
        const before = bytes.subarray(Math.max(0, offset - 1), offset).toString();
        const after = bytes.subarray(offset + needle.length, offset + needle.length + 1).toString();
        if (!/[A-Za-z_0-9]/.test(before) && !/[A-Za-z_0-9]/.test(after)) positions.add(offset);
      }
    }
    if (!positions.size) unknownNames.add(name);
    for (const offset of positions) add(offset, { kind: "unknown" });
  }
  walk(roots, (call) => {
    if (call.kind !== "CallExpr" || !call.inner?.length) return;
    let callee = call.inner[0];
    while (["ImplicitCastExpr", "ParenExpr"].includes(callee.kind) && callee.inner?.length === 1)
      callee = callee.inner[0];
    if (!["UnresolvedLookupExpr", "DeclRefExpr"].includes(callee.kind)) return;
    const token = exactToken(callee);
    if (!token || call.inner.slice(1).some(containsPack)) return;
    classified.add(callee);
    if (callee.kind === "UnresolvedLookupExpr") {
      if (!Array.isArray(callee.lookups)) {
        add(token.offset, { kind: "unknown" });
        return;
      }
      add(token.offset, {
        kind: "unresolved",
        count: call.inner.length - 1,
        candidates: new Set(callee.lookups.map((lookup) => familyOf(lookup.id)).filter(Boolean)),
      });
    } else {
      const ids = [callee.foundReferencedDecl?.id, callee.referencedDecl?.id].filter(Boolean);
      const resolved = ids.map(familyOf);
      const key =
        resolved.length && resolved.every((item) => item && item === resolved[0])
          ? resolved[0]
          : undefined;
      add(token.offset, { kind: "resolved", family: key });
    }
  });
  walk(roots, (node) => {
    if (references.has(node.kind) && !classified.has(node)) unknown(node);
  });
  const offsets = new Map();
  return (entry, edit) => {
    if (
      unlocatedUnknown ||
      entry.role !== "function" ||
      edit.old !== entry.name ||
      !Number.isInteger(edit.start) ||
      edit.start < 0 ||
      source.slice(edit.start, edit.start + edit.old.length) !== edit.old ||
      unknownNames.has(entry.name)
    )
      return true;
    const selected = declarations.get(entry.offset);
    if (selected?.size !== 1) return true;
    const key = [...selected][0];
    const family = families.get(key);
    if (!family?.safe || !Number.isInteger(family.count)) return true;
    if (!offsets.has(edit.start))
      offsets.set(edit.start, Buffer.byteLength(source.slice(0, edit.start)));
    const rows = observations.get(offsets.get(edit.start));
    if (!rows?.some((row) => row.kind === "unresolved" && row.candidates.has(key))) return true;
    return !rows.every((row) =>
      row.kind === "unresolved"
        ? row.count !== family.count
        : row.kind === "resolved" && row.family && row.family !== key,
    );
  };
}
