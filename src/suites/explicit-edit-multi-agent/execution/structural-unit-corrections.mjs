import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const STRUCTURAL_UNIT_CORRECTION_POLICY = Object.freeze({
  version: "renderer-structural-unit-corrections-v1",
  grouping: "one-file-per-assignment",
  maximumItems: 20,
  maximumBytes: 12_000,
});

const hash = (value) => createHash("sha256").update(value).digest("hex");

function block(text) {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}\n${text}\n${fence}`;
}

function scopeText(scope) {
  return scope.length ? scope.join(" / ") : "file level, outside any namespace or class";
}

/** The previous order-sensitive unit in the required result, if the unit is order-sensitive. */
function orderHint(prepared, difference) {
  const { unit, unitId } = difference;
  if (!unit.ordered || difference.action !== "add" || unit.kind === "empty-scope") return "";
  const key = JSON.stringify([unit.file, unit.scope]);
  for (const inventory of [prepared.reference, prepared.start]) {
    const sequence = inventory.scopes.get(key)?.ordered ?? [];
    const index = sequence.indexOf(unitId);
    if (index < 0) continue;
    if (index === 0)
      return "Order matters for this code. In the required result, no other order-sensitive code comes before it in this scope.";
    const previous = inventory.catalog.get(sequence[index - 1]);
    return `Order matters for this code. In the required result, it comes after this code in the same scope:\n${block(previous.text)}`;
  }
  return "";
}

function item(prepared, difference, number) {
  const { unit, action } = difference;
  const scope = `Scope: ${scopeText(unit.scope)}.`;
  let body;
  if (unit.kind === "empty-scope")
    body =
      action === "add"
        ? unit.scope.length
          ? `This scope must exist and contain no code. ${scope}`
          : "The file must exist and contain no code."
        : unit.scope.length
          ? `This scope must not be empty: either add the required code to it or remove the scope. ${scope}`
          : "The file must not be empty: either add the required code or delete the file.";
  else if (unit.kind === "physical-entry")
    body =
      action === "add"
        ? `This path must be a ${unit.text}.`
        : `Remove this ${unit.text} at the path; the required result has no such entry there.`;
  else if (unit.kind === "bytes")
    body =
      action === "add"
        ? `The file must have a specific content that is not UTF-8 text (${unit.text}). Restore that exact content.`
        : `The file must not have this content that is not UTF-8 text (${unit.text}).`;
  else {
    const noun = unit.kind === "line" ? "line" : "code";
    body = [
      action === "add"
        ? `Add one copy of this ${noun}. ${scope}`
        : `Remove one copy of this ${noun}. ${scope}`,
      block(unit.text),
      orderHint(prepared, difference),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `${number}. ${body}`;
}

function heading(file, part, parts, required) {
  return [
    `Correct the structure of the project file ${JSON.stringify(file)}${parts > 1 ? ` (part ${part} of ${parts})` : ""}.`,
    required
      ? "If the file does not exist, create it."
      : "This file does not exist in the required result. Delete the whole file; the items below show what it currently contains.",
    "A structural comparison with the required result found the differences listed below. Each item is one unit: a function, a class member, a declaration, a preprocessor directive, or a line of a non-C++ file. Code is shown with tokens separated by spaces; comments, spacing and line breaks are not compared, and the placement of functions within the same scope does not matter.",
    "Inspect the current file before editing. Make only these changes and keep all other code unchanged. Other participants may be editing other parts of the project at the same time.",
  ].join("\n\n");
}

/** Prose assignments that name every disagreeing unit of a comparison, grouped by file. */
export function structuralUnitCorrections(prepared, comparison) {
  assert.equal(comparison.startIdentity, prepared.startIdentity);
  assert.equal(comparison.referenceIdentity, prepared.referenceIdentity);
  const byFile = new Map();
  for (const difference of comparison.differences) {
    if (!byFile.has(difference.unit.file)) byFile.set(difference.unit.file, []);
    byFile.get(difference.unit.file).push(difference);
  }
  const assignments = [];
  for (const [file, differences] of byFile) {
    const groups = [];
    let current = [],
      bytes = 0;
    for (const difference of differences) {
      const size = Buffer.byteLength(item(prepared, difference, 0));
      if (
        current.length &&
        (current.length >= STRUCTURAL_UNIT_CORRECTION_POLICY.maximumItems ||
          bytes + size > STRUCTURAL_UNIT_CORRECTION_POLICY.maximumBytes)
      ) {
        groups.push(current);
        current = [];
        bytes = 0;
      }
      current.push(difference);
      bytes += size;
    }
    groups.push(current);
    groups.forEach((members, index) => {
      assignments.push({
        id: `units-${hash(file).slice(0, 16)}-${index + 1}`,
        file,
        differenceIds: members.map(({ id }) => id),
        prompt: [
          heading(file, index + 1, groups.length, prepared.reference.files.has(file)),
          ...members.map((difference, number) => item(prepared, difference, number + 1)),
        ].join("\n\n"),
      });
    });
  }
  return assignments;
}
