import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { referenceBindingLocations } from "../generation/reference-route.mjs";
import { joinedProject } from "../cpp/joined-project.mjs";
import {
  projectAst,
  anonymousRecordAliases,
  declarationContexts,
  writtenFunctionSignatures,
  isFunctionInstantiation,
} from "../cpp/compiler-ast.mjs";
import { restorationTargets } from "./restoration-targets.mjs";

const types = new Set([
  "CXXRecordDecl",
  "ClassTemplateSpecializationDecl",
  "RecordDecl",
  "EnumDecl",
  "TypedefDecl",
  "TypeAliasDecl",
]);
const functions = new Set([
  "FunctionDecl",
  "CXXMethodDecl",
  "CXXConstructorDecl",
  "CXXDestructorDecl",
]);

async function descriptors(tree, directory) {
  const image = joinedProject(tree),
    bytes = Buffer.from(image.source);
  const source = path.join(directory, "owners.cpp");
  await writeFile(source, image.source);
  const roots = await projectAst(source, ["-std=c++17", "-pthread"]);
  const entries = new Map();
  const aliases = anonymousRecordAliases(roots);
  const contexts = declarationContexts(roots, aliases);
  const signatures = writtenFunctionSignatures(roots);
  const physical = (node) => {
    const offset = node.loc?.offset;
    if (
      !Number.isInteger(offset) ||
      !node.name ||
      bytes.subarray(offset, offset + Buffer.byteLength(node.name)).toString() !== node.name
    )
      return;
    const site = image.physical(offset, Buffer.byteLength(node.name));
    return { key: JSON.stringify([site.file, site.start]), name: node.name };
  };
  function visit(node, parents = [], outer) {
    if (isFunctionInstantiation(node, signatures)) return;
    if (node.parentDeclContextId)
      parents = contexts
        .get(node.parentDeclContextId)
        .map((context) => physical(context) ?? { key: context.id, name: context.name });
    const own = physical(aliases.get(node.id) ?? node);
    let role;
    if (["VarDecl", "ParmVarDecl"].includes(node.kind)) role = "variable";
    else if (node.kind === "FieldDecl") role = "field";
    else if (types.has(node.kind)) role = "type";
    else if (["FunctionDecl", "CXXMethodDecl"].includes(node.kind)) role = "function";
    const nextParents =
      own && ["NamespaceDecl", ...types, ...functions].includes(node.kind)
        ? [...parents, own]
        : parents;
    const owner =
      outer ??
      (functions.has(node.kind)
        ? {
            parts: nextParents,
            signature: signatures.get(node.loc?.offset) ?? node.type?.qualType,
            definition: (node.inner ?? []).some((child) => child.kind === "CompoundStmt"),
          }
        : undefined);
    if (own && role && !node.isImplicit && !entries.has(own.key))
      entries.set(own.key, { role, parents, own, owner });
    for (const child of node.inner ?? []) visit(child, nextParents, owner);
  }
  for (const root of roots) visit(root);
  return entries;
}

/** Prepare exact public owners from compiler declarations in private phase-start references.
 * Coordinates only join trusted declaration origins to current AST nodes. They never leave
 * preparation. Nested types and fields retain an outer function signature, and ancestor names
 * follow earlier requests by physical declaration identity, not spelling-wide replacements.
 */
export async function prepareNameOwners(payload, manifest, directory) {
  await mkdir(directory);
  const targets = restorationTargets(manifest),
    selectors = new Map();
  for (const category of ["locals-parameters", "fields", "functions-types"]) {
    const phase = referenceBindingLocations(payload, manifest, category);
    const current = await descriptors(phase.tree, directory);
    const renamed = new Map();
    const scope = (parts) => parts.map((part) => renamed.get(part.key) ?? part.name).join("::");
    for (const group of targets.naming.filter((item) => item.category === category)) {
      const selected = new Map();
      const changes = [];
      for (const family of group.families) {
        const sites = phase.families.get(family.id);
        if (!sites?.length) throw Error("Missing physical naming family");
        for (const site of sites) {
          const key = JSON.stringify([site.file, site.start]),
            entry = current.get(key);
          if (!entry) throw Error(`Missing compiler owner for ${family.from}`);
          const local = ["local", "parameter"].includes(family.role);
          const selector = local
            ? {
                kind: "function",
                scope: scope(entry.owner?.parts ?? []),
                signature: entry.owner?.signature,
                definition: entry.owner?.definition,
              }
            : family.role === "field"
              ? { kind: "record", scope: scope(entry.parents) }
              : { kind: family.role, scope: scope([...entry.parents, entry.own]) };
          if (!local && entry.owner)
            selector.owner = {
              scope: scope(entry.owner.parts),
              signature: entry.owner.signature,
              definition: entry.owner.definition,
            };
          if (!selector.scope || (local && !selector.signature))
            throw Error(
              `Missing current owner signature: ${family.role} ${family.from}, ${JSON.stringify(entry)}`,
            );
          if (selector.owner?.signature && /\bat\s|[/\\]|@\d|:\d/.test(selector.owner.signature))
            throw Error("Unsafe nested owner signature");
          selected.set(JSON.stringify(selector), selector);
          changes.push([key, family.to]);
        }
      }
      selectors.set(group.id, [...selected.values()]);
      for (const [key, name] of changes) renamed.set(key, name);
    }
  }
  await writeFile(
    path.join(directory, "selectors.json"),
    JSON.stringify([...selectors], null, 2) + "\n",
  );
  return (group) => {
    const selected = selectors.get(group.id);
    if (!selected?.length) throw Error("Missing prepared owner group");
    return selected;
  };
}
