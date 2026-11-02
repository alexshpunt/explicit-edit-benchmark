import assert from "node:assert/strict";
import {
  canonicalizeCpp,
  canonicalizeProject,
  projectMacros,
} from "../grading/canonical-snapshot.mjs";
import { decodeSourceBytes } from "../cpp/source-bytes.mjs";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

function pragmaProtected(source, guard) {
  if (
    typeof source !== "string" ||
    !/^(?:[ \t]*\r?\n)*[ \t]*#[ \t]*pragma[ \t]+once[ \t]*(?:\r?\n|$)/.test(source)
  )
    return false;
  let masked = "",
    cursor = 0;
  for (const token of cppTokens(source)) {
    if (/^[A-Za-z_]\w*$/.test(token.text)) continue;
    masked += source.slice(cursor, token.start) + token.text.replace(/[^\r\n]/g, " ");
    cursor = token.end;
  }
  masked = (masked + source.slice(cursor)).replace(/\\\r?\n/g, "");
  return (
    (masked.match(/^[ \t]*#[ \t]*pragma[ \t]+once\b/gm) ?? []).length === 1 &&
    !new RegExp(
      `^[ \\t]*#[ \\t]*(?:if|ifdef|ifndef|define|undef)\\b[^\\n]*\\b${guard}\\b`,
      "m",
    ).test(masked)
  );
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lexical = (value) => (Buffer.isBuffer(value) ? decodeSourceBytes(value) : value);
const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const units = new Set([
  "function_definition",
  "template_declaration",
  "declaration",
  "field_declaration",
  "class_specifier",
  "struct_specifier",
  "union_specifier",
  "enum_specifier",
  "type_definition",
  "alias_declaration",
  "using_declaration",
  "namespace_alias_definition",
  "static_assert_declaration",
  "linkage_specification",
  "expression_statement",
  "preproc_include",
  "preproc_def",
  "preproc_function_def",
  "preproc_call",
  "ERROR",
]);
const branches = new Set(["preproc_if", "preproc_ifdef", "preproc_elif"]);
const contentKey = (item) => JSON.stringify([item.type, item.key]);
const scopedKey = (item) => JSON.stringify([item.scope, item.type, item.key]);
const signatureKey = (item) =>
  item.identity && ["function_definition", "template_declaration"].includes(item.type)
    ? JSON.stringify([item.scope, item.type, item.identity])
    : null;

function directiveEnd(source, start) {
  let end = start;
  do {
    const newline = source.indexOf("\n", end);
    end = newline < 0 ? source.length : newline + 1;
  } while (end < source.length && /\\\r?\n$/.test(source.slice(start, end)));
  return end;
}

/** Keep complete namespace-level CST units and conditional heads. Never infer
 * ownership from a repeated punctuation leaf or from a declaration name alone.
 */
function atoms(projection, source) {
  const result = [];
  function visit(node, scope) {
    if (!node) return;
    if (node.type === "namespace_definition") {
      scope = [...scope, node.owner ?? node.name ?? ""];
      for (const child of node.children) visit(child, scope);
      return;
    }
    if (branches.has(node.type)) {
      const end = directiveEnd(source, node.start);
      const head = node.children.filter((child) => child.end <= end);
      if (head.length > 1)
        result.push({
          type: `head:${node.type}`,
          key: JSON.stringify(head.map(({ type, key }) => [type, key])),
          identity: null,
          scope,
          start: node.start,
          end,
        });
    }
    if (units.has(node.type)) {
      if (node.type !== "expression_statement" || node.children.some((child) => child.type !== ";"))
        result.push({ ...node, scope });
      return;
    }
    for (const child of node.children) visit(child, scope);
  }
  visit(projection, []);
  return result;
}

function index(items, key) {
  const result = new Map();
  for (const item of items) {
    const value = key(item);
    if (value === null) continue;
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(item);
  }
  return result;
}
function owners(items = []) {
  return new Set(items.flatMap((item) => item.owners ?? []));
}

/** Prepare private structural evidence from immutable current-fragment ranges.
 * The returned assessor never writes source and returns no expected source body.
 */
export async function prepareExtractionStructure(plan) {
  assert.ok(record(plan) && record(plan.initial) && record(plan.expected));
  assert.equal(typeof plan.initial["main.cpp"], "string");
  assert.equal(typeof plan.expected["main.cpp"], "string");
  assert.ok(Array.isArray(plan.tasks) && plan.tasks.length > 0);
  const expectedTree = { ...plan.expected };
  const tasks = plan.tasks.map(({ id, file, kind, fragments, replacement }) => ({
    id,
    file,
    kind,
    fragments,
    replacement,
  }));
  assert.equal(new Set(tasks.map(({ id }) => id)).size, tasks.length);
  assert.equal(new Set(tasks.map(({ file }) => file)).size, tasks.length);
  const ranges = [];
  for (const task of tasks) {
    assert.equal(typeof task.id, "string");
    assert.equal(typeof expectedTree[task.file], "string");
    assert.ok(Array.isArray(task.fragments) && task.fragments.length > 0);
    assert.equal(typeof task.replacement, "string");
    for (const fragment of task.fragments) {
      assert.ok(Number.isSafeInteger(fragment.start) && Number.isSafeInteger(fragment.end));
      assert.ok(
        0 <= fragment.start &&
          fragment.start < fragment.end &&
          fragment.end <= plan.initial["main.cpp"].length,
      );
      assert.equal(plan.initial["main.cpp"].slice(fragment.start, fragment.end), fragment.text);
      ranges.push({ start: fragment.start, end: fragment.end, id: task.id });
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let at = 1; at < ranges.length; at++) assert.ok(ranges[at - 1].end <= ranges[at].start);
  const expected = await canonicalizeProject(expectedTree);
  const macros = projectMacros(Object.values(expectedTree).map(lexical));
  const initialProjection = await canonicalizeCpp(plan.initial["main.cpp"], {
    macros,
    projection: true,
  });
  const residualProjection = await canonicalizeCpp(expectedTree["main.cpp"], {
    macros,
    projection: true,
  });
  const initialAtoms = atoms(initialProjection.projection, plan.initial["main.cpp"]);
  for (const item of initialAtoms)
    item.owners = ranges
      .filter((range) => range.start <= item.start && item.end <= range.end)
      .map(({ id }) => id);
  const initialByScope = index(initialAtoms, scopedKey);
  const initialByContent = index(initialAtoms, contentKey);
  const initialBySignature = index(initialAtoms, signatureKey);
  const residual = atoms(residualProjection.projection, expectedTree["main.cpp"]);
  const residualByScope = index(residual, scopedKey);
  const replacements = new Map();
  for (const task of tasks) {
    if (!task.replacement) continue;
    const projection = await canonicalizeCpp(task.replacement, { macros, projection: true });
    for (const item of atoms(projection.projection, task.replacement)) {
      const key = contentKey(item);
      if (!replacements.has(key)) replacements.set(key, new Set());
      replacements.get(key).add(task.id);
    }
  }
  const taskFiles = new Set(tasks.map(({ file }) => file));
  const expectedPaths = Object.keys(expectedTree).sort(order);

  return async function assess(tree) {
    assert.ok(record(tree));
    const actual = await canonicalizeProject(tree);
    const same = (file) =>
      Object.hasOwn(actual.files, file) && actual.files[file] === expected.files[file];
    const files = tasks.map(({ id, file }) => ({
      id,
      file,
      targetMatched:
        same(file) &&
        (plan.headerProtection !== "pragma-once" ||
          !tasks.some((task) => task.file === file && task.kind === "header") ||
          pragmaProtected(
            lexical(tree[file]),
            plan.headers.find((header) => header.file === file).guard,
          )),
      sourceMatched: true,
    }));
    const byId = new Map(files.map((file) => [file.id, file]));
    const differenceIds = new Set(
      files.filter(({ targetMatched }) => !targetMatched).map(({ id }) => id),
    );
    const diagnostics = [];
    const sourceFailure = (ids, kind, item) => {
      for (const id of ids) {
        byId.get(id).sourceMatched = false;
        differenceIds.add(id);
        diagnostics.push({
          id,
          file: "main.cpp",
          kind,
          ...(item ? { start: item.start, end: item.end } : {}),
        });
      }
    };
    for (const file of files)
      if (!file.targetMatched)
        diagnostics.push({ id: file.id, file: file.file, kind: "destination" });
    const mainMatched = same("main.cpp");
    let mainPreservation = false;
    if (!mainMatched) {
      const source = lexical(tree["main.cpp"]);
      if (typeof source !== "string" || !source.isWellFormed()) {
        sourceFailure(
          tasks.map(({ id }) => id),
          "source-unavailable",
          null,
        );
        mainPreservation = true;
      } else {
        const projection = await canonicalizeCpp(source, { macros, projection: true });
        const current = atoms(projection.projection, source);
        const currentByScope = index(current, scopedKey);
        let explained = false;
        for (const [key, items] of currentByScope) {
          if (items.length <= (residualByScope.get(key)?.length ?? 0)) continue;
          const item = items[0];
          let attributed = owners(initialByScope.get(key));
          if (!attributed.size && replacements.has(contentKey(item)))
            attributed = replacements.get(contentKey(item));
          if (!attributed.size) {
            const candidates = initialByContent.get(contentKey(item)) ?? [];
            if (candidates.length && candidates.every((candidate) => candidate.owners.length))
              attributed = owners(candidates);
          }
          if (!attributed.size) {
            const signature = signatureKey(item);
            const candidates = signature === null ? [] : (initialBySignature.get(signature) ?? []);
            if (candidates.length && candidates.every((candidate) => candidate.owners.length))
              attributed = owners(candidates);
          }
          if (attributed.size === 1) {
            explained = true;
            sourceFailure(attributed, "source-residue", item);
          } else {
            mainPreservation = true;
            if (attributed.size > 1)
              diagnostics.push({
                id: "preservation:main.cpp",
                file: "main.cpp",
                kind: "source-ambiguous",
                candidates: [...attributed].sort(order),
                start: item.start,
                end: item.end,
              });
          }
        }
        for (const [key, items] of residualByScope) {
          if (items.length <= (currentByScope.get(key)?.length ?? 0)) continue;
          const attributed = replacements.get(contentKey(items[0]));
          if (attributed?.size) {
            explained = true;
            sourceFailure(attributed, "source-replacement", null);
          } else mainPreservation = true;
        }
        if (!explained) mainPreservation = true;
      }
      diagnostics.push({ id: "preservation:main.cpp", file: "main.cpp", kind: "residual-main" });
    }
    if (mainPreservation) differenceIds.add("preservation:main.cpp");
    const actualPaths = Object.keys(tree).sort(order);
    const inventoryMatched = JSON.stringify(actualPaths) === JSON.stringify(expectedPaths);
    for (const file of actualPaths)
      if (!Object.hasOwn(expectedTree, file)) {
        differenceIds.add(`inventory:${file}`);
        diagnostics.push({ id: `inventory:${file}`, file, kind: "extra-file" });
      }
    let unrelatedMatched = true;
    for (const file of expectedPaths)
      if (file !== "main.cpp" && !taskFiles.has(file) && !same(file)) {
        unrelatedMatched = false;
        differenceIds.add(`preservation:${file}`);
        diagnostics.push({ id: `preservation:${file}`, file, kind: "unrelated-file" });
      }
    return {
      version: "renderer-module-extraction-structure-v1",
      status:
        mainMatched && inventoryMatched && unrelatedMatched && !differenceIds.size
          ? "pass"
          : "fail",
      files,
      differenceIds: [...differenceIds].sort(order),
      mainMatched,
      inventoryMatched,
      unrelatedMatched,
      diagnostics,
    };
  };
}
