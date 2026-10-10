import { applyFullStructure } from "./full-structure-edit.mjs";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { locateImplementation } from "./implementation-edit.mjs";

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
  if (
    request.action === "vendor-header" &&
    (request.declarationsCopy !== 1 || request.implementationCopy !== 2)
  )
    throw Error("Missing or unsupported vendor copy selection");
  if (request.action === "vendor-implementation" && request.file !== "support/stb.cpp")
    throw Error("Unsupported vendor implementation activation file");
  if (request.action === "remove-generated-declaration" && request.file) {
    if (!/^[A-Za-z_]\w*\.cpp$/.test(request.file)) throw Error("Unsafe cleanup owner file");
    const source = tree[request.file];
    const unit = locateImplementation(
      source,
      request.selector,
      cppStructure(source, { expandNamespaceConditionals: true }),
    );
    if (unit.definition || !source.slice(unit.start, unit.end).trimEnd().endsWith(";"))
      throw Error("Cleanup target is not a temporary declaration");
    return { ...tree, [request.file]: source.slice(0, unit.start) + source.slice(unit.end) };
  }
  if (request.action !== "header") return applyFullStructure(tree, request);
  if (!/^[A-Za-z_]\w*$/.test(request.guard) || !/^[A-Za-z_]\w*\.h$/.test(request.file))
    throw Error("Unsafe current header target");
  return applyFullStructure(tree, {
    ...request,
    prompt: `Move the complete project header block guarded by \`${request.guard}\` from \`main.cpp\` into \`${request.file}\`.\nDirect project includes: ${JSON.stringify(request.includes)}\n`,
  });
}
