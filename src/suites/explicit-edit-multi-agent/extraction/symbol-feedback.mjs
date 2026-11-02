import assert from "node:assert/strict";
import { canonicalizeCpp } from "../grading/canonical-snapshot.mjs";
import { symbolSpecifications } from "./symbol-spec.mjs";
import { vendorSymbolSpecifications } from "./symbol-vendor.mjs";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";

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
  "preproc_include",
  "preproc_def",
  "preproc_function_def",
  "preproc_call",
]);
const key = ({ scope, kind, signature }) => JSON.stringify([scope, kind, signature]);

/** Collect supported namespace-level units without exposing their contents. */
async function inventory(source, known) {
  const projection = await canonicalizeCpp(source, { projection: true });
  const matches = new Map();
  let incomplete = projection.errors.length > 0;
  const visit = async (node, scope) => {
    if (node.type === "namespace_definition") {
      let names;
      try {
        names = JSON.parse(node.name);
      } catch {
        incomplete = true;
        return;
      }
      if (!Array.isArray(names) || !names.every((part) => typeof part === "string")) {
        incomplete = true;
        return;
      }
      const name = names.join("");
      if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(name)) {
        incomplete = true;
        return;
      }
      scope = scope ? `${scope}::${name}` : name;
    }
    if (units.has(node.type)) {
      if (
        node.type === "preproc_call" &&
        /^\s*#\s*pragma\s+once\s*$/.test(source.slice(node.start, node.end))
      )
        return;
      let items;
      try {
        items = await symbolSpecifications({
          fragments: [{ text: source.slice(node.start, node.end), scope, kind: "declaration" }],
        });
      } catch {
        incomplete = true;
        return;
      }
      for (const item of items) {
        const identity = key(item);
        if (!known.has(identity)) continue;
        if (!matches.has(identity)) matches.set(identity, []);
        matches.get(identity).push(node.key);
      }
      return;
    }
    if (node.type === "ERROR") incomplete = true;
    for (const child of node.children) await visit(child, scope);
  };
  await visit(projection.projection, "");
  return { matches, incomplete };
}

