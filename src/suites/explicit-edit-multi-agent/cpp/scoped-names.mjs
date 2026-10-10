import path from "node:path";
import { writeFile } from "node:fs/promises";
import { joinedProject } from "./joined-project.mjs";
import {
  projectAst,
  anonymousRecordAliases,
  declarationContexts,
  writtenFunctionSignatures,
  isFunctionInstantiation,
} from "./compiler-ast.mjs";
import { variableBindingEdits } from "../generation/semantic-names.mjs";
import { semanticSession } from "./clangd-renames.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";

function selectedDeclarations(
  roots,
  requests,
  source,
  renamed,
  origin,
  onDeclaration,
  allowAbsentOwners = false,
) {
  const bytes = Buffer.from(source),
    selections = [];
  const aliases = anonymousRecordAliases(roots);
  const contexts = declarationContexts(roots, aliases);
  const isFunction = (node) =>
    ["FunctionDecl", "CXXMethodDecl", "CXXConstructorDecl", "CXXDestructorDecl"].includes(
      node.kind,
    );
  const typeKinds = new Set([
    "CXXRecordDecl",
    "ClassTemplateSpecializationDecl",
    "RecordDecl",
    "EnumDecl",
    "TypedefDecl",
    "TypeAliasDecl",
  ]);
  const signatures = writtenFunctionSignatures(roots);
  function visit(node, scope = "", owner) {
    if (isFunctionInstantiation(node, signatures)) return;
    if (node.parentDeclContextId)
      scope = contexts
        .get(node.parentDeclContextId)
        .map((parent) => renamed.get(parent.loc?.offset) ?? parent.name)
        .join("::");
    const namedNode = aliases.get(node.id) ?? node;
    const currentName = renamed.get(namedNode.loc?.offset) ?? namedNode.name;
    const functionOwner =
      owner ??
      (isFunction(node)
        ? {
            scope: [scope, currentName].filter(Boolean).join("::"),
            signature: signatures.get(node.loc?.offset) ?? node.type?.qualType,
            definition: (node.inner ?? []).some((child) => child.kind === "CompoundStmt"),
          }
        : undefined);
    const fullName = [scope, currentName].filter(Boolean).join("::");
    let role;
    if (["VarDecl", "ParmVarDecl"].includes(node.kind)) role = "variable";
    else if (node.kind === "FieldDecl") role = "field";
    else if (typeKinds.has(node.kind)) role = "type";
    else if (["FunctionDecl", "CXXMethodDecl"].includes(node.kind)) role = "function";
    const offset = node.loc?.offset;
    if (
      role &&
      !node.isImplicit &&
      Number.isInteger(offset) &&
      /^[A-Za-z_]\w*$/.test(node.name ?? "") &&
      bytes.subarray(offset, offset + Buffer.byteLength(node.name)).toString("utf8") === node.name
    ) {
      onDeclaration?.({ offset, name: node.name, role, scope: fullName, owner: functionOwner });
      for (const request of requests) {
        const mapping = request.mapping.find((item) => item.from === node.name);
        if (!mapping) continue;
        const matches = request.selectors?.some((selector) => {
          if (
            selector.owner &&
            (functionOwner?.scope !== selector.owner.scope ||
              functionOwner.signature !== selector.owner.signature ||
              (typeof selector.owner.definition === "boolean" &&
                functionOwner.definition !== selector.owner.definition))
          )
            return false;
          if (request.category === "locals-parameters") {
            if (role !== "variable") return false;
            if (selector.kind === "function")
              return (
                functionOwner?.scope === selector.scope &&
                functionOwner.signature === selector.signature &&
                (typeof selector.definition !== "boolean" ||
                  functionOwner.definition === selector.definition)
              );
            return selector.kind === "variable" && fullName === selector.scope;
          }
          if (request.category === "fields")
            return role === "field" && selector.kind === "record" && scope === selector.scope;
          return selector.kind === role && fullName === selector.scope;
        });
        const helper =
          request.category === "helpers" &&
          ((role === "variable" && !functionOwner) || (node.kind === "FunctionDecl" && !owner)) &&
          origin(offset, Buffer.byteLength(node.name)).file === request.file;
        if (matches || helper)
          selections.push({
            name: node.name,
            newName: mapping.to,
            offset,
            role,
            family: request.id ?? request.target,
          });
      }
    }
    let nested = scope;
    if (node.kind === "NamespaceDecl" || typeKinds.has(node.kind) || isFunction(node))
      nested = [scope, currentName].filter(Boolean).join("::");
    for (const child of node.inner ?? []) visit(child, nested, functionOwner);
  }
  for (const root of roots) visit(root);
  const physical = new Map();
  for (const selection of selections) {
    const previous = physical.get(selection.offset);
    if (
      previous &&
      (previous.family !== selection.family || previous.newName !== selection.newName)
    )
      throw new Error("Conflicting selected physical bindings");
    physical.set(selection.offset, selection);
  }
  const selected = [...physical.values()];
  for (const request of requests) {
    for (const mapping of request.mapping) {
      if (
        !allowAbsentOwners &&
        !selected.some(
          (entry) => entry.family === (request.id ?? request.target) && entry.name === mapping.from,
        )
      )
        throw new Error(`Missing current owner/signature binding: ${mapping.from}`);
    }
  }
  return selected;
}

