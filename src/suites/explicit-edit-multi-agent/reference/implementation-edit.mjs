import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { includeDirectives } from "../cpp/cpp-tokens.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";
import { treeIdentity } from "../generation/generator.mjs";

/** Locate a complete current declaration by its scope and declarator, rejecting ambiguity. */
export function locateImplementation(
  source,
  selector,
  structure = cppStructure(source),
  { allowMissing = false } = {},
) {
  if (!selector?.scope || typeof selector.declarator !== "string" || !selector.declarator)
    throw new Error("Missing current physical owner/declarator selector");
  const matches = structure.units.filter(
    (unit) =>
      (unit.scope || "::") === selector.scope &&
      unit.kind !== "using" &&
      (selector.kind !== "conditional" || unit.condition === selector.condition) &&
      (selector.definition === undefined || unit.definition === selector.definition) &&
      unitDeclarator(source, unit) === selector.declarator,
  );
  if (
    selector.occurrence !== undefined &&
    (!Number.isSafeInteger(selector.occurrence) || selector.occurrence < 0)
  )
    throw new Error("Missing current declaration occurrence");
  if (!matches.length && allowMissing) return undefined;
  if (selector.occurrence !== undefined) {
    if (!matches[selector.occurrence]) throw new Error("Missing current declaration occurrence");
    return matches[selector.occurrence];
  }
  if (matches.length !== 1) throw new Error("Missing or ambiguous implementation owner selector");
  return matches[0];
}

/** Decide whether exact current text needs an actual compiler identity lookup.
 * Identifier containment is only a conservative compile trigger, never selection.
 */
export function implementationResolutionNeeded(tree, request) {
  if (
    request.action !== "implementation" ||
    !/^[A-Za-z_]\w*\.cpp$/.test(request.file ?? "") ||
    request.file === "main.cpp" ||
    !Array.isArray(request.targets) ||
    typeof tree["main.cpp"] !== "string"
  )
    return false;
  const source = cppStructure(tree["main.cpp"]);
  const destination = cppStructure(tree[request.file] ?? "");
  return request.targets.some(({ selector }) => {
    if (
      selector?.kind !== "function" ||
      typeof selector.name !== "string" ||
      !selector.name ||
      typeof selector.signature !== "string" ||
      !selector.signature
    )
      return false;
    const { occurrence: _occurrence, ...moved } = selector;
    const from = locateImplementation(tree["main.cpp"], selector, source, { allowMissing: true });
    const into = locateImplementation(tree[request.file] ?? "", moved, destination, {
      allowMissing: true,
    });
    const possible = (text, structure) =>
      structure.units.some(
        (unit) =>
          (unit.scope || "::") === selector.scope &&
          unit.definition === selector.definition &&
          unitDeclarator(text, unit).includes(selector.name),
      );
    return (
      (!from && !into) ||
      (!from && possible(tree["main.cpp"], source)) ||
      (!into && possible(tree[request.file] ?? "", destination))
    );
  });
}

function resolvedUnit(structure, selected, selector) {
  if (!selected) return undefined;
  const matches = structure.units.filter(
    (unit) =>
      unit.start === selected.start &&
      unit.end === selected.end &&
      (unit.scope || "::") === selector.scope &&
      (selector.definition === undefined || unit.definition === selector.definition),
  );
  if (matches.length !== 1) throw Error("Stale current implementation compiler owner");
  return matches[0];
}
function usingContext(context = []) {
  if (
    !Array.isArray(context) ||
    context.some(
      (line) =>
        typeof line !== "string" ||
        !/^using\s+(?:namespace\s+)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\s*;$/.test(line.trim()),
    )
  )
    throw new Error("Unsupported implementation using context");
  return context.length ? context.join("\n") + "\n" : "";
}

/** Move only uniquely selected current physical C++ units. No private inventory,
 * inverse record, original body or future tree is available to this executor.
 * Selection is transactional in memory: a missing target leaves the input untouched.
 */
