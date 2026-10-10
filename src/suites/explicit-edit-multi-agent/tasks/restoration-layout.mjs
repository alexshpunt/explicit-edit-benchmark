import { createHash } from "node:crypto";
import { cppTokens, treeIdentity } from "../generation/generator.mjs";
import { undoFunctionMix } from "../generation/function-mix.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function monolith(tree, record, kind) {
  if (record.kind !== kind || Object.keys(tree).join() !== "main.cpp")
    throw new Error("Unsupported layout restoration input");
  if (treeIdentity(tree) !== record.after) throw new Error("Layout source identity differs");
  return Buffer.from(tree["main.cpp"]);
}

/** Yield small private reference swaps that undo a guarded function permutation.
 * Fix the first misplaced slot using its original definition; the displaced definition
 * moves later, retaining the generator's fixed-declaration lower bounds. Namespace and
 * other gap bytes stay in their original slots. Every state still needs compiler/render
 * verification: these records are not an independent executor or public requests.
 */
export function* restoreFunctionLayout(tree, record) {
  const bytes = monolith(tree, record, "function-permutation");
  const slots = record.slots;
  if (!Array.isArray(slots) || !slots.length) throw new Error("Missing permutation slots");
  const units = new Map();
  const gaps = [];
  let cursor = 0;
  for (const [index, slot] of slots.entries()) {
    if (
      slot.original !== index ||
      !Number.isInteger(slot.occupant) ||
      slot.occupant < 0 ||
      slot.occupant >= slots.length ||
      units.has(slot.occupant)
    )
      throw new Error("Invalid slot permutation occupant");
    if (
      !Number.isInteger(slot.start) ||
      !Number.isInteger(slot.end) ||
      slot.start < cursor ||
      slot.end <= slot.start ||
      slot.end > bytes.length
    )
      throw new Error("Invalid permutation slot span");
    const unit = bytes.subarray(slot.start, slot.end);
    if (hash(unit) !== slot.hash) throw new Error("Function slot hash differs");
    units.set(slot.occupant, unit);
    gaps.push(bytes.subarray(cursor, slot.start));
    cursor = slot.end;
  }
  gaps.push(bytes.subarray(cursor));
  const expected = undoFunctionMix(tree, record);
  const occupants = slots.map((slot) => slot.occupant);
  const render = () => ({
    "main.cpp": Buffer.concat([
      ...occupants.flatMap((occupant, index) => [gaps[index], units.get(occupant)]),
      gaps.at(-1),
    ]).toString("utf8"),
  });
  for (let index = 0; index < occupants.length; index++) {
    if (occupants[index] === index) continue;
    const other = occupants.indexOf(index);
    if (other <= index) throw new Error("Invalid restoration permutation prefix");
    [occupants[index], occupants[other]] = [occupants[other], occupants[index]];
    yield { phase: "structure", action: "swap-definitions", slots: [index, other], tree: render() };
  }
  if (treeIdentity(render()) !== treeIdentity(expected))
    throw new Error("Layout restoration identity differs");
}

function declarations(text) {
  let masked = "",
    cursor = 0;
  for (const token of cppTokens(text)) {
    if (/^[A-Za-z_]\w*$/.test(token.text)) continue;
    masked += text.slice(cursor, token.start) + token.text.replace(/[^\r\n]/g, " ");
    cursor = token.end;
  }
  masked += text.slice(cursor);
  const spans = [];
  let round = 0,
    square = 0,
    start = 0;
  for (let index = 0; index < masked.length; index++) {
    const character = masked[index];
    if (character === "(") round++;
    if (character === ")") round--;
    if (character === "[") square++;
    if (character === "]") square--;
    if (round < 0 || square < 0 || character === "{" || character === "}")
      throw new Error("Unsupported generated declaration boundary");
    if (character !== ";" || round || square) continue;
    let end = index + 1;
    while (end < masked.length && /\s/.test(masked[end])) end++;
    if (!text.slice(start, index).trim()) throw new Error("Empty generated declaration");
    spans.push({
      start: Buffer.byteLength(text.slice(0, start)),
      end: Buffer.byteLength(text.slice(0, end)),
    });
    start = end;
    index = end - 1;
  }
  if (round || square || start !== text.length || !spans.length)
    throw new Error("Incomplete generated declarations");
  return spans;
}

/** Remove each recorded generated prototype in a separate private reference transition.
 * Call only after definition layout is restored. Guard exact physical spans and the
 * complete inverse identity before yielding; do not search by an ambiguous name.
 */
export function* removeGeneratedDeclarations(tree, record) {
  const bytes = monolith(tree, record, "function-declarations");
  const expected = undoFunctionMix(tree, record);
  const parts = [];
  let cursor = 0;
  for (const edit of record.edits) {
    const size = Buffer.byteLength(edit.text);
    if (!Number.isInteger(edit.start) || edit.start < cursor || edit.start + size > bytes.length)
      throw new Error("Invalid generated declaration span");
    if (bytes.subarray(edit.start, edit.start + size).toString("utf8") !== edit.text)
      throw new Error("Generated declaration span differs");
    for (const span of declarations(edit.text))
      parts.push({ start: edit.start + span.start, end: edit.start + span.end });
    cursor = edit.start + size;
  }
  const removed = [];
  let latest = tree;
  for (const [index, part] of parts.entries()) {
    removed.push(part);
    const chunks = [];
    cursor = 0;
    for (const span of removed) {
      chunks.push(bytes.subarray(cursor, span.start));
      cursor = span.end;
    }
    chunks.push(bytes.subarray(cursor));
    latest = { "main.cpp": Buffer.concat(chunks).toString("utf8") };
    yield {
      phase: "structure",
      action: "remove-generated-declaration",
      declaration: index,
      tree: latest,
    };
  }
  if (treeIdentity(expected) !== treeIdentity(latest))
    throw new Error("Generated declaration restoration identity differs");
}
