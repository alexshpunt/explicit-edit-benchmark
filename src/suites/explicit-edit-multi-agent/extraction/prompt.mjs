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

/** Render only the independently prepared public symbol inventory. */
export function moduleSymbolPrompt(task, entities) {
  assert.equal(typeof task.file, "string");
  assert.ok(Array.isArray(entities));
  const scopes = new Map();
  for (const { scope, kind, signature, members, action, occurrences } of entities) {
    assert.equal(typeof scope, "string");
    assert.equal(typeof kind, "string");
    assert.equal(typeof signature, "string");
    assert.ok(
      members === undefined ||
        (Array.isArray(members) && members.every((member) => typeof member === "string")),
    );
    assert.ok(action === undefined || action === "copy");
    assert.ok(occurrences === undefined || (Number.isSafeInteger(occurrences) && occurrences > 1));
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const groups = scopes.get(scope);
    const key = `${action ?? "move"}\0${kind}`;
    if (!groups.has(key)) groups.set(key, { action, kind, entries: [] });
    const count = occurrences ? `\nFind ${occurrences} occurrences.` : "";
    const fields = members?.length
      ? `\nIts members have these declarations: ${members.join(" ")}`
      : "";
    groups.get(key).entries.push(`${signature}${count}${fields}`);
  }
  const inventory = [...scopes].map(([scope, groups]) =>
    [
      scope ? `In namespace ${scope}:` : "In the global namespace:",
      ...[...groups.values()].map(
        ({ action, kind, entries }) =>
          `${action === "copy" ? "Copy" : "Move"} these ${kind.replaceAll("-", " ")} entities:\n${entries.join("\n\n")}`,
      ),
    ].join("\n\n"),
  );
  return [
    `Extract the assigned entities into ${task.file}.`,
    "Find the complete entities in the shared source. Preserve their current code, declarations, dependencies, conditional behavior and compiler bindings. Do not rename or alter unrelated entities.",
    "Follow the move or copy instruction for each entity. Leave copied originals intact. The entities are sorted independently of source order.",
    ...(task.kind === "header"
      ? ["Begin the destination header with #pragma once; do not add an include guard."]
      : []),
    ...(task.includes?.length
      ? [`The destination depends on these project files: ${[...task.includes].sort().join(", ")}.`]
      : []),
    ...(task.kind === "header" || task.kind === "vendor-header"
      ? [
          "Keep the shared program using the extracted header without changing preceding preprocessing context.",
        ]
      : []),
    "Preserve the project and its build behavior. Hold an exclusive flock on /workspace across each shared-source read and write. Keep the directory inode unchanged; /tmp is private to this participant. Do not compile or render in this turn.",
    ...inventory,
  ].join("\n\n");
}

