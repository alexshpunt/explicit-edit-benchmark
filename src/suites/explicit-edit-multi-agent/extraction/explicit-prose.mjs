import assert from "node:assert/strict";

/** Explain the common structural and shared-source obligations without source fragments. */
export function explicitExtractionProse(task, { sorted = false } = {}) {
  if (sorted) {
    const source = task.replacement
      ? `Remove the assigned source portions from main.cpp and add ${task.replacement.trim()} at global scope.`
      : "Remove the assigned source portions from main.cpp without inserting a replacement include.";
    return [
      "Preserve each assigned declaration, definition, body, literal, macro replacement, conditional branch, namespace and required occurrence. Preserve the contents of unrelated project files and residual source. Do not introduce extra files. Ordinary formatting and comments do not affect structural comparison. Non-C++ project files are compared losslessly.",
      "Structural comparison sorts peer units, including includes, within each namespace and conditional branch. Plain named namespaces may be reopened, combined or left empty. Preserve namespace and conditional membership, multiplicities, complete declarations and function bodies, macro payloads and class member structure. This comparison does not prove compiler binding equivalence.",
      source,
    ].join("\n\n");
  }
  let source;
  if (task.kind === "header" || task.kind === "vendor-header") {
    assert.equal(task.replacement, `#include "${task.file}"\n`);
    source =
      task.kind === "header"
        ? `Remove the assigned source portions. Place #include "${task.file}" at the first owned portion's global position: immediately before its outermost enclosing namespace opener, or immediately before that portion if it is already global. Leave preceding preprocessing context in place. If several header replacements share this insertion position, order their include directives by header path.`
        : `Replace the first removed source portion with #include "${task.file}"; remove the other assigned portions without replacement.`;
  } else {
    assert.equal(task.kind, "implementation");
    assert.equal(task.replacement, "");
    source =
      "Remove the assigned source portions from main.cpp without inserting a replacement include.";
  }
  return [
    "Preserve each assigned declaration, definition, body, literal, macro replacement, conditional branch, namespace and required occurrence. Preserve the contents of unrelated project files and residual source. Do not introduce extra files. Keep comments where practical: C++ comments and ordinary formatting do not affect structural comparison, but literal bytes and meaningful macro token spacing do. Non-C++ project files are compared losslessly.",
    "Within one scope and an uninterrupted barrier-free segment, the structural comparison can normalize the placement of function and class definitions; within an access and preprocessing segment of a class, sortable member definitions and function declarations may exchange their existing slots, even across a field, but the positions of field and other non-sortable slots and the number of sortable slots between them must stay unchanged. For moved source entities and directives belonging to this destination, retain their original relative placement across other moved non-sortable declarations such as variables and using declarations, preprocessing directives, conditional and access boundaries. Do not move a definition across such a barrier. Preserve member field order. Adjacent plain namespace blocks with the same name can combine; do not assume other namespace boundaries can disappear. These structural rules do not prove that compiler bindings are unchanged: preserve those bindings as well.",
    ...(task.kind !== "vendor-header" && !task.postamble
      ? [
          "Place the required include preamble before the copied imports and moved entities. In each namespace put its copied imports before that namespace's moved entities; copy each distinct import once and retain their first-occurrence order. Copied imports are not moved source entities.",
        ]
      : []),
    source,
  ].join("\n\n");
}
