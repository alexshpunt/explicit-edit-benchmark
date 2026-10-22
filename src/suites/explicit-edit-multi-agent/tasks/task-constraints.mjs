const creationActions = new Set([
  "header",
  "implementation",
  "vendor-header",
  "vendor-implementation",
]);
const existingFileActions = new Set(["remove-generated-declaration", "cleanup-empty-namespaces"]);

/** Public task-prompt identity bound into atomic preparation and its proof. */
export const TASK_CONSTRAINTS_VERSION = "renderer-public-task-constraints-v3";

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
