import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  cppTokens,
  treeIdentity,
  writeTree,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { projectAst } from "../../../src/suites/explicit-edit-multi-agent/cpp/compiler-ast.mjs";
import { referenceRoute } from "../../../src/suites/explicit-edit-multi-agent/generation/reference-route.mjs";
import { reverseOperation } from "../../../src/suites/explicit-edit-multi-agent/generation/inverse.mjs";
import {
  neutralSourcePath,
  assertNeutralSource,
} from "../../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";

const flags = ["-std=c++17", "-pthread"];
const stepId = (index) => `step-${String(index + 1).padStart(2, "0")}`;

/** Resolve cumulative obligations. A changed obligation must explicitly replace its predecessor. */
export function resolveObligations(steps) {
  const active = new Map();
  const result = [];
  let namesStarted = false;
  for (const [index, step] of steps.entries()) {
    if (step.id !== stepId(index)) throw new Error("Missing, duplicate or reordered step");
    if (!step.prompt?.trim()) throw new Error("Missing request prompt");
    assertNeutralSource("request", step.prompt);
    if (JSON.stringify(step.dependsOn) !== JSON.stringify(index ? [stepId(index - 1)] : []))
      throw new Error("Unresolved request dependency");
    if (!["structure", "names"].includes(step.phase) || (namesStarted && step.phase !== "names"))
      throw new Error("Structure must precede names phase");
    namesStarted ||= step.phase === "names";
    const keys = step.adds.map((item) => item.key);
    if (new Set(keys).size !== keys.length || new Set(step.replaces).size !== step.replaces.length)
      throw new Error("Duplicate obligation");
    for (const key of step.replaces)
      if (!active.has(key) || !keys.includes(key))
        throw new Error("Invalid obligation replacement");
    for (const item of step.adds) {
      if (!item.key || item.value === undefined) throw new Error("Missing obligation target");
      if (active.has(item.key) && !step.replaces.includes(item.key))
        throw new Error("Contradictory obligation without replacement");
      active.set(item.key, item.value);
    }
    result.push(structuredClone(Object.fromEntries(active)));
  }
  return result;
}

function syntaxTokens(source) {
  const tokens = [];
  let cursor = 0;
  for (const token of cppTokens(source)) {
    for (const match of source.slice(cursor, token.start).matchAll(/\S/g))
      tokens.push({ text: match[0] });
    tokens.push(token);
    cursor = token.end;
  }
  for (const match of source.slice(cursor).matchAll(/\S/g)) tokens.push({ text: match[0] });
  return tokens;
}
function voidUnits(source, name) {
  const tokens = syntaxTokens(source);
  const found = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].text !== "void" || tokens[i + 1].text !== name || tokens[i + 2].text !== "(")
      continue;
    let end = i + 2,
      depth = 0;
    do {
      if (tokens[end].text === "(") depth++;
      if (tokens[end].text === ")") depth--;
      end++;
    } while (depth && end < tokens.length);
    if (depth) throw new Error("Incomplete function parameters");
    const definition = tokens[end]?.text === "{";
    if (definition) {
      depth = 0;
      do {
        if (tokens[end].text === "{") depth++;
        if (tokens[end].text === "}") depth--;
        end++;
      } while (depth && end < tokens.length);
      if (depth) throw new Error("Incomplete function body");
    } else if (tokens[end]?.text === ";") end++;
    else throw new Error("Unsupported slice function syntax");
    found.push({ definition, tokens: tokens.slice(i, end) });
  }
  return found;
}

/** Check the slice's active ownership and naming obligations, not arbitrary agent refactorings.
 * This narrow reference check complements fresh compiler/render verification. It is not
 * the future benchmark grader and does not require byte-exact candidate source.
 */