/** Keep diagnostic positions and source excerpts private in symbol-only cases. */
export function moduleSymbolRecoveryPrompt(task, assignmentsDirectory) {
  const scope =
    task.kind === "main-recovery"
      ? "Repair the reported shared project-preservation failures without changing unrelated work."
      : task.file
        ? `Repair the extraction obligation for ${task.file}.`
        : "Repair the reported project-preservation or integration failure.";
  return [
    scope,
    "Inspect the current shared project and preserve unrelated changes. Do not assume assigned entities still occupy their original positions. Hold an exclusive flock on /workspace across each shared-source read and write.",
    ...(assignmentsDirectory
      ? [`Read the public assignment specifications under ${assignmentsDirectory}.`]
      : []),
    ...(task.recovery?.verified
      ? [
          task.recovery.verified.sourceMatched
            ? "Source removal and replacement pass verification."
            : "Source removal or replacement fails verification.",
          task.recovery.verified.targetMatched
            ? "The destination passes verification."
            : "The destination fails verification.",
        ]
      : []),
    ...(task.kind === "main-recovery"
      ? (task.recovery?.diagnostics ?? [])
          .filter(
            ({ kind, file }) =>
              kind === "extra-file" &&
              typeof file === "string" &&
              /^[A-Za-z0-9_./+-]+$/.test(file) &&
              !file.startsWith("/") &&
              !file.split("/").includes(".."),
          )
          .map(({ file }) => `The workspace contains an unexpected file: ${file}.`)
      : []),
    ...(task.recovery?.publicFeedback ?? []).map(
      ({ status, entity, expectedCount, actualCount, source }) => {
        if (status === "unavailable")
          return "The destination could not be analyzed reliably; inspect it against the assignment.";
        if (status === "condition-count")
          return `The destination contains ${actualCount} ${entity.signature} directives; ${expectedCount} are required.`;
        const scope = entity.scope ? `namespace ${entity.scope}` : "the global namespace";
        const location = source ? `In main.cpp, in ${scope}` : `In ${scope}`;
        if (status === "unlocated")
          return `${location}, this ${entity.kind.replaceAll("-", " ")} could not be identified reliably in the destination. It might already be present; check before modifying:\n${entity.signature}`;
        const issue =
          status === "missing"
            ? "has fewer occurrences than required"
            : status === "extra"
              ? "has extra occurrences"
              : "differs from the required entity";
        const counts =
          expectedCount === undefined
            ? ""
            : `\nFound ${actualCount} occurrences; require ${expectedCount}.`;
        const members = entity.members?.length
          ? `\nIts members have these declarations: ${entity.members.join(" ")}`
          : "";
        return `${location}, this ${entity.kind.replaceAll("-", " ")} ${issue}:\n${entity.signature}${members}${counts}`;
      },
    ),
    ...(task.kind === "integration-recovery"
      ? [
          `Run the supplied ${task.recovery.stage === "build-correction" ? "build" : "image"} validation script from the project root, fix the failure, and run it again: bash ${task.recovery.stage === "build-correction" ? "/feedback/check-build.sh" : "/feedback/check-images.sh"}.`,
        ]
      : [
          "Finish this repair without compiling or rendering. The controller verifies the result after the repair.",
        ]),
  ].join("\n\n");
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
    ...(task.kind === "header"
      ? [
          "Add #pragma once as the first non-empty line of the destination header. Do not add an include guard.",
        ]
      : []),
    codeBlock(parts.join("")),
    task.kind === "header"
      ? `Remove the assigned fragments without a local replacement. Insert ${task.replacement.trim()} at the current first owned unit's global position: before its outermost containing namespace opener, or immediately before the unit if it is already global. Leave all preceding source and imports in place. Do not collect, sort or hoist project includes to the start of main.cpp. Preserve activation macros and include ordering.`
      : task.replacement
        ? `Replace the first removed source fragment in main.cpp with:\n\n${task.replacement}`
        : "Remove the assigned source fragments from main.cpp without inserting another include.",
    "Retain shared namespace shells, standard-library imports and include context in main.cpp where peer fragments still need them. Preserve every unassigned fragment. Hold an exclusive flock on the shared /workspace directory while re-reading and updating main.cpp; use flock -x /workspace around the whole read-modify-write command. Keep the directory inode unchanged. Use this same shared lock for every participant; /tmp is private to each participant.",
    "Complete this one whole-file assignment and return control. Do not rename, reorder, clean up, compile or render. Shared verification starts after every original file queue finishes; your live context may then receive one bounded repair for a failed obligation.",
    ...task.fragments.map(
      ({ id, text, scope, beforeFragment, afterFragment }, index) =>
        `Source fragment ${index + 1} (${id}), namespace ${scope || "(global)"}:${beforeFragment || afterFragment ? `\nLive context: ${afterFragment ? `after ${afterFragment}` : ""}${beforeFragment && afterFragment ? ", " : ""}${beforeFragment ? `before ${beforeFragment}` : ""}. Locate those unique complete owned units in current source. Choose the nearest matching block toward these anchors, without crossing a substantive peer unit; retained standard imports and comments may intervene. Refuse missing or ambiguous context. Never use old offsets or a global occurrence number.` : ""}\n\n${codeBlock(text)}`,
    ),
  ].join("\n\n");
}

/** Render one complete assignment without the old atomic or JSON-hunk wrapper. */
export function moduleExtractionPrompt(task) {
  if (
    task.kind === "implementation" ||
    task.kind === "vendor-header" ||
    (task.kind === "header" && !task.guard)
  )
    return fileAssignment(task);
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
