import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { includeDirectives } from "../cpp/cpp-tokens.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";

/** Locate a complete current declaration by its scope and declarator, rejecting ambiguity. */
export function locateImplementation(source, selector, structure = cppStructure(source)) {
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
  if (selector.occurrence !== undefined) {
    if (
      !Number.isSafeInteger(selector.occurrence) ||
      selector.occurrence < 0 ||
      !matches[selector.occurrence]
    )
      throw new Error("Missing current declaration occurrence");
    return matches[selector.occurrence];
  }
  if (matches.length !== 1) throw new Error("Missing or ambiguous implementation owner selector");
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
export function moveImplementation(tree, request) {
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
  const selected = targets.map((target) => ({
    target,
    unit: locateImplementation(source, target.selector, structure),
  }));
  const ordered = [...selected].sort((a, b) => a.unit.start - b.unit.start);
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
  for (const { target, unit } of selected) {
    const text = usingContext(target.context) + source.slice(unit.start, unit.end);
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