export function assertSliceObligations(tree, active) {
  for (const [name, source] of Object.entries(tree)) assertNeutralSource(name, source);
  const all = Object.values(tree).flatMap((source) => cppTokens(source));
  for (const [key, value] of Object.entries(active)) {
    if (key === "math-module") {
      if (!tree[value.file] || !tree["main.cpp"].includes(`#include "${value.file}"`))
        throw new Error("Missing math module ownership");
    } else if (key.endsWith("-declaration") || key.endsWith("-definition")) {
      const definition = key.endsWith("-definition");
      const units = voidUnits(tree[value.file] ?? "", value.name).filter(
        (unit) => unit.definition === definition,
      );
      if (units.length !== 1) throw new Error(`Missing or duplicate ownership: ${key}`);
      if (
        definition &&
        Object.entries(tree).some(
          ([file, source]) =>
            file !== value.file && voidUnits(source, value.name).some((unit) => unit.definition),
        )
      )
        throw new Error(`Definition remains outside its owner: ${key}`);
    } else if (key.endsWith("-locals")) {
      const name = active[`${value.owner}-definition`].name;
      const units = Object.values(tree).flatMap((source) => voidUnits(source, name));
      const spellings = new Set(units.flatMap((unit) => unit.tokens.map((token) => token.text)));
      if (
        Object.keys(value.mapping).some((from) => spellings.has(from)) ||
        Object.values(value.mapping).some((to) => !spellings.has(to))
      )
        throw new Error(`Owner local names were not restored: ${key}`);
    } else if (key.endsWith("-family") || key === "vec4f-type") {
      if (
        all.some((token) => token.text === value.from) ||
        !all.some((token) => token.text === value.name)
      )
        throw new Error(`Incomplete family restoration: ${key}`);
    } else if (key === "vec4f-fields") {
      const tokens = syntaxTokens(tree[active["math-module"].file]);
      const start = tokens.findIndex(
        (token, index) => token.text === "struct" && tokens[index + 1]?.text === value.owner,
      );
      if (start < 0) throw new Error("Missing field owner");
      const end = tokens.findIndex((token, index) => index > start && token.text === "}");
      if (!tokens.slice(start, end).some((token) => token.text === value.name))
        throw new Error("Missing restored field");
    } else throw new Error(`Unknown slice obligation: ${key}`);
  }
}
function functions(roots, namespace, name) {
  const found = [];
  function visit(node, scope) {
    const next = node.kind === "NamespaceDecl" ? [...scope, node.name] : scope;
    if (
      node.kind === "FunctionDecl" &&
      next.join("::") === namespace &&
      node.name === name &&
      node.type?.qualType.startsWith("void (")
    )
      found.push(node);
    // Only free declarations; do not enter methods, templates or function bodies.
    if (["NamespaceDecl", "LinkageSpecDecl"].includes(node.kind))
      for (const child of node.inner ?? []) visit(child, next);
  }
  for (const root of roots) visit(root, []);
  return found;
}

function snippet(source, node) {
  const begin = node.range.begin;
  const end = node.range.end;
  if (begin.spellingLoc || begin.expansionLoc || end.spellingLoc || end.expansionLoc)
    throw new Error("Slice target uses a macro location");
  const bytes = Buffer.from(source);
  let finish = end.offset + end.tokLen;
  if (!node.inner?.some((item) => item.kind === "CompoundStmt")) {
    while (/\s/.test(String.fromCharCode(bytes[finish] ?? 0))) finish++;
    if (bytes[finish] !== 59) throw new Error("Missing declaration semicolon");
    finish++;
  }
  return bytes.subarray(begin.offset, finish).toString("utf8");
}

function replaceUnique(source, old, replacement) {
  const start = source.indexOf(old);
  if (start < 0 || source.indexOf(old, start + old.length) >= 0)
    throw new Error("Missing or ambiguous source boundary");
  return source.slice(0, start) + replacement + source.slice(start + old.length);
}

function renameText(source, table) {
  let result = "",
    cursor = 0;
  for (const token of cppTokens(source)) {
    if (!table.has(token.text)) continue;
    result += source.slice(cursor, token.start) + table.get(token.text);
    cursor = token.end;
  }
  return result + source.slice(cursor);
}

function tableFor(entries) {
  const table = new Map();
  for (const entry of entries) {
    if (table.has(entry.newName) && table.get(entry.newName) !== entry.name)
      throw new Error("Conflicting binding-specific names");
    table.set(entry.newName, entry.name);
  }
  if (!table.size) throw new Error("Missing naming assignments");
  return table;
}

function family(manifest, role, name, scope) {
  const entries = manifest.operations.flatMap((record) => record.selection ?? []);
  const selected = entries.filter(
    (entry) => entry.role === role && entry.name === name && (!scope || entry.scope === scope),
  );
  if (
    !selected.length ||
    new Set(selected.map((entry) => entry.family)).size !== 1 ||
    new Set(selected.map((entry) => entry.newName)).size !== 1
  )
    throw new Error(`Ambiguous naming family: ${name}`);
  const spelling = selected[0].newName;
  if (entries.some((entry) => entry.newName === spelling && entry.family !== selected[0].family))
    throw new Error(`Generated spelling is shared by unrelated bindings: ${spelling}`);
  return { spelling, entries: selected };
}

/** Build a small real request chain from the guarded monolith, never from saved clean sources.
 * This pinned slice restores two geometry overloads and one math type. All support extraction
 * is part of the chain. Private AST spans and naming records are not agent requests.
 */
