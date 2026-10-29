import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { decodeSourceBytes, encodeSourceBytes } from "../cpp/source-bytes.mjs";

const require = createRequire(import.meta.url);
const version = "renderer-canonical-snapshot-v1";
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
        serialization: "cst-token-lines-v2",
        macroLayout: "project-definitions-and-arguments-token-gaps-v1",
      },
    };
  })();
  return initialized;
}

/** Opaque preprocessor replacements still contain C++ preprocessing tokens.
 * Reuse the project's protected literal/comment scanner; maximal-munch operators
 * and numbers keep `+ +` distinct from `++` instead of stripping all whitespace.
 */
function preprocessingTokens(source) {
  const protectedTokens = new Map(
    cppTokens(source)
      .filter((token) => !/^[A-Za-z_]\w*$/.test(token.text))
      .map((token) => [token.start, token]),
  );
  const result = [];
  let gap = false;
  const emit = (text) => {
    result.push({ text, separated: result.length > 0 && gap });
    gap = false;
  };
  for (let at = 0; at < source.length;) {
    const protectedToken = protectedTokens.get(at);
    if (protectedToken) {
      if (protectedToken.text.startsWith("//") || protectedToken.text.startsWith("/*")) gap = true;
      else emit(protectedToken.text);
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
      emit(token[0]);
      at += token[0].length;
    } else {
      const point = String.fromCodePoint(source.codePointAt(at));
      emit(point);
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
function projectMacros(sources) {
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

function macroArguments(source) {
  const tokens = preprocessingTokens(source);
  // The CST argument-list node owns its outer parentheses. Only parentheses
  // protect commas from the preprocessor; brackets and braces do not.
  const inner =
    tokens[0]?.text === "(" && tokens.at(-1)?.text === ")" ? tokens.slice(1, -1) : tokens;
  const arguments_ = [[]];
  let depth = 0;
  for (const token of inner) {
    if (token.text === "(") depth++;
    else if (token.text === ")") depth--;
    if (token.text === "," && depth === 0) arguments_.push([]);
    else {
      const current = arguments_.at(-1);
      current.push([current.length > 0 && token.separated, token.text]);
    }
  }
  return arguments_;
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

function canonicalChildren(node) {
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
        key: JSON.stringify(unit.nodes.flatMap((part) => opaqueTokens(part.text))),
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
  return result;
}

function render(root, macros) {
  const lines = [],
    errors = [];
  const stack = [{ node: root }];
  while (stack.length) {
    const item = stack.pop();
    if (item.close) {
      lines.push(JSON.stringify(["end", item.close]));
      continue;
    }
    const node = item.node,
      type = node.type;
    if (type === "comment") continue;
    if (node.isError || node.isMissing)
      errors.push({ kind: node.isMissing ? "missing" : "syntax", type });
    if (node.isMissing) {
      lines.push(JSON.stringify(["missing", type]));
      continue;
    }
    if (literals.has(type)) {
      lines.push(JSON.stringify([type, node.text]));
      continue;
    }
    if (type === "preproc_arg") {
      lines.push(JSON.stringify([type, tokenGaps(node.text)]));
      continue;
    }
    if (!node.childCount) {
      lines.push(JSON.stringify([type, type === "\n" ? "\n" : node.text]));
      continue;
    }
    lines.push(JSON.stringify([type]));
    if (type === "call_expression") {
      const callee = node.childForFieldName("function");
      const name = callee?.text.match(/([\p{ID_Start}_][\p{ID_Continue}_]*)$/u)?.[1];
      const arguments_ = node.childForFieldName("arguments");
      if (name && macros.has(name) && arguments_)
        lines.push(JSON.stringify(["macro-argument-gaps", macroArguments(arguments_.text)]));
    }
    stack.push({ close: type });
    const children = canonicalChildren(node);
    for (let index = children.length - 1; index >= 0; index--)
      stack.push({ node: children[index] });
  }
  return { text: lines.join("\n") + "\n", errors };
}

/** Input is a lossless source lexical view, as returned by decodeSourceBytes.
 * Invalid UTF-8 uses an explicit byte-preserving representation, never U+FFFD.
 * No candidate file is modified or repaired by this function.
 */
export async function canonicalizeCpp(source, { macros } = {}) {
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
    return render(tree.rootNode, macros ?? projectMacros([source]));
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
    files.push([file, JSON.stringify(["file", file]) + "\n" + result.text]);
    for (const error of result.errors) errors.push({ file, ...error });
  }
  const canonicalizer = (await language()).identity;
  const result = { version, canonicalizer, files: Object.fromEntries(files), errors };
  return { ...result, sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