/** Refresh public owner selectors for trusted preparation after earlier type moves
 * or renames. Origins come from compiler-selected declarations in the same evolving
 * project, not saved answers. Neither these origins nor AST bodies reach the agent.
 */
export async function currentNamingSelectors(tree, groups, directory) {
  const image = joinedProject(tree);
  const sourcePath = path.join(directory, "current.cpp");
  await writeFile(sourcePath, image.source);
  const roots = await projectAst(sourcePath, ["-std=c++17", "-pthread"]);
  const declarations = new Map();
  const wanted = new Set(
    groups.flat().map((origin) => JSON.stringify([origin.file, origin.start, origin.role])),
  );
  selectedDeclarations(roots, [], image.source, new Map(), image.physical, (entry) => {
    const site = image.physical(entry.offset, Buffer.byteLength(entry.name));
    const key = JSON.stringify([site.file, site.start, entry.role]);
    if (!wanted.has(key)) return;
    const selector = {
      kind: entry.role,
      scope: entry.scope,
      ...(entry.owner ? { owner: entry.owner } : {}),
    };
    const previous = declarations.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(selector))
      throw Error(
        `Ambiguous current declaration owner: ${key}, ${JSON.stringify(previous)} versus ${JSON.stringify(selector)}`,
      );
    declarations.set(key, selector);
  });
  return groups.map((origins) => {
    const selectors = new Map();
    for (const origin of origins) {
      const selector = declarations.get(JSON.stringify([origin.file, origin.start, origin.role]));
      if (!selector) throw Error("Missing refreshed current declaration owner");
      selectors.set(JSON.stringify(selector), selector);
    }
    return [...selectors.values()];
  });
}
/** Open a current compiler snapshot for a single naming batch. Only the next
 * delivered request is selected. No future requests, inverse records or answers enter this session.
 * Close it before grading; the next batch reparses the actual evolving workspace.
 * Optional onSelection receives current declaration origins for trusted module grouping;
 * it does not alter selected bindings or expose saved restoration locations.
 * allowAbsentOwners is for callers merging separate translation units: that caller
 * must reject any mapping missing from the combined plans. Ordinary sessions stay strict.
 */
