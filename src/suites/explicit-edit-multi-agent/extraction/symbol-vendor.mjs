import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

const require = createRequire(import.meta.url);
let language;
async function cppLanguage() {
  language ??= (async () => {
    await Parser.init();
    return Language.load(require.resolve("tree-sitter-cpp/tree-sitter-cpp.wasm"));
  })();
  return language;
}

const containers = new Set([
  "translation_unit",
  "preproc_if",
  "preproc_ifdef",
  "preproc_elif",
  "preproc_else",
]);
const maskedQualifiers = new Set(["STBIRDEF", "stbir__inline"]);

// Mask qualifier identifier tokens outside preprocessing directives, never literals
// or comments. Equal length keeps the parser's offsets bound to the original input.
function normalize(source) {
  const directives = [];
  let continued = false,
    offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const directive = continued || /^[ \t]*#/.test(line);
    if (directive) directives.push([offset, offset + line.length]);
    continued = directive && /\\\r?\n$/.test(line);
    offset += line.length;
  }
  const chars = source.split("");
  for (const token of cppTokens(source)) {
    if (!maskedQualifiers.has(token.text)) continue;
    if (directives.some(([start, end]) => start <= token.start && token.start < end)) continue;
    for (let at = token.start; at < token.end; at++) chars[at] = " ";
  }
  return chars.join("");
}

function originalStart(source, node) {
  const line = source.lastIndexOf("\n", node.startIndex - 1) + 1;
  const prefix = source.slice(line, node.startIndex);
  if (/^\s*(?:STBIRDEF|stbir__inline)\s+$/.test(prefix)) return line;
  assert.match(prefix, /^\s*$/, "Unsupported declaration prefix");
  return node.startIndex;
}

function declaratorIsFunction(node) {
  while (node && node.type !== "function_declarator") {
    if (node.type === "init_declarator") return false;
    node = node.childForFieldName("declarator");
  }
  return Boolean(node);
}

function containsError(node) {
  return node.type === "ERROR" || node.isMissing || node.children.some(containsError);
}

function containsBody(node) {
  return (
    ["lambda_expression", "compound_statement", "comment"].includes(node.type) ||
    node.namedChildren.some(containsBody)
  );
}