export async function atomicSlice(payload, manifest, scratch) {
  await mkdir(scratch, { recursive: true });
  const route = referenceRoute(payload, manifest);
  const namespace = manifest.operations.find((record) => record.kind === "origin-markers")?.name;
  if (!namespace) throw new Error("Slice requires a named neutral monolith");
  const mathFile = neutralSourcePath("yocto_math.h", namespace);
  const shapeHeader = neutralSourcePath("yocto_shape.h", namespace);
  const shapeSource = neutralSourcePath("yocto_shape.cpp", namespace);
  const math = route.stages.find((stage) => stage.action === `extract:${mathFile}`)?.tree[mathFile];
  if (!math) throw new Error("Missing common math module");
  const owners = ["make_rect", "make_recty"].map((name) => ({
    name,
    ...family(manifest, "function", name, "yocto"),
  }));
  const type = family(manifest, "type", "vec4f", "yocto");
  const field = family(manifest, "field", "w", `yocto::${type.spelling}`);
  await writeTree(path.join(scratch, "mixed"), payload);
  const roots = await projectAst(path.resolve(scratch, "mixed/main.cpp"), flags);
  for (const owner of owners) {
    const nodes = functions(roots, namespace, owner.spelling);
    const definitions = nodes.filter((node) =>
      node.inner?.some((item) => item.kind === "CompoundStmt"),
    );
    const declarations = nodes.filter(
      (node) => !node.previousDecl && !node.inner?.some((item) => item.kind === "CompoundStmt"),
    );
    if (definitions.length !== 1 || declarations.length !== 1 || definitions[0].storageClass)
      throw new Error(`Unsupported geometry owner: ${owner.name}`);
    owner.declaration = snippet(payload["main.cpp"], declarations[0]);
    owner.definition = snippet(payload["main.cpp"], definitions[0]);
    owner.snippets = [...new Set(nodes.map((node) => snippet(payload["main.cpp"], node)))];
    owner.signature = definitions[0].type.qualType;
  }
  // Local assignment scopes refer to the canonical declaration before this naming category.
  let beforeLocals = payload;
  for (const record of [...manifest.operations].reverse()) {
    beforeLocals = reverseOperation(beforeLocals, record);
    if (record.kind === "rename" && record.category === "locals-parameters") break;
  }
  await writeTree(path.join(scratch, "before-locals"), beforeLocals);
  const localRoots = await projectAst(path.resolve(scratch, "before-locals/main.cpp"), flags);
  const localRecord = manifest.operations.find((record) => record.category === "locals-parameters");
  for (const owner of owners) {
    const nodes = functions(localRoots, "yocto", owner.spelling);
    const canonical = Math.min(...nodes.map((node) => node.loc.offset));
    owner.localEntries = localRecord.selection.filter(
      (entry) => entry.scope === `yocto::${owner.spelling}@${canonical}`,
    );
    owner.localTable = tableFor(owner.localEntries);
  }

  let tree = payload;
  const stages = [{ phase: "initial", tree }];
  const steps = [];
  const common =
    "Keep earlier changes, behavior and rendered images unchanged. Keep the neutral project identity in filenames, includes, namespace and guards. Keep the project buildable, do not add comments, and leave unrelated code alone.";
  function add(phase, prompt, next, adds, replaces = []) {
    if (treeIdentity(next) === treeIdentity(tree)) throw new Error("Empty reference step");
    const index = steps.length;
    steps.push({
      id: stepId(index),
      phase,
      dependsOn: index ? [stepId(index - 1)] : [],
      prompt: `${prompt}\n\n${common}`,
      adds,
      replaces,
    });
    tree = next;
    stages.push({ phase, tree });
  }
  add(
    "structure",
    `Move the complete common math header block guarded by \`_${namespace.toUpperCase()}_MATH_H_\` from \`main.cpp\` into \`${mathFile}\`. Preserve all its current names, declarations, inline definitions and includes. Replace that block with an include of the new header.`,
    {
      "main.cpp": replaceUnique(tree["main.cpp"], math, `#include "${mathFile}"\n`),
      [mathFile]: math,
    },
    [{ key: "math-module", value: { file: mathFile } }],
  );

  for (const owner of owners) {
    const existing = tree[shapeHeader];
    const header = existing
      ? existing.slice(0, existing.lastIndexOf("}")) + owner.declaration + "\n}\n"
      : `#pragma once\n#include "${mathFile}"\n#include <vector>\nnamespace ${namespace} {\nusing std::vector;\n${owner.declaration}\n}\n`;
    const replacement = existing ? "" : `}\n#include "${shapeHeader}"\nnamespace ${namespace} {`;
    add(
      "structure",
      `Move the public void overload declaration of ${namespace}::${owner.spelling} (four output vectors followed by steps, scale and uvscale) from main.cpp to ${shapeHeader}. Keep its existing default arguments and names. Do not move the overload that returns a shape. Make the header self-contained and include it from main.cpp at namespace scope.`,
      {
        ...tree,
        "main.cpp": replaceUnique(tree["main.cpp"], owner.declaration, replacement),
        [shapeHeader]: header,
      },
      [
        {
          key: `${owner.name}-declaration`,
          value: { file: shapeHeader, name: owner.spelling },
        },
      ],
    );
  }
  for (const owner of owners) {
    const existing = tree[shapeSource];
    const source = existing
      ? existing.slice(0, existing.lastIndexOf("}")) + owner.definition + "\n}\n"
      : `#include "${shapeHeader}"\nnamespace ${namespace} {\nusing std::vector;\n${owner.definition}\n}\n`;
    add(
      "structure",
      `Move the complete void definition of ${namespace}::${owner.spelling} (${owner.signature}) from main.cpp into ${shapeSource}. Include ${shapeHeader} and compile the new source with main.cpp. Keep its body and names unchanged; leave the shape-returning overload in main.cpp.`,
      {
        ...tree,
        "main.cpp": replaceUnique(tree["main.cpp"], owner.definition, ""),
        [shapeSource]: source,
      },
      [
        {
          key: `${owner.name}-definition`,
          value: { file: shapeSource, name: owner.spelling },
        },
      ],
    );
  }
  for (const owner of owners) {
    const next = { ...tree };
    const seen = new Set();
    for (const [file, source] of Object.entries(tree)) {
      const ranges = [];
      for (const block of owner.snippets) {
        let start = source.indexOf(block);
        while (start >= 0) {
          ranges.push({ start, end: start + block.length, block });
          for (const token of cppTokens(block))
            if (owner.localTable.has(token.text)) seen.add(token.text);
          start = source.indexOf(block, start + block.length);
        }
      }
      ranges.sort((a, b) => a.start - b.start);
      let text = "",
        cursor = 0;
      for (const range of ranges) {
        if (range.start < cursor) throw new Error("Overlapping local owner ranges");
        text += source.slice(cursor, range.start) + renameText(range.block, owner.localTable);
        cursor = range.end;
      }
      next[file] = text + source.slice(cursor);
    }
    if ([...owner.localTable.keys()].some((name) => !seen.has(name)))
      throw new Error("A selected local assignment has no physical owner");
    const mapping = [...owner.localTable].map(([from, to]) => `${from} -> ${to}`).join("; ");
    add(
      "names",
      `In the void overload of ${namespace}::${owner.spelling}, restore these parameter and local names, including its declarations and all uses bound to those variables: ${mapping}. Do not rename variables in the shape-returning overload or other functions.`,
      next,
      [
        {
          key: `${owner.name}-locals`,
          value: { owner: owner.name, mapping: Object.fromEntries(owner.localTable) },
        },
      ],
    );
  }
  function restoreFamily(current, original, prompt, adds, replaces = []) {
    const table = new Map([[current, original]]);
    add(
      "names",
      prompt,
      Object.fromEntries(
        Object.entries(tree).map(([file, source]) => [file, renameText(source, table)]),
      ),
      adds,
      replaces,
    );
  }
  restoreFamily(
    field.spelling,
    "w",
    `Restore field ${type.spelling}::${field.spelling} to w, updating all bound member uses. Leave fields of other types unchanged.`,
    [{ key: "vec4f-fields", value: { owner: type.spelling, name: "w" } }],
  );
  for (const owner of owners)
    restoreFamily(
      owner.spelling,
      owner.name,
      `Restore the whole overload family ${namespace}::${owner.spelling} to ${owner.name}. Update its declarations, definitions and bound call sites throughout the project. Do not change other function names.`,
      [
        { key: `${owner.name}-declaration`, value: { file: shapeHeader, name: owner.name } },
        { key: `${owner.name}-definition`, value: { file: shapeSource, name: owner.name } },
        { key: `${owner.name}-family`, value: { from: owner.spelling, name: owner.name } },
      ],
      [`${owner.name}-declaration`, `${owner.name}-definition`],
    );
  restoreFamily(
    type.spelling,
    "vec4f",
    `Restore type ${namespace}::${type.spelling} to vec4f, including declarations and every bound type use. Keep its fields and behavior unchanged.`,
    [
      { key: "vec4f-fields", value: { owner: "vec4f", name: "w" } },
      { key: "vec4f-type", value: { from: type.spelling, name: "vec4f", file: mathFile } },
    ],
    ["vec4f-fields"],
  );
  const obligations = resolveObligations(steps);
  for (const [index, active] of obligations.entries())
    assertSliceObligations(stages[index + 1].tree, active);
  return {
    version: "renderer-atomic-slice-v2",
    initial: manifest.final,
    steps,
    stages,
    obligations,
  };
}
