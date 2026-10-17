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
 * function is provably impossible by fixed arity or a trusted compiler witness
 * proves deduction impossible or a visible viable sibling strictly dominates it.
 * AST identities/redeclarations, not spelling or signatures, identify families. Every observation of the same
 * source token must support exclusion; resolved selected references and unknown
 * shapes retain the edit. Defaults, variadics, packs and macros stay unchanged.
 * Unqualified explicit-template callees support only fixed-arity exclusion;
 * qualified or otherwise unsupported ranges and same-arity calls stay unchanged.
 * The returned predicate is KEEP: false removes only the surplus edit, never
 * declarations.
 * AST/entry offsets are bytes; edit.start is a JavaScript UTF-16 source offset.
 * This private snapshot filter must be applied per selected declaration before
 * merging semantic edits, in both certification and current-task planning.
 * A same-arity witness may inspect the same compiler document asynchronously;
 * unknown cases remain KEEP and resolved selected uses still veto exclusion.
 * The returned predicate also exposes sharedCall({required, allowed, edit}), a
 * synchronous private proof of genuinely shared resolved generic-call use. It
 * never merges plans and returns false for incomplete or unsupported evidence.
 * @param {{ canExclude?: (input: { selectedFunctions: object[], candidateFamilies: object[][], call: object }) => boolean | Promise<boolean> }} [options]
 */
