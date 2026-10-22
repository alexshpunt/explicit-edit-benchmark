import path from "node:path";
import { atomicDiagnosticOwners } from "./atomic-frontier.mjs";

const fields = ["status", "kind", "file", "scope", "selector", "expected", "actual", "reason"];
const relative = (file) =>
  typeof file === "string" &&
  file.length > 0 &&
  !path.posix.isAbsolute(file) &&
  !file.split("/").some((part) => part === ".." || part === ".");

/** Project one atom's observations into feedback, never private tokens, masks,
 * plans, hashes or reference source. Unobservable is not a claim of writer fault.
 */
export function taskDiagnostics(checked) {
  return (checked.obligations ?? checked.records ?? [])
    .filter((record) => record.status !== "pass")
    .map((record) => ({
      category: "structure",
      ...Object.fromEntries(
        fields
          .filter(
            (field) => record[field] !== undefined && (field !== "file" || relative(record.file)),
          )
          .map((field) => [field, record[field]]),
      ),
      ...(record.status === "fail" && record.identifiers
        ? { identifiers: record.identifiers.map(({ expected, actual }) => ({ expected, actual })) }
        : {}),
    }));
}

/** Read located compiler errors/notes from candidate stderr only. Never pass an
 * exec error's command line, sandbox mounts or host evidence paths as feedback.
 * Unsupported or ambiguous source layouts retain a location but no owner claim.
 */
export function compilerDiagnostics(stderr, tree) {
  const result = [];
  const locations = new Map();
  for (const line of (stderr ?? "").split("\n")) {
    const match =
      /^(?:\/workspace\/)?([^:\n]+):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/.exec(
        line,
      );
    if (!match) continue;
    const [, file, row, column, severity, message] = match;
    if (!relative(file) || !Object.hasOwn(tree, file)) continue;
    const diagnostic = {
      category: "build",
      file,
      line: Number(row),
      column: Number(column),
      severity,
      message: message
        .replace(/\/workspace\//g, "")
        .replace(/\/(?:[^\s'"<>]+)/g, "[external path]")
        .replace(/[\u0000-\u001f\u007f]/g, " "),
    };
    try {
      const source = tree[file];
      const lines = source.split("\n");
      if (
        diagnostic.line > 0 &&
        diagnostic.line <= lines.length &&
        diagnostic.column > 0 &&
        diagnostic.column <= Buffer.byteLength(lines[diagnostic.line - 1]) + 1
      ) {
        const prefix = Buffer.from(lines[diagnostic.line - 1])
          .subarray(0, diagnostic.column - 1)
          .toString("utf8");
        if (Buffer.byteLength(prefix) !== diagnostic.column - 1)
          throw Error("Split compiler source character");
        const offset =
          lines.slice(0, diagnostic.line - 1).reduce((sum, text) => sum + text.length + 1, 0) +
          prefix.length;
        if (!locations.has(file)) locations.set(file, atomicDiagnosticOwners(file, source));
        const units = locations
          .get(file)
          .filter((unit) => unit.start <= offset && offset < unit.end);
        if (units.length === 1 && units[0].kind !== "conditional") {
          diagnostic.selector = units[0].selector;
          diagnostic.scope = units[0].scope;
        }
      }
    } catch {
      // A compiler error may be precisely an unsupported or broken declaration.
    }
    result.push(diagnostic);
  }
  return result;
}

/** Route a located barrier diagnostic only when one delivered atomic task owns
 * its exact physical declaration. Sharing a file is not ownership. Ambiguous and
 * unlocated errors remain controller evidence, never a broadcast or random repair.
 * scopes contains controller-owned affected records for delivered tasks only.
 */
export function attributeDiagnostics(diagnostics, scopes) {
  const assigned = new Map();
  const unassigned = [];
  for (const diagnostic of diagnostics) {
    const matches = [...scopes].filter(([, records]) =>
      records.some(
        (record) =>
          diagnostic.selector !== undefined &&
          record.file === diagnostic.file &&
          record.scope === diagnostic.scope &&
          record.selector === diagnostic.selector,
      ),
    );
    if (matches.length !== 1) {
      unassigned.push(diagnostic);
      continue;
    }
    const id = matches[0][0];
    if (!assigned.has(id)) assigned.set(id, []);
    assigned.get(id).push(diagnostic);
  }
  return { assigned, unassigned };
}