export function moveImplementation(tree, request, { allowMoved = false, resolution } = {}) {
  const { file, targets, includes } = request;
  if (
    !/^[A-Za-z_]\w*\.cpp$/.test(file ?? "") ||
    file === "main.cpp" ||
    !Array.isArray(targets) ||
    !targets.length
  )
    throw new Error("Unsupported implementation request");
  if (!Array.isArray(includes) || !includes.length)
    throw new Error("Missing implementation includes");
  const source = tree["main.cpp"];
  if (typeof source !== "string") throw new Error("Missing monolith");
  const structure = cppStructure(source);
  const existing = tree[file] ?? "";
  const destinationStructure = allowMoved ? cppStructure(existing) : undefined;
  const destinations = new Set();
  if (
    resolution &&
    (!allowMoved ||
      resolution.before !== treeIdentity(tree) ||
      resolution.request !== JSON.stringify(request) ||
      !Array.isArray(resolution.targets) ||
      resolution.targets.length !== targets.length)
  )
    throw Error("Stale current implementation compiler resolution");
  const selected = targets.map((target, index) => {
    const unit =
      locateImplementation(source, target.selector, structure, {
        allowMissing: allowMoved,
      }) ?? resolvedUnit(structure, resolution?.targets[index].source, target.selector);
    const context = usingContext(target.context);
    let destinationUnit;
    if (allowMoved) {
      // An occurrence index selects the source copy. A moved destination must
      // have one unambiguous owner of its own, independent of the old ordinal.
      const { occurrence: _occurrence, ...selector } = target.selector;
      destinationUnit =
        locateImplementation(existing, selector, destinationStructure, {
          allowMissing: true,
        }) ?? resolvedUnit(destinationStructure, resolution?.targets[index].destination, selector);
      if (destinationUnit) {
        if (destinations.has(destinationUnit.start))
          throw Error("Repeated implementation destination");
        destinations.add(destinationUnit.start);
      }
      if (!unit && !destinationUnit)
        throw Error("Missing current implementation source and destination");
    }
    return { target, unit, destinationUnit, context };
  });
  const ordered = selected.filter((item) => item.unit).sort((a, b) => a.unit.start - b.unit.start);
  for (let index = 1; index < ordered.length; index++)
    if (ordered[index - 1].unit.end > ordered[index].unit.start)
      throw new Error("Repeated or overlapping implementation targets");
  let destination = tree[file] ?? "";
  if (request.preamble !== undefined) {
    if (
      typeof request.preamble !== "string" ||
      request.preamble
        .replace(/^\s*#(?:include|if\w*|endif|else|elif)\b[^\n]*(?:\n|$)/gm, "")
        .trim()
    )
      throw new Error("Unsupported implementation directive preamble");
    cppStructure(request.preamble);
    if (!destination) destination = request.preamble;
  }
  const existingIncludes = new Set(
    includeDirectives(destination).map((item) => JSON.stringify([item.file, item.quoted])),
  );
  let preamble = "";
  for (const item of includes) {
    if (
      !item ||
      typeof item.quoted !== "boolean" ||
      !/^(?:[A-Za-z0-9_-]+\/)*[\w.-]+$/.test(item.file) ||
      item.file.split("/").some((part) => [".", ".."].includes(part))
    )
      throw new Error("Unsafe implementation include");
    const key = JSON.stringify([item.file, item.quoted]);
    if (!existingIncludes.has(key)) {
      preamble += `#include ${item.quoted ? '"' + item.file + '"' : "<" + item.file + ">"}\n`;
      existingIncludes.add(key);
    }
  }
  destination = preamble + destination;
  for (const { target, unit, destinationUnit, context } of selected) {
    // A restored monolith can contain a stale second copy after the move's
    // destination was published. Remove that source copy without overwriting
    // the current destination or appending a duplicate definition.
    if (!unit || destinationUnit) continue;
    const text = context + source.slice(unit.start, unit.end);
    const after = target.after ? locateImplementation(destination, target.after) : null;
    const before = target.before ? locateImplementation(destination, target.before) : null;
    if (after && before && after.end > before.start)
      throw new Error("Reversed implementation placement anchors");
    const anchor = before ?? after;
    const sameScope = anchor && anchor.scope === unit.scope;
    const fragment = sameScope || !unit.scope ? text : `namespace ${unit.scope} {\n${text}\n}`;
    if (anchor) {
      let namespace;
      if (!sameScope)
        for (const item of cppStructure(destination).namespaces)
          if (
            item.start <= anchor.start &&
            anchor.end <= item.end &&
            (!namespace || item.start < namespace.start)
          )
            namespace = item;
      const position = before ? (namespace?.start ?? anchor.start) : (namespace?.end ?? anchor.end);
      destination =
        destination.slice(0, position) + "\n" + fragment + "\n" + destination.slice(position);
    } else destination += `\n${fragment}\n`;
  }
  let monolith = "",
    cursor = 0;
  for (const { unit } of ordered) {
    monolith += source.slice(cursor, unit.start);
    cursor = unit.end;
  }
  monolith += source.slice(cursor);
  const next = { ...tree, "main.cpp": monolith, [file]: destination };
  for (const [name, text] of Object.entries(next)) assertNeutralSource(name, text);
  return next;
}
