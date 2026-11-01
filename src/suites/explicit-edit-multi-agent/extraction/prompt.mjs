import assert from "node:assert/strict";

/** Recovery keeps the original public file goal, but starts from existing partial work. */
export function moduleRecoveryPrompt(task, { assignmentsDirectory, initialDirectory } = {}) {
  const shared = task.kind === "main-recovery";
  const integration = task.kind === "integration-recovery";
  return [
    shared
      ? "Repair only the unassigned project-preservation damage described in this delivery. Other failed file obligations remain with their original owners. Preserve every destination file, replacement include, residual program unit and conditional or namespace shell not implicated by these diagnostics. Remove unintended inventory entries only when identified here. Do not reconstruct a minimal main.cpp or overwrite it from the original input."
      : integration
        ? task.prompt
        : `Repair the complete extraction obligation for ${task.file}. Inspect both its existing destination and main.cpp before editing. Some or all assigned fragments may already have moved; do not duplicate or reinsert them. Correct the destination and finish removal/replacement in the shared source. The original public goal below describes the required result, not an instruction to blindly create an existing file again.`,
    "This is one bounded recovery delivery, not a new original attempt. Preserve current identifiers, prototypes, inactive branches, comments, namespace context, file payload order and every vendor copy. Do not rename or unshuffle the program. Never replace the workspace with baseline input. Hold flock -x /workspace across every fresh read and write of shared main.cpp; /tmp is private to this participant.",
    ...(assignmentsDirectory
      ? [
          "The following original public file assignments describe the extraction obligations. Read the relevant specifications in full as needed; they are not a private expected project tree:",
          ...task.assignments.map(({ id, file }) => `${file}: ${assignmentsDirectory}/${id}.txt`),
          `The original generated input is available read-only under ${initialDirectory}. Use it only to investigate preserved or damaged unassigned code; it is the original mixed input, not the required residual main.cpp.`,
        ]
      : [moduleExtractionPrompt(task)]),
    ...(task.recovery.verified
      ? [
          task.recovery.verified.sourceMatched
            ? "Source removal and replacement already pass. Repair only the destination; do not edit main.cpp."
            : "Source removal or replacement still fails. Locate the current complete owned units again under the shared lock.",
          task.recovery.verified.targetMatched
            ? "The destination already passes. Preserve that file while repairing the source obligation."
            : "The destination still fails. Check it against the original public assignment without undoing peer work.",
        ]
      : []),
    "Diagnostic positions describe the recorded candidate snapshot, not live edit selectors. Re-read shared source under flock and identify complete current owned units before each edit; preceding or concurrent repairs may have shifted positions.",
    ...(task.recovery.candidateIdentity
      ? [`Diagnostic candidate identity: ${task.recovery.candidateIdentity}`]
      : []),
    `Candidate diagnostics:\n${JSON.stringify(task.recovery.diagnostics, null, 2)}`,
    ...(integration
      ? []
      : [
          "Finish this bounded repair turn without compiling or rendering. The controller checks the shared candidate between conflicting repairs and performs complete final verification after original participants close.",
        ]),
  ].join("\n\n");
}

function codeBlock(text) {
  let length = 3;
  for (const [run] of text.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
  const fence = "`".repeat(length);
  return `${fence}cpp\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

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
    "Assemble the destination from the following fenced C++ template. Replace each [[fragment-id]] slot with that complete source fragment. Copy only the code inside the template fence; keep all instruction paragraphs outside the source file. Keep the template's includes, namespace shells, imports and conditional wrappers in their shown positions. Keep an activation include after its implementation macro.",
    codeBlock(parts.join("")),
    task.replacement
      ? `Replace the first removed source fragment in main.cpp with:\n\n${task.replacement}`
      : "Remove the assigned source fragments from main.cpp without inserting another include.",
    "Retain shared namespace shells, standard-library imports and include context in main.cpp where peer fragments still need them. Preserve every unassigned fragment. Hold an exclusive flock on the shared /workspace directory while re-reading and updating main.cpp; use flock -x /workspace around the whole read-modify-write command. Keep the directory inode unchanged. Use this same shared lock for every participant; /tmp is private to each participant.",
    "Complete this one whole-file assignment and return control. Do not rename, reorder, clean up, compile or render. Shared verification starts after every original file queue finishes; your live context may then receive one bounded repair for a failed obligation.",
    ...task.fragments.map(
      ({ id, text, scope }, index) =>
        `Source fragment ${index + 1} (${id}), namespace ${scope || "(global)"}:\n\n${codeBlock(text)}`,
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
    "Treat main.cpp as shared source. Hold an exclusive flock on the shared /workspace directory while re-reading and updating main.cpp; use flock -x /workspace around the whole read-modify-write command. Keep the directory inode unchanged. Use this same shared lock for every participant; /tmp is private to each participant. Preserve peer changes and leave unrelated source and blank boundary layout alone. Do not rename, reorder or cosmetically clean up code.",
    "Complete this one module assignment and return control. Do not compile or render. Shared verification starts after all original file queues finish; your live context may then receive one bounded repair for a failed obligation.",
    ...task.fragments.map(
      ({ id, text }, index) => `Source fragment ${index + 1} (${id}):\n\n${codeBlock(text)}`,
    ),
  ].join("\n\n");
}
