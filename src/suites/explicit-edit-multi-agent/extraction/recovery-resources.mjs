import { canonicalizeCpp, projectMacros } from "../grading/canonical-snapshot.mjs";
import { decodeSourceBytes } from "../cpp/source-bytes.mjs";

const lexical = (value) => (Buffer.isBuffer(value) ? decodeSourceBytes(value) : value);
const containers = new Set([
  "namespace_definition",
  "preproc_if",
  "preproc_ifdef",
  "preproc_elif",
  "linkage_specification",
]);
const completeUnits = new Set([
  "function_definition",
  "template_declaration",
  "declaration",
  "class_specifier",
  "struct_specifier",
  "union_specifier",
  "enum_specifier",
  "type_definition",
  "alias_declaration",
  "using_declaration",
  "namespace_alias_definition",
  "static_assert_declaration",
  "preproc_include",
  "preproc_def",
  "preproc_function_def",
  "preproc_call",
]);

/** Conservative edit footprints for ONE already assessed immutable snapshot.
 * Diagnostic spans must identify complete current CST units. They are planning
 * resources, never edit selectors. Include enclosing physical namespace/branch
 * scaffolding, and serialize unknown/ambiguous source work against all main.cpp.
 * @typedef {{file: string, range?: [number, number]}} Resource
 */
export async function recoveryResources(tree, structure) {
  const source = lexical(tree["main.cpp"]);
  const nodes = [];
  let malformed = typeof source !== "string" || !source.isWellFormed();
  if (!malformed && structure.files.some(({ sourceMatched }) => !sourceMatched)) {
    const projection = await canonicalizeCpp(source, {
      macros: projectMacros(Object.values(tree).map(lexical)),
      projection: true,
    });
    malformed ||= projection.errors.length > 0;
    function visit(node, wrappers, scope) {
      if (node.type === "ERROR") malformed = true;
      const next = containers.has(node.type) ? [...wrappers, node] : wrappers;
      const names =
        node.type === "namespace_definition" ? [...scope, node.owner ?? node.name ?? ""] : scope;
      if (completeUnits.has(node.type))
        nodes.push({ node, wrappers, key: JSON.stringify([names, node.type, node.key]) });
      for (const child of node.children) visit(child, next, names);
    }
    visit(projection.projection, [], []);
  }
  const counts = new Map();
  for (const { key } of nodes) counts.set(key, (counts.get(key) ?? 0) + 1);
  const result = new Map();
  for (const file of structure.files) {
    const resources = /** @type {Resource[]} */ ([{ file: file.file }]);
    result.set(file.id, resources);
    if (file.sourceMatched) continue;
    const diagnostics = structure.diagnostics.filter(
      (d) => d.id === file.id && d.file === "main.cpp",
    );
    const ranges = [];
    let unknown = malformed || diagnostics.length === 0;
    for (const diagnostic of diagnostics) {
      const matches = nodes.filter(
        ({ node }) => node.start === diagnostic.start && node.end === diagnostic.end,
      );
      if (
        diagnostic.kind !== "source-residue" ||
        matches.length !== 1 ||
        counts.get(matches[0].key) !== 1
      ) {
        unknown = true;
        break;
      }
      const { node, wrappers } = matches[0];
      const envelope = wrappers[0] ?? node;
      ranges.push(/** @type {[number, number]} */ ([envelope.start, envelope.end]));
    }
    if (unknown) resources.push({ file: "main.cpp" });
    else for (const range of ranges) resources.push({ file: "main.cpp", range });
  }
  return result;
}