export function createDirectCallEditFilter(roots, source, options = {}) {
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
    const family = families.get(key) ?? {
      safe: !unsafeTemplates.has(key),
      callSafe: !unsafeTemplates.has(key),
      count: undefined,
      functions: [],
    };
    family.functions.push(node);
    const parameters = (node.inner ?? []).filter((child) => child.kind === "ParmVarDecl");
    const count = parameters.length;
    const defaults = parameters.some(
      (parameter) =>
        parameter.init !== undefined ||
        parameter.defaultArg !== undefined ||
        parameter.hasInheritedDefaultArg,
    );
    const fixed =
      plainLocation(node.loc) &&
      !!node.range &&
      Array.isArray(node.inner) &&
      !node.variadic &&
      parameters.every(
        (parameter) => !parameter.isParameterPack && !parameter.type?.qualType?.includes("..."),
      ) &&
      (family.count === undefined || family.count === count);
    family.safe &&= fixed && !defaults;
    // Positive resolved-call evidence can use defaults; arity-based exclusion
    // still requires the stricter flag above and never guesses about defaults.
    family.callSafe &&= fixed;
    const firstDefault = parameters.findIndex(
      (parameter) =>
        parameter.init !== undefined ||
        parameter.defaultArg !== undefined ||
        parameter.hasInheritedDefaultArg,
    );
    family.minimumCount = Math.min(
      family.minimumCount ?? count,
      firstDefault < 0 ? count : firstDefault,
    );
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
      begin.offset < 0 ||
      end.offset < begin.offset ||
      !Number.isSafeInteger(end.tokLen) ||
      end.tokLen < 1 ||
      end.offset + end.tokLen > bytes.length
    )
      return undefined;
    const length = Buffer.byteLength(name);
    if (
      end.tokLen === length &&
      bytes.subarray(end.offset, end.offset + length).toString("utf8") === name
    )
      return { name, offset: end.offset };
    if (
      begin.tokLen === length &&
      bytes.subarray(begin.offset, begin.offset + length).toString("utf8") === name &&
      /^\s*</.test(bytes.subarray(begin.offset + length, end.offset).toString("utf8")) &&
      /^>+$/.test(bytes.subarray(end.offset, end.offset + end.tokLen).toString("utf8"))
    )
      return { name, offset: begin.offset, explicitTemplate: true };
    return undefined;
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
  function boundedRange(range) {
    const begin = range?.begin,
      end = range?.end;
    return (
      plainLocation(begin) &&
      plainLocation(end) &&
      begin.offset >= 0 &&
      end.offset >= begin.offset &&
      Number.isSafeInteger(end.tokLen) &&
      end.tokLen > 0 &&
      end.offset + end.tokLen <= bytes.length
    );
  }
  function macroObservation(node) {
    const locations = [node.loc, node.range?.begin, node.range?.end];
    return (
      locations.some(
        (location) =>
          location &&
          (location.spellingLoc ||
            location.expansionLoc ||
            location.includedFrom ||
            location.isMacroArgExpansion),
      ) || (node.inner ?? []).some(macroObservation)
    );
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
    const defaults = call.inner.slice(1).filter((node) => node.kind === "CXXDefaultArgExpr");
    if (
      defaults.length &&
      (callee.kind !== "DeclRefExpr" ||
        defaults.some(
          (node) =>
            node.inner?.length ||
            typeof node.type?.qualType !== "string" ||
            [node.range?.begin, node.range?.end].some(
              (location) => !location || Object.keys(location).length !== 0,
            ),
        ))
    ) {
      add(token.offset, { kind: "unknown" });
      return;
    }
    const arguments_ = call.inner.slice(1).filter((node) => node.kind !== "CXXDefaultArgExpr");
    const safeCall =
      boundedRange(call.range) &&
      [call.inner[0], ...arguments_].every((node) => boundedRange(node.range)) &&
      !macroObservation(call);
    if (callee.kind === "UnresolvedLookupExpr") {
      if (!Array.isArray(callee.lookups)) {
        add(token.offset, { kind: "unknown" });
        return;
      }
      const candidates = callee.lookups.map((lookup) => familyOf(lookup.id));
      add(token.offset, {
        kind: "unresolved",
        explicitTemplate: token.explicitTemplate === true,
        call,
        safeCall,
        count: arguments_.length,
        completeCandidates: candidates.length > 0 && candidates.every(Boolean),
        candidates: new Set(candidates.filter(Boolean)),
      });
    } else {
      const ids = [callee.foundReferencedDecl?.id, callee.referencedDecl?.id].filter(Boolean);
      const resolved = ids.map(familyOf);
      const key =
        resolved.length && resolved.every((item) => item && item === resolved[0])
          ? resolved[0]
          : undefined;
      add(token.offset, {
        kind: "resolved",
        family: key,
        safeCall,
        count: arguments_.length,
        totalCount: call.inner.length - 1,
      });
    }
  });
  walk(roots, (node) => {
    if (references.has(node.kind) && !classified.has(node)) unknown(node);
  });
  const offsets = new Map();
  const keep = (entry, edit) => {
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
    const excluded = (row) =>
      row.kind === "unresolved"
        ? row.count !== family.count
        : row.kind === "resolved" && row.family && row.family !== key;
    if (rows.every(excluded)) return false;
    const canExclude = options.canExclude;
    if (!canExclude) return true;
    return (async () => {
      for (const row of rows) {
        if (excluded(row)) continue;
        if (row.kind !== "unresolved" || row.explicitTemplate || !row.candidates.has(key))
          return true;
        const candidateFamilies = [...row.candidates]
          .map((candidate) => families.get(candidate))
          .filter((candidate) => candidate?.safe && candidate.count === family.count)
          .map((candidate) => candidate.functions);
        if (
          !(await canExclude({
            selectedFunctions: family.functions,
            candidateFamilies,
            call: row.call,
          }))
        )
          return true;
      }
      return false;
    })();
  };
  /** Prove genuine shared direct-call use, not mere overlapping rename coverage.
   * Entries use compiler byte declaration offsets; edit.start is joined UTF-16.
   * Every required canonical family needs its own resolved observation at this
   * exact token. All resolved and potentially viable lookup families must stay
   * inside allowed; unknown or unsupported observations veto the proof.
   * This is private certification evidence, not permission to merge plans.
   */
  keep.sharedCall = (input) => {
    const { required, allowed, edit } = input ?? {};
    if (
      unlocatedUnknown ||
      !Array.isArray(required) ||
      !Array.isArray(allowed) ||
      !identifier.test(edit?.old ?? "") ||
      !identifier.test(edit?.new ?? "") ||
      edit.old === edit.new ||
      !Number.isSafeInteger(edit.start) ||
      edit.start < 0 ||
      source.slice(edit.start, edit.start + edit.old.length) !== edit.old ||
      unknownNames.has(edit.old)
    )
      return false;
    const group = (entries) => {
      const selected = new Set();
      for (const entry of entries) {
        if (
          entry?.role !== "function" ||
          entry.name !== edit.old ||
          entry.newName !== edit.new ||
          !Number.isSafeInteger(entry.offset) ||
          entry.offset < 0 ||
          bytes
            .subarray(entry.offset, entry.offset + Buffer.byteLength(entry.name))
            .toString("utf8") !== entry.name
        )
          return undefined;
        const keys = declarations.get(entry.offset);
        if (keys?.size !== 1) return undefined;
        const key = [...keys][0],
          family = families.get(key);
        if (!family?.callSafe || !Number.isSafeInteger(family.count)) return undefined;
        selected.add(key);
      }
      return selected;
    };
    const needed = group(required),
      permitted = group(allowed);
    if (!needed || needed.size < 2 || !permitted || [...needed].some((key) => !permitted.has(key)))
      return false;
    const offset = Buffer.byteLength(source.slice(0, edit.start));
    const rows = observations.get(offset);
    if (!rows?.length) return false;
    const resolved = new Set();
    let generic = false;
    for (const row of rows) {
      if (
        !row.safeCall ||
        !Number.isSafeInteger(row.count) ||
        [...needed].some((key) => {
          const family = families.get(key);
          return row.count < family.minimumCount || row.count > family.count;
        })
      )
        return false;
      if (row.kind === "resolved") {
        if (
          !row.family ||
          !permitted.has(row.family) ||
          row.totalCount !== families.get(row.family).count ||
          row.count < families.get(row.family).minimumCount ||
          row.count > families.get(row.family).count
        )
          return false;
        resolved.add(row.family);
      } else if (row.kind === "unresolved") {
        if (!row.completeCandidates) return false;
        generic = true;
        for (const key of row.candidates) {
          const family = families.get(key);
          if (!family?.callSafe || !Number.isSafeInteger(family.count)) return false;
          if (row.count >= family.minimumCount && row.count <= family.count && !permitted.has(key))
            return false;
        }
      } else return false;
    }
    return generic && [...needed].every((key) => resolved.has(key));
  };
  return keep;
}
