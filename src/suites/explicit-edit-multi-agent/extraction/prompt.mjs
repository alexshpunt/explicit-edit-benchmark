import assert from "node:assert/strict";

function fileAssignment(task) {
  const parts = [];
  let cursor = 0;
  for (const fragment of task.fragments) {
    const start = task.destination.indexOf(fragment.text, cursor);
    assert.ok(start >= cursor && fragment.text.length > 0);
    parts.push(task.destination.slice(cursor, start), `[[${fragment.id}]]`);
    cursor = start + fragment.text.length;
  }
  parts.push(task.destination.slice(cursor));
  return [
    `Extract the complete current file into ${task.file}.`,
    "Move every assigned fragment below in its listed order. Locate complete current units in their stated namespace. Keep every identifier, prototype, definition, comment, literal and inactive branch unchanged.",
    "Assemble the destination with the template below. Replace each [[fragment-id]] slot with that complete source fragment. Keep the template's includes, namespace shells, imports and conditional wrappers in their shown positions. Keep an activation include after its implementation macro.",
    parts.join(""),
    task.replacement
      ? `Replace the first removed source fragment in main.cpp with:\n\n${task.replacement}`
      : "Remove the assigned source fragments from main.cpp without inserting another include.",
    "Retain shared namespace shells, standard-library imports and include context in main.cpp where peer fragments still need them. Preserve every unassigned fragment. Coordinate shared writes and re-read current source before publishing your edit.",
    "Complete this one whole-file assignment and finish. Do not rename, reorder, clean up, compile or render. Final verification runs after every participant closes.",
    ...task.fragments.map(
      ({ id, text, scope }, index) =>
        `Source fragment ${index + 1} (${id}), namespace ${scope || "(global)"}:\n\n${text}`,
    ),
  ].join("\n\n");
}

/** Render one complete assignment without the old atomic or JSON-hunk wrapper. */
export function moduleExtractionPrompt(task) {
  if (task.kind === "implementation" || task.kind === "vendor-header") return fileAssignment(task);
  const includes = task.includes.length
    ? task.includes.map((file) => `#include "${file}"`).join("\n")
    : "(none)";
  const replacement = task.replacement
    ? `Replace the first owned source fragment in main.cpp with:\n\n${task.replacement}`
    : `Remove your owned source fragments without adding an include to main.cpp. The enclosing module ${task.parent} restores its own direct includes.`;
  return [
    `Extract the complete current module into ${task.file}.`,
    `Locate your source envelope in main.cpp by the matching ${task.guard} header guard. Use its current matching closing directive, not an old offset or a global occurrence of #endif.`,
    "Move only the complete owned fragments below. Keep every current identifier, declaration, definition, comment, literal and preprocessor condition unchanged. Preserve all intervening fragments owned by other modules, including nested guards.",
    `Assemble ${task.file} from these fragments in their listed order. Insert the following direct project includes immediately after #define ${task.guard}; retain existing standard-library includes and the complete guard and namespace scaffolding:\n\n${includes}`,
    replacement,
    "Treat main.cpp as shared source. Coordinate shared writes and re-read current content before publishing an edit so that peer changes survive. Leave unrelated source and blank boundary layout alone. Do not rename, reorder or cosmetically clean up code.",
    "Complete this one module assignment and finish. Do not compile or render; final verification runs after all participants close.",
    ...task.fragments.map(
      ({ id, text }, index) => `Source fragment ${index + 1} (${id}):\n\n${text}`,
    ),
  ].join("\n\n");
}
