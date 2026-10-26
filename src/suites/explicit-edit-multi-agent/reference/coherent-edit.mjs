import { applyFullStructure, includePreambleSelector } from "./full-structure-edit.mjs";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { headerSpan, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { locateImplementation, moveImplementation } from "./implementation-edit.mjs";

/** Assign temporary forward declarations to the module that now owns their exact
 * definitions. Remove them in that module's goal, before a moved private type makes
 * a leftover main.cpp declaration invalid. Header declarations are never selected.
 */
export function coherentModuleCleanup(tree, file, requests) {
  const units = Object.entries(tree)
    .filter(([name]) => name.endsWith(".cpp"))
    .map(([name, source]) => ({
      file: name,
      source,
      units: cppStructure(source, { expandNamespaceConditionals: true }).units,
    }));
  const key = (source, unit) => JSON.stringify([unit.scope || "::", unitDeclarator(source, unit)]);
  const module = units.find((item) => item.file === file);
  if (!module) throw Error("Missing current implementation module");
  const definitions = new Set(
    module.units.filter((unit) => unit.definition).map((unit) => key(module.source, unit)),
  );
  return requests
    .filter((request) =>
      definitions.has(JSON.stringify([request.selector.scope, request.selector.declarator])),
    )
    .map((request) => {
      const selected = JSON.stringify([request.selector.scope, request.selector.declarator]);
      const owners = units.filter((item) =>
        item.units.some(
          (unit) =>
            unit.kind === "declaration" && !unit.definition && key(item.source, unit) === selected,
        ),
      );
      if (owners.length !== 1) throw Error("Missing or ambiguous module temporary declaration");
      return { ...request, file: owners[0].file };
    });
}
/** Apply a current public module selector, without requiring the old atomic prompt
 * text. Vendor selectors must choose declarations copy 1, implementation copy 2
 * and support/stb.cpp activation; missing choices cannot silently use a reference.
 * The pinned header editor still uses its legacy parser internally; its input
 * here is built only from the delivered guard, filename and include requirements.
 */
export function applyCoherentStructure(tree, request) {
  return applyStructure(tree, request, false);
}

/** A current editor can find a temporary prototype already absent after a peer
 * write. Unlike preparation, it may leave that source for the normal output gate.
 */
export function applyCurrentStructure(tree, request, options) {
  return applyStructure(tree, request, true, options);
}

const vendorHeaderFile = "support/stb_image/stb_image_resize.h";
const vendorImplementationFile = "support/stb.cpp";
const identifier = (name) => typeof name === "string" && /^[A-Za-z_]\w*$/.test(name);

function replaceSpans(source, changes) {
  let result = "",
    cursor = 0;
  for (const change of changes.sort((a, b) => a.start - b.start)) {
    if (change.start < cursor) throw Error("Overlapping current structural targets");
    result += source.slice(cursor, change.start) + change.text;
    cursor = change.end;
  }
  return result + source.slice(cursor);
}

function mainHeaderInclude(tree, file) {
  return includeDirectives(tree["main.cpp"]).some((item) => item.quoted && item.file === file)
    ? tree
    : { ...tree, "main.cpp": `#include "${file}"\n` + tree["main.cpp"] };
}

function activationDirectives(source, macro) {
  const pattern = new RegExp(`^#\\s*define\\s+${macro}(?:\\s|$)`);
  const selected = cppStructure(source).directives.filter((unit) => pattern.test(unit.text));
  if (selected.length > 1 || selected.some((unit) => unit.text !== `#define ${macro}`))
    throw Error("Ambiguous current vendor activation");
  return selected;
}

function currentVendorImplementation(tree, request) {
  if (request.file !== vendorImplementationFile || !identifier(request.macro))
    throw Error("Unsupported current vendor activation");
  const header = tree[vendorHeaderFile];
  if (
    typeof header !== "string" ||
    !cppStructure(header).units.some((unit) => unit.condition === `#ifdef ${request.macro}`)
  )
    throw Error("Missing current vendor header implementation");
  const existing = tree[vendorImplementationFile];
  if (existing !== undefined) {
    const definitions = activationDirectives(existing, request.macro);
    const includes = includeDirectives(existing).filter(
      (item) => item.quoted && item.file === "stb_image/stb_image_resize.h",
    );
    if (
      definitions.length !== 1 ||
      includes.length !== 1 ||
      definitions[0].end > includes[0].start ||
      existing.slice(definitions[0].end, includes[0].start).trim()
    )
      throw Error("Unsupported current vendor implementation destination");
  }
  const source = tree["main.cpp"];
  const [define] = activationDirectives(source, request.macro);
  let main = source;
  if (define) {
    const include = includeDirectives(source).find(
      (unit) => unit.start >= define.end && unit.quoted && unit.file === vendorHeaderFile,
    );
    const end =
      include && !source.slice(define.end, include.start).trim() ? include.end : define.end;
    main = source.slice(0, define.start) + source.slice(end);
  }
  const after = {
    ...tree,
    "main.cpp": main,
    [vendorImplementationFile]:
      existing ?? `#define ${request.macro}\n#include "stb_image/stb_image_resize.h"\n`,
  };
  return mainHeaderInclude(after, vendorHeaderFile);
}

function currentVendorHeader(tree, request) {
  if (request.file !== vendorHeaderFile || !identifier(request.guard) || !identifier(request.macro))
    throw Error("Unsupported current vendor header target");
  if (tree[vendorHeaderFile] === undefined) return applyFullStructure(tree, request);
  const destination = cppStructure(tree[vendorHeaderFile]).units;
  const guarded = destination.filter((unit) => unit.condition === `#ifndef ${request.guard}`);
  const implemented = destination.filter((unit) => unit.condition === `#ifdef ${request.macro}`);
  if (guarded.length !== 1 || implemented.length !== 1 || guarded[0].end > implemented[0].start)
    throw Error("Unsupported current vendor header destination");
  const source = tree["main.cpp"];
  const units = cppStructure(source).units;
  const guards = units.filter((unit) => unit.condition === `#ifndef ${request.guard}`);
  const implementations = units.filter((unit) => unit.condition === `#ifdef ${request.macro}`);
  if (guards.length > 2 || implementations.length > 2)
    throw Error("Ambiguous current vendor source copies");
  activationDirectives(source, request.macro);
  const changes = [
    ...guards.map((unit) => ({ ...unit, text: `#include "${request.file}"\n` })),
    ...implementations.map((unit) => ({ ...unit, text: "" })),
  ];
  let after = mainHeaderInclude(
    { ...tree, "main.cpp": replaceSpans(source, changes) },
    vendorHeaderFile,
  );
  // An ordinary racing monolith write can resurrect an activation already
  // moved by a peer. Its current destination supplies the public activation;
  // no future operation or saved source body is needed to remove that duplicate.
  if (tree[vendorImplementationFile] !== undefined)
    after = currentVendorImplementation(after, {
      file: vendorImplementationFile,
      macro: request.macro,
    });
  return after;
}

function currentCleanup(tree, request) {
  const requested = request.preambleSelectors ?? [];
  if (
    !Array.isArray(requested) ||
    new Set(requested.map((selector) => JSON.stringify(selector))).size !== requested.length
  )
    throw Error("Invalid current include preamble selectors");
  const source = tree["main.cpp"];
  const structure = cppStructure(source);
  const matches = (text, units, selector) =>
    units.filter(
      (unit) =>
        unit.kind === "conditional" &&
        !unit.scope &&
        unit.condition === selector.condition &&
        JSON.stringify(includePreambleSelector(text, unit)) === JSON.stringify(selector),
    );
  const remaining = requested.filter((selector) => {
    const selected = matches(source, structure.units, selector);
    if (selected.length > 1) throw Error("Ambiguous current include preamble");
    if (selected.length) return true;
    const moved = Object.entries(tree).some(
      ([file, text]) =>
        file !== "main.cpp" &&
        file.endsWith(".cpp") &&
        matches(text, cppStructure(text).units, selector).length === 1,
    );
    if (!moved) throw Error("Missing current include preamble and destination");
    return false;
  });
  return applyFullStructure(tree, { ...request, preambleSelectors: remaining });
}
function applyStructure(tree, request, allowMissing, options) {
  if (
    request.action === "vendor-header" &&
    (request.declarationsCopy !== 1 || request.implementationCopy !== 2)
  )
    throw Error("Missing or unsupported vendor copy selection");
  if (request.action === "vendor-implementation" && request.file !== "support/stb.cpp")
    throw Error("Unsupported vendor implementation activation file");
  if (allowMissing) {
    if (request.action === "implementation")
      return moveImplementation(tree, request, {
        allowMoved: true,
        resolution: options?.implementation,
      });
    if (request.action === "vendor-header") return currentVendorHeader(tree, request);
    if (request.action === "vendor-implementation")
      return currentVendorImplementation(tree, request);
    if (request.action === "cleanup-empty-namespaces") return currentCleanup(tree, request);
  }
  if (request.action === "remove-generated-declaration" && (request.file || allowMissing)) {
    const file = request.file ?? "main.cpp";
    if (!/^[A-Za-z_]\w*\.cpp$/.test(file)) throw Error("Unsafe cleanup owner file");
    const source = tree[file];
    const unit = locateImplementation(
      source,
      request.selector,
      cppStructure(source, { expandNamespaceConditionals: true }),
      { allowMissing: allowMissing && request.selector.definition === false },
    );
    // A peer can already have removed this temporary prototype. This is only
    // an editor no-op; the normal output gate still decides whether it is done.
    if (!unit) return tree;
    if (unit.definition || !source.slice(unit.start, unit.end).trimEnd().endsWith(";"))
      throw Error("Cleanup target is not a temporary declaration");
    return { ...tree, [file]: source.slice(0, unit.start) + source.slice(unit.end) };
  }
  if (request.action !== "header") return applyFullStructure(tree, request);
  if (!/^[A-Za-z_]\w*$/.test(request.guard) || !/^[A-Za-z_]\w*\.h$/.test(request.file))
    throw Error("Unsafe current header target");
  const current = {
    ...request,
    prompt: `Move the complete project header block guarded by \`${request.guard}\` from \`main.cpp\` into \`${request.file}\`.\nDirect project includes: ${JSON.stringify(request.includes)}\n`,
  };
  if (allowMissing && tree[request.file] !== undefined) {
    const remaining = headerSpan(tree["main.cpp"], request.guard, { allowMissing: true });
    if (remaining) {
      // A racing monolith write can restore the old block after its header was
      // created. Extract that current block, preserving the existing peer file.
      const { [request.file]: existing, ...source } = tree;
      return { ...applyFullStructure(source, current), [request.file]: existing };
    }
    const included = Object.values(tree).some((source) =>
      includeDirectives(source).some((include) => include.quoted && include.file === request.file),
    );
    return included
      ? tree
      : { ...tree, "main.cpp": `#include "${request.file}"\n` + tree["main.cpp"] };
  }
  return applyFullStructure(tree, current);
}