export async function scopedNamingSession(
  tree,
  directory,
  { file, onSelection, allowAbsentOwners = false } = {},
) {
  const image = joinedProject(tree, file ? [file] : undefined);
  const sourcePath = path.join(directory, "current.cpp");
  await writeFile(sourcePath, image.source);
  const flags = ["-std=c++17", "-pthread"];
  const roots = await projectAst(sourcePath, flags);
  let compiler;
  const consumed = new Set();
  const renamed = new Map();
  return {
    close: () => compiler?.close(),
    async plan(request) {
      if (request.category === "helpers" && request.file !== file)
        throw new Error("File-local helper needs its own compiler snapshot");
      const selection = selectedDeclarations(
        roots,
        [request],
        image.source,
        renamed,
        image.physical,
        undefined,
        allowAbsentOwners,
      );
      onSelection?.(
        selection.map((entry) => ({
          ...image.physical(entry.offset, Buffer.byteLength(entry.name)),
          role: entry.role,
        })),
      );
      if (allowAbsentOwners && !selection.length)
        return { id: request.id ?? request.target, edits: [] };
      const local = selection.filter((entry) => entry.role === "variable");
      const semantic = selection.filter((entry) => entry.role !== "variable");
      if (semantic.length) compiler ??= await semanticSession(sourcePath, image.source, flags);
      const edits = [
        ...(local.length ? variableBindingEdits(roots, local, image.source) : []),
        ...(semantic.length ? await compiler.edits(semantic) : []),
      ];
      const physical = new Map();
      for (const edit of edits) {
        if (edit.families.length !== 1) throw new Error("Compiler binding crosses requests");
        const byteStart = Buffer.byteLength(image.source.slice(0, edit.start));
        const site = image.physical(byteStart, Buffer.byteLength(edit.old));
        if (tree[site.file].slice(site.start, site.start + edit.old.length) !== edit.old)
          throw new Error("Physical compiler origin differs");
        const key = JSON.stringify([site.file, site.start]);
        const previous = physical.get(key);
        if (previous && (previous.old !== edit.old || previous.new !== edit.new))
          throw new Error("Repeated header binding conflict");
        if (consumed.has(key)) throw new Error("Binding already changed by an earlier request");
        physical.set(key, { ...site, old: edit.old, new: edit.new });
      }
      if (!physical.size) throw new Error("Empty current naming request");
      for (const key of physical.keys()) consumed.add(key);
      for (const entry of selection)
        if (["type", "function"].includes(entry.role)) renamed.set(entry.offset, entry.newName);
      return { id: request.id ?? request.target, edits: [...physical.values()] };
    },
  };
}

/** Plan a bounded, same-category batch for regression tests; live delivery uses the session directly. */
export async function scopedNamingPlan(tree, requests, directory) {
  if (
    !Array.isArray(requests) ||
    !requests.length ||
    requests.length > 20 ||
    new Set(requests.map((request) => request.category)).size !== 1
  )
    throw new Error("Invalid naming batch");
  const session = await scopedNamingSession(tree, directory, {
    file: requests[0].category === "helpers" ? requests[0].file : undefined,
  });
  try {
    const plans = [];
    for (const request of requests) plans.push(await session.plan(request));
    return plans;
  } finally {
    session.close();
  }
}

/** Apply one planned request against its unchanged batch snapshot and already delivered
 * edits. Offsets are live compiler origins, never canonical generation locations.
 */
export function applyScopedNamePlan(tree, plan, applied = []) {
  const byFile = new Map();
  for (const edit of plan.edits) {
    const earlier = applied
      .flatMap((item) => item.edits)
      .filter((item) => item.file === edit.file && item.start < edit.start);
    const start =
      edit.start + earlier.reduce((sum, item) => sum + item.new.length - item.old.length, 0);
    if (!byFile.has(edit.file)) byFile.set(edit.file, []);
    byFile.get(edit.file).push({ ...edit, start });
  }
  const next = { ...tree };
  for (const [file, edits] of byFile) {
    const source = tree[file];
    let cursor = 0,
      text = "";
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      if (
        edit.start < cursor ||
        source.slice(edit.start, edit.start + edit.old.length) !== edit.old
      )
        throw new Error("Stale or overlapping current binding edit");
      text += source.slice(cursor, edit.start) + edit.new;
      cursor = edit.start + edit.old.length;
    }
    next[file] = text + source.slice(cursor);
    assertNeutralSource(file, next[file]);
  }
  return next;
}
