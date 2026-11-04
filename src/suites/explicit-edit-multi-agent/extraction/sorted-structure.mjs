import {
  canonicalizeCpp,
  canonicalizeProject,
  projectMacros,
} from "../grading/canonical-snapshot.mjs";
import { decodeSourceBytes } from "../cpp/source-bytes.mjs";

const cppExtension = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ipp|inl|tcc|inc)$/i;
const conditions = new Set(["preproc_if", "preproc_ifdef", "preproc_elif", "preproc_else"]);
const alternative = new Set(["preproc_elif", "preproc_else"]);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function directiveEnd(source, start) {
  let end = start;
  do {
    const newline = source.indexOf("\n", end);
    end = newline < 0 ? source.length : newline + 1;
  } while (end < source.length && /\\\r?\n$/.test(source.slice(start, end)));
  return end;
}

// Only plain named namespaces may be flattened. Attributes, inline namespaces,
// anonymous namespaces and parser recovery nodes remain whole opaque units.
function plainNamespace(node) {
  if (node.type !== "namespace_definition" || node.children.length !== 3) return null;
  const [keyword, name, body] = node.children;
  if (
    keyword.type !== "namespace" ||
    name.type !== "namespace_identifier" ||
    body.type !== "declaration_list" ||
    body.children[0]?.type !== "{" ||
    body.children.at(-1)?.type !== "}"
  )
    return null;
  return { name: name.key, children: body.children.slice(1, -1) };
}

function makeScope() {
  return { units: [], namespaces: new Map(), sequence: [] };
}

function flushScope(scope) {
  const units = [...scope.units];
  for (const [name, nested] of scope.namespaces) {
    const contents = finishScope(nested);
    if (contents.length) units.push(JSON.stringify(["namespace", name, contents]));
  }
  if (units.length) scope.sequence.push(["units", units.sort(order)]);
  scope.units = [];
  scope.namespaces = new Map();
}

function hasPreprocessor(node) {
  return node.type.startsWith("preproc_") || node.children.some(hasPreprocessor);
}

function addNodes(scope, nodes, source) {
  for (const node of nodes) {
    const namespace = plainNamespace(node);
    if (namespace && !hasPreprocessor(node)) {
      if (!scope.namespaces.has(namespace.name)) scope.namespaces.set(namespace.name, makeScope());
      addNodes(scope.namespaces.get(namespace.name), namespace.children, source);
    } else if (namespace) {
      flushScope(scope);
      const nested = makeScope();
      addNodes(nested, namespace.children, source);
      scope.sequence.push(["namespace", namespace.name, finishScope(nested)]);
    } else if (node.type.startsWith("preproc_")) {
      flushScope(scope);
      scope.sequence.push(
        conditions.has(node.type) ? conditional(node, source) : [node.type, node.key],
      );
    } else {
      scope.units.push(JSON.stringify([node.type, node.key]));
    }
  }
}

function finishScope(scope) {
  flushScope(scope);
  return scope.sequence;
}

function conditional(node, source) {
  const end = directiveEnd(source, node.start);
  const head = [];
  const body = [];
  const branches = [];
  const tail = [];
  for (const child of node.children) {
    if (child.end <= end) head.push([child.type, child.key]);
    else if (alternative.has(child.type)) branches.push(conditional(child, source));
    else if (child.type === "#endif") tail.push([child.type, child.key]);
    else body.push(child);
  }
  const scope = makeScope();
  addNodes(scope, body, source);
  return [node.type, head, finishScope(scope), branches, tail];
}

/** Sorted peer structural units; lexical scopes and conditional branches remain distinct.
 * Equality is structural and does not establish compiler binding equivalence.
 */
export async function sortedExtractionCpp(source, { macros } = {}) {
  if (Buffer.isBuffer(source)) source = decodeSourceBytes(source);
  if (typeof source !== "string") throw new TypeError("Expected source text or bytes");
  const result = await canonicalizeCpp(source, { macros, projection: true });
  if (!result.projection) return result.text;
  const scope = makeScope();
  addNodes(scope, result.projection.children, source);
  return JSON.stringify(["sorted-extraction-cpp-v2", finishScope(scope)]) + "\n";
}

/** Validate paths and preserve non-C++ bytes via the existing project codec. */
export async function sortedExtractionProject(tree) {
  const canonical = await canonicalizeProject(tree);
  const sources = Object.entries(tree)
    .filter(([file]) => cppExtension.test(file))
    .map(([, source]) => (Buffer.isBuffer(source) ? decodeSourceBytes(source) : source));
  const macros = projectMacros(sources);
  const files = { ...canonical.files };
  for (const [file, source] of Object.entries(tree)) {
    if (cppExtension.test(file)) {
      const text = Buffer.isBuffer(source) ? decodeSourceBytes(source) : source;
      if (text.isWellFormed()) files[file] = await sortedExtractionCpp(text, { macros });
    }
  }
  return { files };
}
