import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

const require = createRequire(import.meta.url);
let cppLanguage;

async function language() {
  cppLanguage ??= (async () => {
    await Parser.init();
    return Language.load(require.resolve("tree-sitter-cpp/tree-sitter-cpp.wasm"));
  })();
  return cppLanguage;
}

const typeKinds = new Map([
  ["struct_specifier", "struct"],
  ["class_specifier", "class"],
  ["union_specifier", "union"],
  ["enum_specifier", "enum"],
]);
const conditionalKinds = new Set(["preproc_if", "preproc_ifdef", "preproc_elif", "preproc_else"]);

function isFunctionDeclarator(node) {
  while (node && node.type !== "function_declarator") {
    if (node.type === "init_declarator") return false;
    node = node.childForFieldName("declarator");
  }
  return Boolean(node);
}

function hasBodyOrComment(node) {
  return (
    ["lambda_expression", "comment"].includes(node.type) ||
    node.namedChildren.some(hasBodyOrComment)
  );
}

// The bundled grammar rejects a bare braced default (`T x = {1, 2}`). Parse each
// initializer independently, then substitute an equal-length scalar only for the
// outer parse. All public text is sliced from the unchanged input.
function maskBracedDefaults(parser, source) {
  const protectedTokens = cppTokens(source).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  const lexical = source.split("");
  for (const token of protectedTokens)
    for (let at = token.start; at < token.end; at++)
      if (lexical[at] !== "\n" && lexical[at] !== "\r") lexical[at] = " ";
  const spans = [];
  let parens = 0,
    braces = 0;
  for (let at = 0; at < lexical.length; at++) {
    const char = lexical[at];
    if (char === "(") parens++;
    else if (char === ")") parens--;
    else if (char === "{") {
      let previous = at - 1;
      while (previous >= 0 && /\s/.test(lexical[previous])) previous--;
      if (parens > 0 && braces === 0 && lexical[previous] === "=") {
        let depth = 1,
          end = at + 1;
        while (end < lexical.length && depth) {
          if (lexical[end] === "{") depth++;
          else if (lexical[end] === "}") depth--;
          end++;
        }
        assert.equal(depth, 0, "Unterminated default initializer");
        const probe = parser.parse(`auto inventory_default = ${source.slice(at, end)};`);
        try {
          assert.ok(
            !probe.rootNode.hasError && !hasBodyOrComment(probe.rootNode),
            "Unsupported default initializer",
          );
        } finally {
          probe.delete();
        }
        spans.push([at, end]);
        at = end - 1;
      } else braces++;
    } else if (char === "}") braces--;
    assert.ok(parens >= 0 && braces >= 0, "Unbalanced declaration");
  }
  assert.ok(spans.length > 0 && parens === 0 && braces === 0, "Unsupported declaration");
  const outer = source.split("");
  for (const [start, end] of spans) {
    for (let at = start; at < end; at++)
      if (outer[at] !== "\n" && outer[at] !== "\r") outer[at] = " ";
    outer[start] = "0";
  }
  return outer.join("");
}

