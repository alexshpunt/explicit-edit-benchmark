import { projectAst } from "../cpp/compiler-ast.mjs";
import { byteToCharacter } from "../cpp/cpp-offsets.mjs";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";

const functions = new Set(["FunctionDecl", "FunctionTemplateDecl"]);
const types = new Set([
  "CXXRecordDecl",
  "RecordDecl",
  "ClassTemplateDecl",
  "EnumDecl",
  "TypedefDecl",
  "TypeAliasDecl",
]);

/** Inventory physical implementation units using the current compiler bindings and a
 * complete lexical scan. Conditional branches remain whole, including inactive code.
 * Private type and inactive-code dependencies are conservatively connected by spelling;
 * physical edits still require unique owner/signature selectors, never spelling-wide edits.
 */
export async function implementationInventory(sourcePath, source, file, flags) {
  const roots = await projectAst(sourcePath, flags);
  const structure = cppStructure(source);
  const characterOffset = byteToCharacter(source);
  const offset = (location) => {
    const site = location?.spellingLoc ?? location;
    return Number.isInteger(site?.offset) ? characterOffset(site.offset) : undefined;
  };
  const firstNamespace = Math.min(...structure.namespaces.map((item) => item.start));
  if (!Number.isFinite(firstNamespace)) throw new Error("Missing implementation namespace");
  const physical = structure.units.filter(
    (unit) =>
      unit.kind !== "using" &&
      (unit.scope || (unit.kind === "conditional" && unit.start > firstNamespace)),
  );
  const nodes = new Map(),
    owners = new Map();
  function collect(node) {
    if (node.id) nodes.set(node.id, node);
    const start = offset(node.loc);
    if (start !== undefined && !node.loc?.includedFrom) {
      const index = physical.findIndex((unit) => unit.start <= start && start < unit.end);
      if (index >= 0 && node.id) owners.set(node.id, index);
    }
    for (const child of node.inner ?? []) collect(child);
  }
  for (const root of roots) collect(root);
  const units = physical.map((unit, order) => {
    let selector, declaration;
    if (unit.kind === "conditional")
      selector = { kind: "conditional", scope: unit.scope || "::", condition: unit.condition };
    else {
      const candidates = [...nodes.values()]
        .filter((node) => {
          const start = offset(node.range?.begin),
            end = offset(node.range?.end);
          return (
            !node.isImplicit &&
            start !== undefined &&
            end !== undefined &&
            unit.start <= start &&
            end < unit.end &&
            (functions.has(node.kind) || types.has(node.kind) || node.kind === "VarDecl")
          );
        })
        .sort(
          (a, b) =>
            offset(a.range.begin) - offset(b.range.begin) ||
            offset(b.range.end) - offset(a.range.end),
        );
      declaration = candidates[0];
      if (!declaration)
        throw new Error(
          `Lexical unit has no compiler owner in ${file}: ${source.slice(unit.start, unit.start + 90)}`,
        );
      if (["FunctionTemplateDecl", "ClassTemplateDecl"].includes(declaration.kind))
        declaration = declaration.inner.find((child) =>
          ["FunctionDecl", "CXXRecordDecl"].includes(child.kind),
        );
      if (!declaration?.name) throw new Error("Missing implementation declaration name");
      selector = {
        kind: functions.has(declaration.kind)
          ? "function"
          : types.has(declaration.kind)
            ? "type"
            : "variable",
        scope: unit.scope,
        name: declaration.name,
      };
      if (selector.kind === "function") {
        selector.signature = declaration.type.qualType;
        selector.definition = (declaration.inner ?? []).some(
          (child) => child.kind === "CompoundStmt",
        );
      }
    }
    selector.declarator = unitDeclarator(source, unit);
    let previous = declaration?.previousDecl;
    while (previous && nodes.has(previous)) previous = nodes.get(previous).previousDecl;
    return {
      id: `${file}:${order}`,
      file,
      order,
      selector,
      references: [],
      headerDeclared: !!previous && declaration?.storageClass !== "static",
      physical: unit,
      context: unit.using,
    };
  });
  function canonical(id) {
    const visited = new Set();
    while (nodes.get(id)?.previousDecl) {
      if (visited.has(id)) throw new Error("Cyclic compiler redeclarations");
      visited.add(id);
      id = nodes.get(id).previousDecl;
    }
    return id;
  }
  const families = new Map();
  for (const [id, owner] of owners) {
    const family = canonical(id);
    if (!families.has(family)) families.set(family, new Set());
    families.get(family).add(owner);
  }
  for (const indices of families.values()) {
    if (indices.size < 2) continue;
    for (const a of indices)
      for (const b of indices) if (a !== b) units[a].references.push(units[b].id);
  }
  const external = new Set();
  function references(node, owner) {
    if (owners.has(node.id)) owner = owners.get(node.id);
    if (owner !== undefined && node.referencedDecl?.id) {
      const targets = families.get(canonical(node.referencedDecl.id));
      if (targets)
        for (const target of targets) {
          if (target !== owner) units[owner].references.push(units[target].id);
        }
      else {
        const id = `external:${node.referencedDecl.id}`;
        external.add(id);
        units[owner].references.push(id);
      }
    }
    for (const child of node.inner ?? []) references(child, owner);
  }
  for (const root of roots) references(root);
  // Clang's JSON omits many type-use edges and all inactive branches. Conservative
  // edges only widen a dependency group; they never authorize an edit by spelling.
  for (const unit of units) {
    const words = new Set(
      cppTokens(source.slice(unit.physical.start, unit.physical.end)).map((token) => token.text),
    );
    for (const target of units) {
      if (target.id === unit.id || target.headerDeclared || !target.selector.name) continue;
      if (
        (target.selector.kind === "type" || unit.selector.kind === "conditional") &&
        words.has(target.selector.name)
      )
        unit.references.push(target.id);
    }
    unit.references = [...new Set(unit.references)].sort();
  }
  const preamble = source.slice(0, firstNamespace);
  // Root-level declarations cannot silently disappear into a namespace-only plan.
  for (const unit of structure.units.filter((item) => !item.scope && !physical.includes(item))) {
    if (
      unit.end > firstNamespace ||
      unit.kind !== "conditional" ||
      source
        .slice(unit.start, unit.end)
        .replace(/^\s*#(?:if\w*|endif|else|elif|include)\b[^\n]*(?:\n|$)/gm, "")
        .trim()
    )
      throw new Error(`Unsupported root-level implementation unit: ${file}`);
  }
  return {
    units,
    external: [...external].sort(),
    preamble,
    includes: includeDirectives(preamble).map(({ file: name, quoted }) => ({ file: name, quoted })),
  };
}