/** Describe every top-level vendor entity without bodies, location or source order. */
export async function vendorSymbolSpecifications(task) {
  assert.equal(task.kind, "vendor-header");
  assert.ok(Array.isArray(task.fragments) && task.fragments.length > 0);
  const cpp = await cppLanguage();
  const parser = new Parser();
  parser.setLanguage(cpp);
  const counts = new Map();
  const functionBodies = new Map();
  const variableDefinitions = new Map();
  const typeDefinitions = new Map();
  function add(kind, signature, members) {
    assert.equal(typeof signature, "string");
    signature = signature.trim();
    assert.ok(signature.length > 0);
    const key = JSON.stringify({ scope: "", kind, signature, ...(members ? { members } : {}) });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  function inspect(node, source) {
    if (containers.has(node.type)) {
      assert.ok(!node.children.some((child) => child.isMissing), "Incomplete vendor syntax");
      const condition = new Set([
        node.childForFieldName("name")?.id,
        node.childForFieldName("condition")?.id,
      ]);
      for (const child of node.namedChildren) if (!condition.has(child.id)) inspect(child, source);
      return;
    }
    if (node.type === "comment") return;
    if (node.type === "function_definition") {
      const body = node.childForFieldName("body");
      assert.ok(body && body.type === "compound_statement");
      for (const child of node.namedChildren)
        if (child.id !== body.id)
          assert.ok(!containsError(child) && !containsBody(child), "Unsupported function header");
      const signature = source.slice(originalStart(source, node), body.startIndex).trim();
      const text = source.slice(body.startIndex, body.endIndex);
      assert.ok(
        !functionBodies.has(signature) || functionBodies.get(signature) === text,
        "Indistinguishable vendor definitions",
      );
      functionBodies.set(signature, text);
      add("function-definition", signature);
      return;
    }
    assert.ok(!node.hasError, "Unsupported top-level vendor syntax");
    if (node.type === "declaration") {
      const declarators = node.childrenForFieldName("declarator");
      assert.equal(declarators.length, 1, "Unsupported vendor declaration");
      const decl = declarators[0];
      if (declaratorIsFunction(decl)) {
        assert.ok(!containsBody(node), "Unsupported function declaration");
        add(
          "function-declaration",
          source.slice(originalStart(source, node), node.endIndex).replace(/;\s*$/, ""),
        );
      } else {
        const name = decl.type === "init_declarator" ? decl.childForFieldName("declarator") : decl;
        assert.ok(name, "Unsupported vendor variable");
        for (const child of node.namedChildren)
          if (child.endIndex <= name.endIndex)
            assert.ok(!containsBody(child), "Unsupported vendor variable");
        const start = originalStart(source, node);
        const signature = source.slice(start, name.endIndex).trim();
        const definition = source.slice(start, node.endIndex);
        assert.ok(
          !variableDefinitions.has(signature) || variableDefinitions.get(signature) === definition,
          "Indistinguishable vendor variables",
        );
        variableDefinitions.set(signature, definition);
        add("variable", signature);
      }
      return;
    }
    if (node.type === "type_definition") {
      const declarators = node.childrenForFieldName("declarator");
      assert.equal(declarators.length, 1, "Unsupported vendor typedef");
      const decl = declarators[0];
      const type = node.childForFieldName("type");
      if (
        type &&
        ["struct_specifier", "class_specifier", "union_specifier", "enum_specifier"].includes(
          type.type,
        ) &&
        type.childForFieldName("body")
      ) {
        assert.equal(decl.type, "type_identifier", "Unsupported compound typedef");
        const signature = source.slice(decl.startIndex, decl.endIndex);
        const body = type.childForFieldName("body");
        const members = [];
        for (const member of body.namedChildren) {
          if (member.type === "comment") continue;
          if (member.type === "enumerator") {
            const name = member.childForFieldName("name");
            assert.ok(name, "Unsupported enumerator");
            members.push(source.slice(name.startIndex, name.endIndex));
            continue;
          }
          assert.equal(member.type, "field_declaration", "Unsupported vendor type member");
          const declarations = member.childrenForFieldName("declarator");
          assert.ok(declarations.length > 0, "Unsupported vendor type member");
          const prefix = source.slice(member.startIndex, declarations[0].startIndex);
          for (const declarator of declarations) {
            const field =
              declarator.type === "init_declarator"
                ? declarator.childForFieldName("declarator")
                : declarator;
            assert.ok(field && !containsBody(field), "Unsupported vendor type member");
            members.push((prefix + source.slice(field.startIndex, field.endIndex)).trim() + ";");
          }
        }
        members.sort();
        const identity = JSON.stringify([signature, members]);
        const definition = source.slice(node.startIndex, node.endIndex);
        assert.ok(
          !typeDefinitions.has(identity) || typeDefinitions.get(identity) === definition,
          `Indistinguishable vendor types: ${signature}`,
        );
        typeDefinitions.set(identity, definition);
        add("typedef", signature, members);
      } else {
        assert.ok(!containsBody(node), "Unsupported vendor typedef");
        add("typedef", source.slice(node.startIndex, node.endIndex));
      }
      return;
    }
    if (node.type === "preproc_def" || node.type === "preproc_function_def") {
      const name = node.childForFieldName("name");
      assert.ok(name);
      const params = node.namedChildren.find((child) => child.type === "preproc_params");
      add(
        "macro",
        source.slice(name.startIndex, name.endIndex) +
          (params ? source.slice(params.startIndex, params.endIndex) : ""),
      );
      return;
    }
    if (node.type === "preproc_include") {
      add("include", source.slice(node.startIndex, node.endIndex));
      return;
    }
    if (node.type === "preproc_call") {
      assert.match(source.slice(node.startIndex, node.endIndex), /^\s*#\s*error\b/);
      add("directive", "#error");
      return;
    }
    throw new Error(`Unsupported vendor inventory node: ${node.type}`);
  }
  try {
    for (const fragment of task.fragments) {
      assert.equal(typeof fragment.text, "string");
      const tree = parser.parse(normalize(fragment.text));
      try {
        inspect(tree.rootNode, fragment.text);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
  const out = [...counts].map(([key, count]) => ({
    ...JSON.parse(key),
    ...(count > 1 ? { count } : {}),
  }));
  out.sort((a, b) =>
    a.kind < b.kind
      ? -1
      : a.kind > b.kind
        ? 1
        : a.signature < b.signature
          ? -1
          : a.signature > b.signature
            ? 1
            : JSON.stringify(a.members ?? []) < JSON.stringify(b.members ?? [])
              ? -1
              : JSON.stringify(a.members ?? []) > JSON.stringify(b.members ?? [])
                ? 1
                : 0,
  );
  return out;
}