/** Only candidate-visible directive names are reported; macro replacements stay private. */
function directiveNames(source) {
  const result = new Map();
  const add = (entity) => {
    const identity = key(entity);
    const entry = result.get(identity) ?? { entity, count: 0 };
    entry.count++;
    result.set(identity, entry);
  };
  const protectedTokens = cppTokens(source).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  let offset = 0;
  let continued = false;
  for (const line of source.split(/(?<=\n)/)) {
    const match = !continued && /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/.exec(line);
    const condition = !continued && /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|else|endif)\b/.exec(line);
    if (
      condition &&
      !protectedTokens.some(
        (token) => token.start <= offset + condition.index && offset + condition.index < token.end,
      )
    )
      add({ scope: "", kind: "conditional-directive", signature: `#${condition[1]}` });
    if (
      match &&
      !protectedTokens.some(
        (token) => token.start <= offset + match.index && offset + match.index < token.end,
      )
    )
      add({ scope: "", kind: "macro", signature: match[1] });
    continued = (continued || /^[ \t]*#/.test(line)) && /\\\r?\n$/.test(line);
    offset += line.length;
  }
  for (const { file, quoted } of includeDirectives(source)) {
    if (!/^[A-Za-z0-9_./+-]+$/.test(file) || file.split("/").includes("..")) continue;
    add({
      scope: "",
      kind: "include",
      signature: quoted ? `#include "${file}"` : `#include <${file}>`,
    });
  }
  return result;
}
/** Compare public identities while keeping reference contents and coordinates private. */
export async function buildSymbolRecoveryFeedback({
  expected,
  actual,
  entities,
  kind,
  detectUnexpected = false,
}) {
  assert.equal(typeof expected, "string");
  assert.equal(typeof actual, "string");
  assert.ok(Array.isArray(entities));
  if (kind === "vendor-header") {
    let current;
    try {
      current = actual
        ? await vendorSymbolSpecifications({ kind, fragments: [{ text: actual }] })
        : [];
    } catch {
      return [{ status: "unavailable" }];
    }
    const vendorKey = ({ scope, kind: entityKind, signature, members }) =>
      JSON.stringify([scope, entityKind, signature, members ?? []]);
    const counts = new Map(current.map((entity) => [vendorKey(entity), entity.count ?? 1]));
    const feedback = [];
    for (const { scope, kind: entityKind, signature, members, occurrences } of entities) {
      const entity = { scope, kind: entityKind, signature, ...(members ? { members } : {}) };
      const expectedCount = occurrences ?? 1;
      const actualCount = counts.get(vendorKey(entity)) ?? 0;
      if (actualCount !== expectedCount)
        feedback.push({
          status: actualCount < expectedCount ? "missing" : "extra",
          entity,
          expectedCount,
          actualCount,
        });
    }
    feedback.push(...directiveFeedback(expected, actual, feedback));
    return feedback;
  }
  const publicEntities = new Map();
  const ambiguous = new Set();
  for (const { scope, kind, signature } of entities) {
    assert.equal(typeof scope, "string");
    assert.equal(typeof kind, "string");
    assert.equal(typeof signature, "string");
    const entity = { scope, kind, signature };
    const identity = key(entity);
    if (publicEntities.has(identity)) ambiguous.add(identity);
    publicEntities.set(identity, entity);
  }
  for (const identity of ambiguous) publicEntities.delete(identity);
  const [reference, candidate] = await Promise.all([
    inventory(expected, publicEntities),
    inventory(actual, publicEntities),
  ]);
  const feedback = [];
  for (const [identity, entity] of publicEntities) {
    const expectedUnits = reference.matches.get(identity) ?? [];
    const actualUnits = candidate.matches.get(identity) ?? [];
    if (!expectedUnits.length) {
      if (detectUnexpected && actualUnits.length && !reference.incomplete)
        feedback.push({
          status: "extra",
          entity,
          expectedCount: 0,
          actualCount: actualUnits.length,
        });
      continue;
    }
    if (actualUnits.length < expectedUnits.length) {
      feedback.push(
        candidate.incomplete
          ? { status: "unlocated", entity }
          : {
              status: "missing",
              entity,
              expectedCount: expectedUnits.length,
              actualCount: actualUnits.length,
            },
      );
    } else if (actualUnits.length > expectedUnits.length && !reference.incomplete) {
      feedback.push({
        status: "extra",
        entity,
        expectedCount: expectedUnits.length,
        actualCount: actualUnits.length,
      });
    } else if (
      expectedUnits.length === 1 &&
      actualUnits.length === 1 &&
      expectedUnits[0] !== actualUnits[0]
    ) {
      feedback.push({ status: "changed", entity });
    }
  }
  if (detectUnexpected) return feedback;
  feedback.push(...directiveFeedback(expected, actual, feedback));
  return feedback;
}

function directiveFeedback(expected, actual, known) {
  const wanted = directiveNames(expected);
  const found = directiveNames(actual);
  const feedback = [];
  for (const identity of new Set([...wanted.keys(), ...found.keys()])) {
    const reference = wanted.get(identity);
    const candidate = found.get(identity);
    const entity = (candidate ?? reference).entity;
    const expectedCount = reference?.count ?? 0;
    const actualCount = candidate?.count ?? 0;
    if (entity.kind === "conditional-directive" && expectedCount !== actualCount) {
      feedback.push({ status: "condition-count", entity, expectedCount, actualCount });
    } else if (
      entity.kind !== "conditional-directive" &&
      actualCount > expectedCount &&
      !known.some((item) => item.status === "extra" && item.entity && key(item.entity) === identity)
    ) {
      feedback.push({ status: "extra", entity });
    }
  }
  return feedback;
}