/** Derive public identifiers from private ownership fragments. Never return ranges or bodies. */
export async function symbolSpecifications(task) {
  assert.ok(task && Array.isArray(task.fragments));
  const cpp = await language();
  const parser = new Parser();
  parser.setLanguage(cpp);
  const result = [];
  function add(scope, kind, signature) {
    assert.ok(typeof scope === "string" && typeof signature === "string" && signature.trim());
    result.push({ scope, kind, signature: signature.trim() });
  }
  function inspect(node, source, scope, prefix = "") {
    const text = (start, end) => source.slice(start, end).trim();
    if (node.type === "comment") return;
    if (node.type === "translation_unit" || conditionalKinds.has(node.type)) {
      for (const child of node.namedChildren) {
        if (
          conditionalKinds.has(node.type) &&
          [node.childForFieldName("name")?.id, node.childForFieldName("condition")?.id].includes(
            child.id,
          )
        )
          continue;
        inspect(child, source, scope);
      }
      return;
    }
    if (node.type === "namespace_definition") {
      const name = node.childForFieldName("name");
      const body = node.childForFieldName("body");
      assert.ok(name && body, "Unsupported namespace");
      const nested = scope ? `${scope}::${name.text}` : name.text;
      for (const child of body.namedChildren) inspect(child, source, nested);
      return;
    }
    if (node.type === "preproc_call") {
      const match = /^\s*#\s*undef\s+([A-Za-z_]\w*)\s*$/.exec(node.text);
      assert.ok(match, "Unsupported preprocessing directive");
      add(scope, "macro-undef", match[1]);
      return;
    }
    if (node.type === "template_declaration") {
      const parameters = node.namedChildren.find(
        (child) => child.type === "template_parameter_list",
      );
      assert.ok(parameters && !hasBodyOrComment(parameters), "Unsupported template signature");
      const children = node.namedChildren.filter(
        (item) =>
          item.type !== "template_parameter_list" &&
          item.type !== "requires_clause" &&
          item.type !== "comment",
      );
      assert.equal(children.length, 1, "Unsupported template declaration");
      const child = children[0];
      assert.ok(
        !node.namedChildren
          .filter((item) => item.endIndex <= child.startIndex)
          .some(hasBodyOrComment),
        "Unsupported template signature",
      );
      inspect(child, source, scope, prefix + text(node.startIndex, child.startIndex) + " ");
      return;
    }
    if (node.type === "function_definition") {
      const body = node.childForFieldName("body");
      assert.ok(body && body.type === "compound_statement", "Unsupported function definition");
      const headerNodes = node.namedChildren.filter((child) => child.endIndex <= body.startIndex);
      assert.ok(
        !headerNodes.some(
          (child) =>
            child.type === "field_initializer_list" ||
            child.type === "comment" ||
            hasBodyOrComment(child),
        ),
        "Unsupported function signature",
      );
      add(scope, "function-definition", prefix + text(node.startIndex, body.startIndex));
      return;
    }
    if (node.type === "alias_declaration" || node.type === "using_declaration") {
      assert.ok(
        !hasBodyOrComment(node) && !node.namedChildren.some((child) => child.type === "comment"),
        "Unsupported using declaration",
      );
      add(scope, "using", prefix + node.text.trim());
      return;
    }
    if (typeKinds.has(node.type)) {
      const name = node.childForFieldName("name");
      assert.ok(name && name.text, "Anonymous type is not uniquely identifiable");
      add(scope, typeKinds.get(node.type), prefix + name.text);
      return;
    }
    if (node.type === "declaration" || node.type === "field_declaration") {
      const declarators = node.childrenForFieldName("declarator");
      assert.equal(declarators.length, 1, "Unsupported or ambiguous declaration");
      const decl = declarators[0];
      assert.ok(
        !node.namedChildren.some(
          (child) => typeKinds.has(child.type) && child.childForFieldName("body"),
        ),
        "Embedded type definition in a declaration is unsupported",
      );
      if (isFunctionDeclarator(decl)) {
        assert.ok(!hasBodyOrComment(node), "Unsupported lambda in signature");
        add(
          scope,
          "function-declaration",
          prefix + text(node.startIndex, node.endIndex).replace(/;\s*$/, ""),
        );
        return;
      }
      const actual = decl.type === "init_declarator" ? decl.childForFieldName("declarator") : decl;
      assert.ok(actual, "Unsupported variable declaration");
      add(scope, "variable", prefix + text(node.startIndex, actual.endIndex));
      return;
    }
    if (node.type === "preproc_def" || node.type === "preproc_function_def") {
      const name = node.childForFieldName("name");
      assert.ok(name, "Missing macro name");
      const params = node.namedChildren.find((child) => child.type === "preproc_params");
      add(scope, "macro", name.text + (params?.text ?? ""));
      return;
    }
    if (node.type === "preproc_include") {
      add(scope, "include", node.text.trim());
      return;
    }
    throw new Error(`Unsupported C++ inventory node: ${node.type}`);
  }
  try {
    const fragments = [
      ...task.fragments,
      ...(task.using ?? []).map((item) => ({ ...item, kind: "using" })),
    ];
    for (const fragment of fragments) {
      assert.equal(typeof fragment.text, "string");
      const scope = fragment.scope ?? "";
      assert.equal(typeof scope, "string");
      assert.match(scope, /^(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)?$/);
      if (fragment.kind === "comment" || fragment.kind === "empty-declaration") continue;
      let tree = parser.parse(fragment.text);
      try {
        let fallback = false;
        if (tree.rootNode.hasError && fragment.kind === "declaration") {
          const masked = maskBracedDefaults(parser, fragment.text);
          tree.delete();
          tree = parser.parse(masked);
          fallback = true;
          assert.equal(
            tree.rootNode.namedChildren.length,
            1,
            "Unsupported default argument declaration",
          );
          assert.ok(
            ["declaration", "function_definition", "template_declaration"].includes(
              tree.rootNode.namedChildren[0].type,
            ),
            "Unsupported default argument declaration",
          );
        }
        assert.ok(!tree.rootNode.hasError, "Cannot parse owned C++ fragment");
        const before = result.length;
        inspect(tree.rootNode, fragment.text, scope);
        if (fallback)
          assert.ok(
            result.length === before + 1 &&
              ["function-declaration", "function-definition"].includes(result[before].kind),
            "Unsupported default argument declaration",
          );
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  result.sort(
    (a, b) =>
      compare(a.scope, b.scope) || compare(a.kind, b.kind) || compare(a.signature, b.signature),
  );
  for (let i = 1; i < result.length; i++)
    assert.notDeepEqual(result[i], result[i - 1], "Indistinguishable owned C++ entities");
  return result;
}
