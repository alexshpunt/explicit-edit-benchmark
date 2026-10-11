import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { locateImplementation, moveImplementation } from "./implementation-edit.mjs";
import { applyRequest } from "./scripted-worker.mjs";
import { compactBlankLines } from "../generation/generator.mjs";
import { includeDirectives } from "../cpp/cpp-tokens.mjs";

/** Describe a conditional include-only preamble using its guard and include targets.
 * It contains no declaration body, byte offset or saved replacement source.
 */
export function includePreambleSelector(source, unit) {
  const body = source.slice(unit.start, unit.end);
  if (
    unit.kind !== "conditional" ||
    unit.scope ||
    !includeDirectives(body).length ||
    !body
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .every((line) => /^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif|include)\b/.test(line))
  )
    throw Error("Cleanup target is not an include-only root preamble");
  return {
    condition: unit.condition,
    includes: includeDirectives(body).map(({ file, quoted }) => ({ file, quoted })),
  };
}
/** Apply current neutral structural requests, never inverse spans or saved source trees. */
export function applyFullStructure(tree, request) {
  const source = tree["main.cpp"];
  if (request.action === "header") return applyRequest(tree, request.prompt);
  if (request.action === "implementation") return moveImplementation(tree, request);
  if (request.action === "swap-definitions") {
    const structure = cppStructure(source, { expandNamespaceConditionals: true });
    const selected = request.selectors
      .map((selector) => locateImplementation(source, selector, structure))
      .sort((a, b) => a.start - b.start);
    if (selected.length !== 2 || selected[0].end > selected[1].start)
      throw new Error("Invalid function swap targets");
    const [a, b] = selected;
    return compactBlankLines({
      ...tree,
      "main.cpp":
        source.slice(0, a.start) +
        source.slice(b.start, b.end) +
        source.slice(a.end, b.start) +
        source.slice(a.start, a.end) +
        source.slice(b.end),
    }).tree;
  }
  if (request.action === "remove-generated-declaration") {
    const unit = locateImplementation(
      source,
      request.selector,
      cppStructure(source, { expandNamespaceConditionals: true }),
    );
    if (!source.slice(unit.start, unit.end).trimEnd().endsWith(";"))
      throw new Error("Requested prototype is a definition");
    return compactBlankLines({
      ...tree,
      "main.cpp": source.slice(0, unit.start) + source.slice(unit.end),
    }).tree;
  }
  if (request.action === "vendor-header") {
    if (tree[request.file] !== undefined || request.file !== "support/stb_image/stb_image_resize.h")
      throw new Error("Unsupported vendor target");
    const units = cppStructure(source).units;
    const guards = units.filter((unit) => unit.condition === `#ifndef ${request.guard}`);
    const implementations = units.filter((unit) => unit.condition === `#ifdef ${request.macro}`);
    if (
      guards.length !== 2 ||
      implementations.length !== 2 ||
      guards[0].end > implementations[0].start ||
      implementations[0].end > guards[1].start ||
      guards[1].end > implementations[1].start
    )
      throw new Error("Missing or ambiguous vendor copies");
    const define = cppStructure(source).directives.filter(
      (unit) => unit.text === `#define ${request.macro}`,
    );
    if (
      define.length !== 1 ||
      define[0].start < implementations[0].end ||
      define[0].end > guards[1].start
    )
      throw new Error("Unsupported vendor implementation activation");
    const header =
      source.slice(guards[0].start, guards[0].end) +
      "\n" +
      source.slice(implementations[1].start, implementations[1].end);
    const changes = [
      ...guards.map((unit) => ({ ...unit, text: `#include "${request.file}"\n` })),
      ...implementations.map((unit) => ({ ...unit, text: "" })),
    ].sort((a, b) => a.start - b.start);
    let cursor = 0,
      text = "";
    for (const change of changes) {
      text += source.slice(cursor, change.start) + change.text;
      cursor = change.end;
    }
    return { ...tree, "main.cpp": text + source.slice(cursor), [request.file]: header };
  }
  if (request.action === "vendor-implementation") {
    if (tree["support/stb.cpp"] !== undefined)
      throw new Error("Vendor implementation already extracted");
    const define = cppStructure(source).directives.filter(
      (unit) => unit.text === `#define ${request.macro}`,
    );
    if (define.length !== 1) throw new Error("Missing implementation activation");
    const include = includeDirectives(source).find(
      (unit) => unit.start >= define[0].end && unit.file === "support/stb_image/stb_image_resize.h",
    );
    if (!include || source.slice(define[0].end, include.start).trim())
      throw new Error("Activation is not paired with vendor include");
    return {
      ...tree,
      "main.cpp": source.slice(0, define[0].start) + source.slice(include.end),
      "support/stb.cpp": `#define ${request.macro}\n#include "stb_image/stb_image_resize.h"\n`,
    };
  }
  if (request.action === "cleanup-empty-namespaces") {
    const structure = cppStructure(source);
    const empty = structure.namespaces.filter((namespace) =>
      structure.units
        .filter((unit) => namespace.start < unit.start && unit.end < namespace.end)
        .every((unit) => unit.kind === "using"),
    );
    const spans = empty
      .filter(
        (namespace) =>
          !empty.some(
            (other) =>
              other !== namespace && other.start < namespace.start && namespace.end < other.end,
          ),
      )
      .sort((a, b) => a.start - b.start);
    for (const selector of request.preambleSelectors ?? []) {
      const candidates = structure.units.filter(
        (unit) =>
          unit.kind === "conditional" &&
          !unit.scope &&
          unit.condition === selector.condition &&
          JSON.stringify(includePreambleSelector(source, unit)) === JSON.stringify(selector),
      );
      if (candidates.length !== 1) throw Error("Missing or duplicate include preamble");
      const unit = candidates[0],
        body = source.slice(unit.start, unit.end);
      const moved = Object.entries(tree).some(
        ([file, text]) =>
          file !== "main.cpp" &&
          file.endsWith(".cpp") &&
          cppStructure(text).units.some(
            (candidate) =>
              candidate.kind === "conditional" &&
              !candidate.scope &&
              text.slice(candidate.start, candidate.end).trim() === body.trim(),
          ),
      );
      if (!moved)
        throw Error("Conditional include preamble has not moved to an implementation file");
      spans.push(unit);
    }
    let prefix = "";
    if (request.includes) {
      for (const item of request.includes) {
        if (
          !/^[A-Za-z0-9_./-]+$/.test(item.file) ||
          item.file.startsWith("/") ||
          item.file.split("/").includes("..") ||
          typeof item.quoted !== "boolean"
        )
          throw Error("Unsafe cleanup include");
        prefix += `#include ${item.quoted ? `"${item.file}"` : `<${item.file}>`}\n`;
      }
      spans.push(
        ...structure.directives.filter((item) => !item.scope && /^#\s*include\b/.test(item.text)),
      );
    }
    let cursor = 0,
      text = prefix;
    for (const span of spans.sort((a, b) => a.start - b.start)) {
      if (span.start < cursor) throw Error("Overlapping cleanup targets");
      text += source.slice(cursor, span.start);
      cursor = span.end;
    }
    return compactBlankLines({ ...tree, "main.cpp": text + source.slice(cursor) }).tree;
  }
  throw new Error("Unsupported full structural request");
}

/** Describe a current physical declaration without copying any function body. */
export function physicalSelector(source, unit, definition) {
  const selector = {
    scope: unit.scope || "::",
    declarator: unitDeclarator(source, unit),
    ...(definition === undefined ? {} : { definition }),
  };
  const matches = cppStructure(source, { expandNamespaceConditionals: true }).units.filter(
    (item) =>
      item.scope === unit.scope &&
      unitDeclarator(source, item) === selector.declarator &&
      (definition === undefined || item.definition === definition),
  );
  const occurrence = matches.findIndex((item) => item.start === unit.start);
  if (occurrence < 0)
    throw new Error(
      `Missing selected physical source unit: ${selector.declarator}, definition=${definition}, actual=${unit.definition}`,
    );
  if (matches.length > 1) selector.occurrence = occurrence;
  return selector;
}
