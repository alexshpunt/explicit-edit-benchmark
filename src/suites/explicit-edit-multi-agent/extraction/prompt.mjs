/** Render one complete assignment without the old atomic or JSON-hunk wrapper. */
export function moduleExtractionPrompt(task) {
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
