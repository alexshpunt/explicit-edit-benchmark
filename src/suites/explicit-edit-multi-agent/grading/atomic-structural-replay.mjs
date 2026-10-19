import { cppStructure } from "../cpp/cpp-structure.mjs";
import { applyCoherentStructure } from "../reference/coherent-edit.mjs";
import { locateImplementation } from "../reference/implementation-edit.mjs";

const move = (tree, node) => node.operations.reduce(applyCoherentStructure, tree);

function removal(node) {
  if (node.operations.length !== 1) return;
  const operation = node.operations[0];
  if (
    operation.action === "remove-generated-declaration" &&
    operation.selector?.definition === false &&
    operation.selector.occurrence === undefined &&
    typeof operation.selector.declarator === "string" &&
    operation.selector.declarator.includes("(") &&
    /^[A-Za-z_]\w*\.cpp$/.test(operation.file)
  )
    return operation;
}

function removeTogether(tree, operations) {
  const file = operations[0].file;
  const source = tree[file];
  try {
    const structure = cppStructure(source, { expandNamespaceConditionals: true });
    const ranges = operations.map((operation) =>
      locateImplementation(source, operation.selector, structure),
    );
    for (const unit of ranges) {
      const text = source.slice(unit.start, unit.end);
      if (
        unit.kind !== "declaration" ||
        unit.definition ||
        !text.trimEnd().endsWith(";") ||
        /[{}]/.test(text)
      )
        return;
    }
    ranges.sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index++)
      if (ranges[index - 1].end > ranges[index].start) return;
    let result = "";
    let cursor = 0;
    for (const unit of ranges) {
      result += source.slice(cursor, unit.start);
      cursor = unit.end;
    }
    return { ...tree, [file]: result + source.slice(cursor) };
  } catch {
    // Earlier sequential removals may disambiguate a later selector. Unsupported
    // or invalid batches use the original editor, including its original errors.
    return;
  }
}

/** Replay ordered controller-owned structural nodes byte for byte. Consecutive,
 * disjoint plain declaration removals in one file share a single parse; all
 * other operations retain the ordinary sequential editor. This only constructs
 * trusted expected source: it never batches agent deliveries or grades candidate
 * edits, and it retains no source history or completion decisions.
 */
export function replayStructuralNodes(tree, nodes) {
  for (let index = 0; index < nodes.length;) {
    const first = removal(nodes[index]);
    let end = index + 1;
    if (first) while (end < nodes.length && removal(nodes[end])?.file === first.file) end++;
    if (end > index + 1) {
      const next = removeTogether(tree, nodes.slice(index, end).map(removal));
      if (next) tree = next;
      else for (let item = index; item < end; item++) tree = move(tree, nodes[item]);
      index = end;
      continue;
    }
    tree = move(tree, nodes[index++]);
  }
  return tree;
}
