import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { decodeSourceBytes, encodeSourceBytes } from "../cpp/source-bytes.mjs";

const require = createRequire(import.meta.url);
const version = "renderer-canonical-snapshot-v4";
const cppExtension = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ipp|inl|tcc|inc)$/i;
const literals = new Set([
  "string_literal",
  "raw_string_literal",
  "char_literal",
  "system_lib_string",
]);
const operators =
  /%:%:|<=>|>>=|<<=|->\*|\.\.\.|##|::|\.\*|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\*=|\/=|%=|\+=|-=|&=|\^=|\|=|<:|:>|<%|%>|%:/y;
const number = /(?:\d|\.\d)(?:[eEpP][+-]|[\w.]|'[\w])*/y;
const identifier = /[\p{ID_Start}_][\p{ID_Continue}_]*/uy;
let initialized;

async function language() {
  initialized ??= (async () => {
    const grammarBytes = await readFile(require.resolve("tree-sitter-cpp/tree-sitter-cpp.wasm"));
    await Parser.init();
    return {
      language: await Language.load(grammarBytes),
      identity: {
        version,
        parser: { name: "web-tree-sitter", version: "0.27.1" },
        grammar: {
          name: "tree-sitter-cpp",
          version: "0.23.4",
          sha256: createHash("sha256").update(grammarBytes).digest("hex"),
        },
        serialization: "ordered-cpp-source-v6",
        macroLayout: "project-definitions-and-arguments-token-gaps-v1",
      },
    };
  })();
  return initialized;
}

/** Opaque preprocessor replacements still contain C++ preprocessing tokens.
 * Reuse the project's protected literal/comment scanner; maximal-munch operators
 * and numbers keep `+ +` distinct from `++` instead of stripping all whitespace.
 * @param {string} source
 * @param {(token: {text: string, separated: boolean, start: number, end: number}) => void} [onToken]
 */
function preprocessingTokens(source, onToken) {
  // Remove phase-2 continuations outside literal bytes before tokenization.
  const pieces = [];
  let cursor = 0;
  const origins = [];
  const append = (start, end, strip) => {
    if (!onToken) {
      const piece = source.slice(start, end);
      pieces.push(strip ? piece.replace(/\\\r?\n/g, "") : piece);
      return;
    }
    for (let at = start; at < end; at++) {
      if (strip && source[at] === "\\") {
        if (source[at + 1] === "\n") {
          at++;
          continue;
        }
        if (source[at + 1] === "\r" && source[at + 2] === "\n") {
          at += 2;
          continue;
        }
      }
      pieces.push(source[at]);
      origins.push(at);
    }
  };
  for (const token of cppTokens(source)) {
    if (
      /^[A-Za-z_]\w*$/.test(token.text) ||
      token.text.startsWith("//") ||
      token.text.startsWith("/*")
    )
      continue;
    append(cursor, token.start, true);
    append(token.start, token.end, false);
    cursor = token.end;
  }
  append(cursor, source.length, true);
  source = pieces.join("");
  const protectedTokens = new Map(
    cppTokens(source)
      .filter((token) => !/^[A-Za-z_]\w*$/.test(token.text))
      .map((token) => [token.start, token]),
  );
  const result = [];
  let gap = false;
  const emit = (text, at) => {
    const token = { text, separated: result.length > 0 && gap };
    result.push(token);
    onToken?.({ ...token, start: origins[at], end: origins[at + text.length - 1] + 1 });
    gap = false;
  };
  for (let at = 0; at < source.length;) {
    const protectedToken = protectedTokens.get(at);
    if (protectedToken) {
      if (protectedToken.text.startsWith("//") || protectedToken.text.startsWith("/*")) gap = true;
      else emit(protectedToken.text, at);
      at = protectedToken.end;
      continue;
    }
    if (/\s/.test(source[at])) {
      gap = true;
      at++;
      continue;
    }
    operators.lastIndex = number.lastIndex = identifier.lastIndex = at;
    const token = number.exec(source) ?? identifier.exec(source) ?? operators.exec(source);
    if (token) {
      emit(token[0], at);
      at += token[0].length;
    } else {
      const point = String.fromCodePoint(source.codePointAt(at));
      emit(point, at);
      at += point.length;
    }
  }
  return result;
}

function opaqueTokens(source) {
  return preprocessingTokens(source).map(({ text }) => text);
}

function tokenGaps(source) {
  return preprocessingTokens(source).map(({ text, separated }) => [separated, text]);
}

/** Macro definitions are lexical directives, never text inside comments/literals.
 * Include all project definitions because replacement lists and forwarded macro
 * arguments can themselves be stringified by another macro.
 */
export function projectMacros(sources) {
  const names = new Set();
  for (const source of sources) {
    if (!source.isWellFormed()) continue;
    const logical = source.replace(/\\\r?\n/g, "");
    const parts = [];
    let cursor = 0;
    for (const token of cppTokens(logical)) {
      if (/^[A-Za-z_]\w*$/.test(token.text)) continue;
      parts.push(logical.slice(cursor, token.start), token.text.replace(/[^\r\n]/g, " "));
      cursor = token.end;
    }
    parts.push(logical.slice(cursor));
    for (const match of parts
      .join("")
      .matchAll(/^[\t ]*#[\t ]*define[\t ]+([\p{ID_Start}_][\p{ID_Continue}_]*)/gmu))
      names.add(match[1]);
  }
  return names;
}

function splitMacroArguments(tokens) {
  // Only parentheses protect commas from the preprocessor; brackets, braces and
  // template syntax do not. Keep physical separator tokens for the sidecar.
  const wrapped = tokens[0]?.text === "(" && tokens.at(-1)?.text === ")";
  const inner = wrapped ? tokens.slice(1, -1) : tokens;
  const groups = [[]],
    commas = [];
  let depth = 0;
  for (const token of inner) {
    if (token.text === "(") depth++;
    else if (token.text === ")") depth--;
    if (token.text === "," && depth === 0) {
      groups.push([]);
      commas.push(token);
    } else groups.at(-1).push(token);
  }
  return { groups, commas, wrapped };
}

function macroArguments(source) {
  return splitMacroArguments(preprocessingTokens(source)).groups.map((group) =>
    group.map(({ text, separated }, index) => [index > 0 && separated, text]),
  );
}

function sourcePart(node, type, start, end, value, children = []) {
  return {
    type,
    start: node.startIndex + start,
    end: node.startIndex + end,
    container: false,
    sortable: false,
    owner: null,
    key: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    children,
  };
}

function positionedTokens(source) {
  const tokens = [];
  preprocessingTokens(source, (token) => {
    tokens.push(token);
  });
  return tokens;
}

function preprocessingProjection(node, tokens, includeGaps) {
  const children = [];
  for (const [at, token] of tokens.entries()) {
    if (includeGaps && at > 0)
      children.push(
        sourcePart(node, "macro_gap", tokens[at - 1].end, token.start, token.separated),
      );
    children.push(sourcePart(node, "preprocessing_token", token.start, token.end, token.text));
  }
  return children;
}

function macroArgumentProjection(node) {
  const tokens = positionedTokens(node.text);
  const { groups, commas, wrapped } = splitMacroArguments(tokens);
  const children = [];
  for (const [index, group] of groups.entries()) {
    children.push(
      sourcePart(
        node,
        "macro_argument",
        index > 0 ? commas[index - 1].end : wrapped ? tokens[0].end : 0,
        commas[index]?.start ?? (wrapped ? tokens.at(-1).start : node.text.length),
        group.map(({ text, separated }, at) => [at > 0 && separated, text]),
        preprocessingProjection(node, group, true),
      ),
    );
    const comma = commas[index];
    if (comma) children.push(sourcePart(node, "macro_comma", comma.start, comma.end, comma.text));
  }
  return children;
}

const containers = new Set([
  "translation_unit",
  "declaration_list",
  "field_declaration_list",
  "preproc_if",
  "preproc_ifdef",
  "preproc_else",
  "preproc_elif",
]);
const definitions = new Set([
  "function_definition",
  "class_specifier",
  "struct_specifier",
  "union_specifier",
  "enum_specifier",
  "namespace_definition",
]);
const classDefinitions = new Set([
  "class_specifier",
  "struct_specifier",
  "union_specifier",
  "enum_specifier",
]);

function sortable(node) {
  if (node.hasError) return false;
  if (definitions.has(node.type)) return true;
  if (node.type === "template_declaration") return node.namedChildren.some(sortable);
  if (
    !["declaration", "field_declaration"].includes(node.type) ||
    node.children.some((child) => child.type === ",")
  )
    return false;
  let declarator = node.childForFieldName("declarator");
  while (
    declarator &&
    ["pointer_declarator", "reference_declarator", "attributed_declarator"].includes(
      declarator.type,
    )
  )
    declarator = declarator.childForFieldName("declarator");
  return (
    declarator?.type === "function_declarator" &&
    [
      "identifier",
      "field_identifier",
      "qualified_identifier",
      "destructor_name",
      "operator_name",
    ].includes(declarator.childForFieldName("declarator")?.type)
  );
}

function nodeKey(node) {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function definitionKey(node, cache) {
  const key = nodeKey(node);
  if (cache.keys.has(key)) return cache.keys.get(key);
  const tokens = [],
    stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current.type === "comment" || current.isMissing) continue;
    if (current.type === "preproc_arg") {
      tokens.push(tokenGaps(current.text));
      continue;
    }
    if (
      literals.has(current.type) ||
      current.type === "user_defined_literal" ||
      !current.childCount
    ) {
      tokens.push(current.text);
      continue;
    }
    const children = canonicalChildren(current, cache);
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  const value = JSON.stringify(tokens);
  cache.keys.set(key, value);
  return value;
}
function canonicalChildren(node, cache) {
  const key = nodeKey(node);
  if (cache.children.has(key)) return cache.children.get(key);
  const children = node.children.filter((child) => child.type !== "comment");
  if (!containers.has(node.type)) return children;
  // A standalone class definition and its trailing semicolon are one block.
  // Non-sortable member slots retain their relative positions and layout.
  const units = [];
  for (let index = 0; index < children.length; index++) {
    const child = children[index],
      nodes = [child];
    if (classDefinitions.has(child.type) && children[index + 1]?.type === ";")
      nodes.push(children[++index]);
    units.push({
      nodes,
      sortable: sortable(child),
      barrier:
        child.hasError ||
        child.type === "access_specifier" ||
        (["translation_unit", "declaration_list"].includes(node.type) &&
          child.isNamed &&
          !sortable(child)) ||
        child.type.startsWith("preproc_") ||
        child.type.startsWith("#"),
    });
  }
  const result = [],
    segment = [];
  const flush = () => {
    const ordered = segment
      .filter((unit) => unit.sortable)
      .map((unit) => ({
        ...unit,
        key: JSON.stringify(unit.nodes.map((part) => definitionKey(part, cache))),
      }));
    ordered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let next = 0;
    for (const unit of segment)
      result.push(...(unit.sortable ? ordered[next++].nodes : unit.nodes));
    segment.length = 0;
  };
  for (const unit of units) {
    if (unit.barrier) {
      flush();
      result.push(...unit.nodes);
    } else segment.push(unit);
  }
  flush();
  cache.children.set(key, result);
  return result;
}

// Break complete source statements, never individual parser records. The parser
// chooses definition order; its nodes and bookkeeping are not serialized.
const sourceLines = new Set([
  "declaration",
  "field_declaration",
  "expression_statement",
  "return_statement",
  "break_statement",
  "continue_statement",
  "throw_statement",
  "static_assert_declaration",
  "alias_declaration",
  "using_declaration",
  "function_definition",
  "namespace_definition",
  "template_declaration",
]);

function render(root, macros) {
  const cache = { children: new Map(), keys: new Map() };
  const lines = [],
    errors = [];
  let current = "",
    indent = 0,
    parentheses = 0,
    brackets = 0;
  const flush = () => {
    if (current) lines.push("  ".repeat(Math.min(indent, 64)) + current);
    current = "";
  };
  const append = (value, joined = false) => {
    if (current && !joined) current += " ";
    current += value;
  };
  const emit = (node) => {
    const value = node.text;
    if (node.type === "\n") {
      flush();
      return;
    }
    if (value.startsWith("#")) flush();
    if (value === "}") {
      flush();
      indent = Math.max(0, indent - 1);
    }
    append(value);
    if (value === "(") parentheses++;
    else if (value === ")") parentheses = Math.max(0, parentheses - 1);
    else if (value === "[") brackets++;
    else if (value === "]") brackets = Math.max(0, brackets - 1);
    else if (value === "{") {
      flush();
      indent++;
    } else if (value === ";" && !parentheses && !brackets) flush();
  };
  // Keep diagnostics independently, including inside atomic literals/macro args.
  const diagnosticStack = [root];
  while (diagnosticStack.length) {
    const node = diagnosticStack.pop();
    if (node.isError || node.isMissing)
      errors.push({ kind: node.isMissing ? "missing" : "syntax", type: node.type });
    for (let index = node.childCount - 1; index >= 0; index--)
      diagnosticStack.push(node.child(index));
  }
  const gaps = (tokens) =>
    tokens.map(([separated, value]) => (separated ? " " : "") + value).join("");
  const stack = [{ node: root }];
  while (stack.length) {
    const item = stack.pop();
    const node = item.node,
      type = node.type;
    const directive =
      type.startsWith("preproc_") &&
      !["preproc_arg", "preproc_params", "preproc_defined"].includes(type);
    if (item.close) {
      if ((sourceLines.has(type) && !parentheses && !brackets) || directive) flush();
      continue;
    }
    if (type === "comment" || node.isMissing) continue;
    if (sourceLines.has(type) && !parentheses && !brackets) flush();
    if (item.macroArguments) {
      append("(" + macroArguments(node.text).map(gaps).join(",") + ")");
      continue;
    }
    if (type === "preproc_params") {
      append(opaqueTokens(node.text).join(" "), true);
      continue;
    }
    if (type === "preproc_arg") {
      append(gaps(tokenGaps(node.text)));
      continue;
    }
    if (literals.has(type) || type === "user_defined_literal") {
      append(node.text);
      continue;
    }
    if (!node.childCount) {
      emit(node);
      continue;
    }
    if (directive) flush();
    const callee = type === "call_expression" ? node.childForFieldName("function") : null;
    const name = callee?.text.match(/([\p{ID_Start}_][\p{ID_Continue}_]*)$/u)?.[1];
    const arguments_ = name && macros.has(name) ? node.childForFieldName("arguments") : null;
    stack.push({ node, close: true });
    const children = canonicalChildren(node, cache);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      stack.push({
        node: child,
        macroArguments: arguments_ && child.startIndex === arguments_.startIndex,
      });
    }
  }
  flush();
  return { text: lines.length ? lines.join("\n") + "\n" : "", errors };
}

// Match overload signatures even when parameter bindings have been renamed.
// Only CST declarator fields identify bindings; type/qualifier/default tokens
// remain exact. This metadata is never used by canonical serialization.
function physicalOwnerIdentity(owner, cache) {
  const bindings = new Set();
  const pending = [owner];
  while (pending.length) {
    const current = pending.pop();
    if (current.type.endsWith("parameter_declaration")) {
      let binding = current.childForFieldName("declarator");
      while (binding) {
        const next =
          binding.childForFieldName("declarator") ??
          (binding.type === "parenthesized_declarator" && binding.namedChildCount === 1
            ? binding.namedChildren[0]
            : null);
        if (!next) break;
        binding = next;
      }
      if (binding && ["identifier", "field_identifier"].includes(binding.type))
        bindings.add(nodeKey(binding));
    }
    pending.push(...current.children);
  }
  const tokens = [];
  pending.push(owner);
  while (pending.length) {
    const current = pending.pop();
    if (current.type === "comment" || current.isMissing) continue;
    if (bindings.has(nodeKey(current))) tokens.push("$parameter");
    else if (
      literals.has(current.type) ||
      current.type === "user_defined_literal" ||
      !current.childCount
    )
      tokens.push(current.text);
    else {
      const children = canonicalChildren(current, cache);
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
    }
  }
  return JSON.stringify(tokens);
}

/** Optional controller-only source correspondence. These ranges never enter a
 * scoring snapshot: retain the CST's physical owners and the same canonical
 * traversal, rather than trying to turn serialized scoring text back into C++.
 */
function sourceProjection(root, macros) {
  const cache = { children: new Map(), keys: new Map() };
  const values = [];
  const gaps = (tokens) =>
    tokens.map(([separated, value]) => (separated ? " " : "") + value).join("");
  function visit(node, argument = false) {
    if (node.type === "comment" || node.isMissing || node.type === "\n") return null;
    const first = values.length;
    const children = [];
    if (argument) {
      values.push("(" + macroArguments(node.text).map(gaps).join(",") + ")");
      children.push(...macroArgumentProjection(node));
    } else if (node.type === "preproc_params") {
      values.push(opaqueTokens(node.text).join(" "));
      children.push(...preprocessingProjection(node, positionedTokens(node.text), false));
    } else if (node.type === "preproc_arg") {
      values.push(gaps(tokenGaps(node.text)));
      children.push(...preprocessingProjection(node, positionedTokens(node.text), true));
    } else if (literals.has(node.type) || node.type === "user_defined_literal" || !node.childCount)
      values.push(node.text);
    else {
      const callee = node.type === "call_expression" ? node.childForFieldName("function") : null;
      const name = callee?.text.match(/([\p{ID_Start}_][\p{ID_Continue}_]*)$/u)?.[1];
      const arguments_ = name && macros.has(name) ? node.childForFieldName("arguments") : null;
      for (const child of canonicalChildren(node, cache)) {
        const projected = visit(
          child,
          Boolean(arguments_ && child.startIndex === arguments_.startIndex),
        );
        if (projected) children.push(projected);
      }
    }
    if (first === values.length) return null;
    const owner = node.childForFieldName("declarator") ?? node.childForFieldName("name");
    let name = owner;
    while (name?.childForFieldName("declarator")) name = name.childForFieldName("declarator");
    const body = node.childForFieldName("body");
    const wrapped =
      node.type === "template_declaration" ? children.filter((child) => child.sortable) : [];
    const inner = wrapped.length === 1 ? wrapped[0] : null;
    return {
      type: node.type,
      start: node.startIndex,
      end: node.endIndex,
      container: containers.has(node.type),
      sortable: sortable(node),
      owner: owner ? definitionKey(owner, cache) : (inner?.owner ?? null),
      identity: owner ? physicalOwnerIdentity(owner, cache) : (inner?.identity ?? null),
      name: name ? definitionKey(name, cache) : (inner?.name ?? null),
      anchor: body
        ? (children.find((child) => child.start === body.startIndex && child.end === body.endIndex)
            ?.key ?? null)
        : (inner?.anchor ?? null),
      key: createHash("sha256")
        .update(JSON.stringify(values.slice(first)))
        .digest("hex"),
      children,
    };
  }
  return visit(root);
}

// Merge only adjacent, plain named namespace nodes in the parsed structure.
// Preprocessor nodes, attributes, inline namespaces and other scopes remain
// boundaries. Keep the original tree for source projections and coordinates.
function coalesceNamespaceScopes(source, root) {
  const removals = [];
  const plainNamespace = (node) => {
    if (node.type !== "namespace_definition") return null;
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (
      !name ||
      name.hasError ||
      name.isMissing ||
      !body ||
      node.children.length !== 3 ||
      node.children[0].type !== "namespace" ||
      body.firstChild?.type !== "{" ||
      body.lastChild?.type !== "}" ||
      body.lastChild.isMissing
    )
      return null;
    return { name: name.text, body };
  };
  const visit = (node) => {
    const children = node.children.filter((child) => child.type !== "comment");
    let previous = null;
    for (const child of children) {
      const current = plainNamespace(child);
      if (previous && current && previous.name === current.name) {
        removals.push([previous.body.endIndex - 1, previous.body.endIndex]);
        removals.push([child.startIndex, current.body.startIndex + 1]);
      }
      previous = current;
      if (child.childCount) visit(child);
    }
  };
  visit(root);
  if (!removals.length) return source;
  removals.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of removals) source = source.slice(0, start) + source.slice(end);
  return source;
}
/** Input is a lossless source lexical view, as returned by decodeSourceBytes.
 * Invalid UTF-8 uses an explicit byte-preserving representation, never U+FFFD.
 * No candidate file is modified or repaired by this function.
 */
export async function canonicalizeCpp(source, { macros, projection = false } = {}) {
  if (typeof source !== "string") throw new TypeError("Canonical C++ input must be source text");
  if (!source.isWellFormed())
    return {
      text: JSON.stringify(["opaque-bytes", encodeSourceBytes(source).toString("base64")]) + "\n",
      errors: [{ kind: "encoding", type: "invalid-utf8" }],
    };
  const loaded = await language(),
    parser = new Parser();
  parser.setLanguage(loaded.language);
  let tree;
  try {
    tree = parser.parse(source);
    if (!tree) throw new Error("The canonical parser did not produce a syntax tree");
    const context = macros ?? projectMacros([source]);
    const normalized = coalesceNamespaceScopes(source, tree.rootNode);
    if (normalized === source) {
      const result = render(tree.rootNode, context);
      return projection
        ? { ...result, projection: sourceProjection(tree.rootNode, context) }
        : result;
    }
    const normalizedTree = parser.parse(normalized);
    if (!normalizedTree) throw new Error("The canonical parser did not produce a normalized tree");
    try {
      const result = render(normalizedTree.rootNode, context);
      return projection
        ? { ...result, projection: sourceProjection(tree.rootNode, context) }
        : result;
    } finally {
      normalizedTree.delete();
    }
  } finally {
    tree?.delete();
    parser.delete();
  }
}

function validateFile(file) {
  if (
    typeof file !== "string" ||
    !file ||
    /[\\\x00-\x1f\x7f]/.test(file) ||
    file.startsWith("/") ||
    /^[A-Za-z]:/.test(file) ||
    file.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new TypeError("Canonical snapshot paths must be unambiguous project-relative files");
}

/** Include every captured file. Non-C++ contents remain explicit original bytes.
 * File presence is serialized even for empty/comment-only files. Source strings
 * use the existing byte-preserving lexical codec; Buffer inputs use that codec.
 */
export async function canonicalizeProject(tree) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree))
    throw new TypeError("Canonical project input must be a source tree");
  const files = [],
    errors = [];
  const sources = new Map();
  for (const file of Object.keys(tree).sort()) {
    validateFile(file);
    let source = tree[file];
    if (Buffer.isBuffer(source)) source = decodeSourceBytes(source);
    if (typeof source !== "string")
      throw new TypeError("Canonical project contents must be source text or bytes");
    sources.set(file, source);
  }
  const macros = projectMacros(
    [...sources].filter(([file]) => cppExtension.test(file)).map(([, source]) => source),
  );
  for (const [file, source] of sources) {
    const result = cppExtension.test(file)
      ? await canonicalizeCpp(source, { macros })
      : {
          text:
            JSON.stringify(["opaque-bytes", encodeSourceBytes(source).toString("base64")]) + "\n",
          errors: [],
        };
    files.push([
      file,
      cppExtension.test(file) && source.isWellFormed()
        ? result.text
        : JSON.stringify(["file", file]) + "\n" + result.text,
    ]);
    for (const error of result.errors) errors.push({ file, ...error });
  }
  const canonicalizer = (await language()).identity;
  const result = { version, canonicalizer, files: Object.fromEntries(files), errors };
  return { ...result, sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
