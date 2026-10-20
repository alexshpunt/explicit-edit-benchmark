const creationActions = new Set([
  "header",
  "implementation",
  "vendor-header",
  "vendor-implementation",
]);
const existingFileActions = new Set(["remove-generated-declaration", "cleanup-empty-namespaces"]);

/** Public instruction contract bound into atomic preparation and its proof identity. */
export const TASK_CONSTRAINTS_VERSION = "renderer-public-task-constraints-v1";

function sourcePath(file) {
  if (
    typeof file !== "string" ||
    !/^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:cpp|h)$/.test(file) ||
    file.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("Invalid public source path");
  return file;
}

function createdFiles(operations) {
  const files = new Set();
  for (const operation of operations) {
    if (operation.phase === "names") continue;
    if (operation.phase !== "structure") throw Error("Unknown public task phase");
    if (creationActions.has(operation.action)) files.add(sourcePath(operation.file));
    else if (!existingFileActions.has(operation.action))
      throw Error("Unknown public source-file effect");
  }
  return [...files].sort();
}

/** Derive required source paths from public requests, never a candidate or private answer.
 * All supported moves retain their original source files. Repeated moves into one
 * module create that path only once; naming and cleanup cannot create new files.
 */
export function sourceFilesAfter(files, operations) {
  return [...new Set([...files.map(sourcePath), ...createdFiles(operations)])].sort();
}

const preservation =
  "Preserve every original body, literal, macro and inactive branch, except the explicitly requested scaffolding changes or bound renames. Keep the current neutral namespace, filenames and guards; do not restore upstream project branding. Preserve all earlier accepted edits and unrelated peer edits. Do not fix pre-existing bugs, optimize algorithms, change unrequested types or signatures, or add validation to satisfy your own tests. Do not add comments to C++ source. Do not introduce stub definitions, facades, duplicate bodies or copies hidden behind new conditions. Independent definitions may use any dependency-safe order. Includes and namespace wrappers may differ if the project still builds, but this does not authorize additional source files or changed bodies. A simple unconditional standard using-declaration need not be repeated when an earlier project header supplies it in the required namespace and condition, or when all remaining uses are qualified. An unconditional std::string_literals namespace directive may move but must remain present, and every literal consumer must keep its context. Harmless unconditional standard using-declarations may be added when they do not supply any new unqualified binding. A using-import must not extend an existing project overload family, even when current calls still select the same functions. Preserve other namespace using-directives, aliases and conditional using-declarations. Keep C++ source valid UTF-8 and do not leave symlinks or other nonregular project entries. Full acceptance also requires a fresh C++17 build and pixel-identical outputs for both scenes rendered twice; a passing individual edit is not full-barrier credit.";

/** Render all common constraints with this request's declared creation permission. */
export function taskConstraints(operations) {
  const files = createdFiles(operations);
  const creation = files.length
    ? `This request may create C++ source files only at these paths: ${JSON.stringify(files)}. Reuse a listed file if it already exists; do not overwrite its peer edits.`
    : "This request must not create any C++ source files.";
  return `${creation} Do not delete or rename original or already requested .cpp or .h files. Do not create other .cpp or .h files, including forwarding headers, helper sources or backups with those extensions. Other participants may create their own declared files; do not remove them. Use temporary files outside the shared project.\n\n${preservation}`;
}

/** Render a new repair task without revealing which check failed or how to fix it.
 * The complete source inventory comes only from already delivered public work.
 * Candidate diagnostics and private reference contracts do not enter this prompt.
 */
export function barrierRepairTask(files) {
  const required = sourceFilesAfter(files, []);
  return `Repair the current shared project after the drained barrier failed verification. The requested atomic edits have already been delivered; do not repeat their work or introduce new goals.\n\nThe required .cpp and .h source-file inventory at this barrier is exactly: ${JSON.stringify(required)}. Keep every listed source file; do not rename one. Do not create or retain other .cpp or .h files, including forwarding headers or helper sources. This file set follows the original public tasks, not a diagnosis of this candidate. Use temporary files outside the shared project.\n\n${preservation}`;
}
