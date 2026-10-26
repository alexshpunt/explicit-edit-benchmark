import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { canonicalRepairSignature } from "../cpp/repair-identity.mjs";
import { applyCurrentStructure } from "./coherent-edit.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";

const identifier = (value) => typeof value === "string" && /^[A-Za-z_]\w*$/.test(value);
const fileName = (value) =>
  typeof value === "string" &&
  /^(?:[\w.-]+\/)*[\w.-]+\.(?:cpp|h)$/.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..");
const qualified = (value) =>
  String(value ?? "")
    .split("::")
    .filter(Boolean)
    .join("::");
export const repairConflict = (message) => Object.assign(Error(message), { repairConflict: true });

function locatedIdentifier(tree, target, required) {
  if (
    !fileName(target?.file) ||
    !Object.hasOwn(tree, target.file) ||
    !Number.isSafeInteger(target.identifier) ||
    target.identifier < 0 ||
    !identifier(required?.name)
  )
    throw repairConflict("Current identifier repair has no valid location");
  const token = cppTokens(tree[target.file])
    .filter((item) => identifier(item.text))
    .at(target.identifier);
  if (!token || ![target.name, required.name].includes(token.text))
    throw repairConflict("Current identifier repair location changed");
  return token;
}

function addIncludes(source, includes = [], header = false) {
  const existing = new Set(
    includeDirectives(source).map((item) => JSON.stringify([item.file, item.quoted])),
  );
  let inserted = "";
  for (const item of includes) {
    if (
      typeof item?.quoted !== "boolean" ||
      typeof item.file !== "string" ||
      !/^(?:[\w.-]+\/)*[\w.-]+$/.test(item.file) ||
      item.file.split("/").some((part) => part === "." || part === "..")
    )
      throw repairConflict("Invalid required module include");
    const key = JSON.stringify([item.file, item.quoted]);
    if (!existing.has(key)) {
      inserted += `#include ${item.quoted ? '"' + item.file + '"' : "<" + item.file + ">"}\n`;
      existing.add(key);
    }
  }
  if (!inserted) return source;
  const structure = cppStructure(source);
  const guard =
    header &&
    structure.units.find(
      (unit) => unit.kind === "conditional" && /^#ifndef\s+[A-Za-z_]\w*$/.test(unit.condition),
    );
  const define =
    guard &&
    structure.directives.find(
      (unit) => unit.start > guard.start && unit.end < guard.end && /^#\s*define\b/.test(unit.text),
    );
  const position = define?.end ?? 0;
  const prefix = source.slice(0, position);
  return (
    prefix + (prefix && !/[\r\n]$/.test(prefix) ? "\n" : "") + inserted + source.slice(position)
  );
}
function appendUnit(source, fragment, header) {
  if (!header) return source + "\n" + fragment + "\n";
  const structure = cppStructure(source);
  const guard = structure.units.find(
    (unit) => unit.kind === "conditional" && /^#ifndef\s+[A-Za-z_]\w*$/.test(unit.condition),
  );
  const close =
    guard &&
    structure.directives.findLast(
      (unit) => unit.start > guard.start && unit.end <= guard.end && /^#\s*endif\b/.test(unit.text),
    );
  const position = close?.start ?? source.length;
  return source.slice(0, position) + "\n" + fragment + "\n" + source.slice(position);
}
async function currentOwner(tree, planner, file, operation) {
  if (!Object.hasOwn(tree, file)) return undefined;
  const required = operation.required;
  const name = qualified(
    required.qualifiedName ??
      [required.scope === "::" ? "" : required.scope, required.name].filter(Boolean).join("::"),
  );
  if (!name || !fileName(file)) throw repairConflict("Invalid required declaration owner");
  const cpp = Object.keys(tree).filter((item) => item.endsWith(".cpp"));
  const contexts = [
    ...new Set(
      [operation.target?.translationUnit, file.endsWith(".cpp") ? file : undefined, ...cpp].filter(
        (item) => cpp.includes(item),
      ),
    ),
  ];
  const found = new Map();
  for (const context of contexts) {
    const bindings = await planner.currentBindings(tree, context);
    const signature =
      required.signature === undefined
        ? undefined
        : canonicalRepairSignature(required.signature, { scope: name, bindings });
    for (const entry of bindings) {
      if (
        entry.file !== file ||
        entry.role !== (required.kind === "record" ? "type" : required.kind) ||
        qualified(entry.scope) !== name ||
        entry.definition !== required.definition
      )
        continue;
      if (entry.role === "variable" && entry.owner) continue;
      if (
        signature !== undefined &&
        canonicalRepairSignature(entry.owner?.signature ?? "", { scope: entry.scope, bindings }) !==
          signature
      )
        continue;
      found.set(entry.start, entry);
    }
    // One physical CPP body is authoritative for its own declarations. Header
    // definitions can be repeated by several TUs; deduplicate their origins.
    if (context === file) break;
  }
  if (found.size > 1) throw repairConflict("Current declaration owner is ambiguous");
  if (!found.size) return undefined;
  const entry = [...found.values()][0];
  const units = cppStructure(tree[file]).units.filter(
    (unit) =>
      unit.kind === "declaration" &&
      unit.start <= entry.start &&
      entry.start < unit.end &&
      qualified(unit.scope) === qualified(required.scope),
  );
  if (
    units.length !== 1 ||
    (entry.role === "function" && units[0].definition !== required.definition)
  )
    throw repairConflict("Current declaration has no complete physical unit");
  return { entry, unit: units[0] };
}
async function relocate(tree, operation, planner) {
  const { target, required, setup = {} } = operation;
  if (!fileName(target?.file) || !fileName(required?.file))
    throw repairConflict("Invalid repair ownership files");
  if (
    !/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(required.scope) &&
    required.scope !== "::" &&
    required.scope !== ""
  )
    throw repairConflict("Unsupported repair namespace");
  const source = await currentOwner(tree, planner, target.file, operation);
  if (operation.action === "remove-declaration") {
    if (required.definition !== false || target.file.endsWith(".h"))
      throw repairConflict("Only located temporary implementation declarations may be removed");
    if (!source) return tree;
    if (!tree[target.file].slice(source.unit.start, source.unit.end).trimEnd().endsWith(";"))
      throw repairConflict("Repair removal is not a temporary declaration");
    return {
      ...tree,
      [target.file]:
        tree[target.file].slice(0, source.unit.start) + tree[target.file].slice(source.unit.end),
    };
  }
  if (target.file === required.file) return tree;
  const destination = await currentOwner(tree, planner, required.file, operation);
  if (!source) {
    if (destination) return tree;
    throw repairConflict("Current declaration is absent from both ownership locations");
  }
  let replacement = "";
  if (target.file.endsWith(".h") && source.entry.role === "function") {
    if (
      !Number.isInteger(source.entry.bodyStart) ||
      source.entry.bodyStart < source.unit.start ||
      source.entry.bodyStart >= source.unit.end
    )
      throw repairConflict("Header definition cannot be safely reduced to a declaration");
    replacement =
      tree[target.file].slice(source.unit.start, source.entry.bodyStart).trimEnd() + ";";
  }
  const after = {
    ...tree,
    [target.file]:
      tree[target.file].slice(0, source.unit.start) +
      replacement +
      tree[target.file].slice(source.unit.end),
  };
  if (!destination) {
    let output = tree[required.file] ?? "";
    if (!output && setup.preamble !== undefined) {
      if (
        typeof setup.preamble !== "string" ||
        setup.preamble
          .replace(/^\s*#(?:include|if\w*|endif|else|elif)\b[^\n]*(?:\n|$)/gm, "")
          .trim()
      )
        throw repairConflict("Unsupported public module preamble");
      output = setup.preamble;
    }
    output = addIncludes(output, setup.includes, required.file.endsWith(".h"));
    const context = source.unit.using?.length ? source.unit.using.join("\n") + "\n" : "";
    const text = context + tree[target.file].slice(source.unit.start, source.unit.end);
    const fragment = source.unit.scope ? `namespace ${source.unit.scope} {\n${text}\n}` : text;
    after[required.file] = appendUnit(output, fragment, required.file.endsWith(".h"));
  }
  return after;
}
function moduleProblem(tree, operation) {
  const { target, required = {}, setup = {} } = operation;
  const file = required.file ?? target?.file;
  if (!fileName(file)) throw repairConflict("Invalid module repair file");
  if (operation.action === "repair-module-includes") {
    if (!Object.hasOwn(tree, target?.file)) throw repairConflict("Module include target is absent");
    return {
      ...tree,
      [target.file]: addIncludes(tree[target.file], setup.includes, target.file.endsWith(".h")),
    };
  }
  const kind = required.kind ?? setup.kind;
  if (kind === "implementation") {
    if (Object.hasOwn(tree, file)) return tree;
    const preamble = setup.preamble ?? "";
    if (
      typeof preamble !== "string" ||
      preamble.replace(/^\s*#(?:include|if\w*|endif|else|elif)\b[^\n]*(?:\n|$)/gm, "").trim()
    )
      throw repairConflict("Unsupported public module preamble");
    return { ...tree, [file]: addIncludes(preamble, setup.includes) };
  }
  if (
    !["header", "vendor-header", "vendor-implementation"].includes(kind) ||
    (target?.file && target.file !== "main.cpp" && target.file !== file)
  )
    throw repairConflict("Unsupported current module problem");
  // These are current missing-module/leftover-block problems, not replayed
  // original tasks. The editor reads the actual current guard and destination.
  return applyCurrentStructure(tree, {
    ...setup,
    ...required,
    includes: setup.includes ?? required.includes ?? [],
    action: kind,
    file,
  });
}

/** Execute only the fresh public problem. Unknown repairs remain conflicts;
 * neither a no-op nor an editing receipt decides benchmark acceptance. */
export async function editCurrentProblems(tree, operations, planner, taskId) {
  let after = tree,
    statistics;
  for (const [index, original] of operations.entries()) {
    const operation = { ...original, id: original.id ?? `${taskId}:${index}` };
    if (operation.phase !== "repair") throw repairConflict("Mixed current repair operations");
    if (operation.action === "rename-binding") {
      const result = await planner.repair(after, operation);
      planner.acknowledge(after, result.after);
      after = result.after;
      statistics = result.statistics;
    } else if (operation.action === "replace-identifier") {
      const token = locatedIdentifier(after, operation.target, operation.required);
      if (token.text !== operation.required.name) {
        const source = after[operation.target.file];
        after = {
          ...after,
          [operation.target.file]:
            source.slice(0, token.start) + operation.required.name + source.slice(token.end),
        };
      }
    } else if (["move-declaration", "remove-declaration"].includes(operation.action)) {
      after = await relocate(after, operation, planner);
    } else if (
      ["create-module", "remove-source-module", "repair-module-includes"].includes(operation.action)
    ) {
      try {
        after = moduleProblem(after, operation);
      } catch (error) {
        if (error.constructor === Error) error.repairConflict = true;
        throw error;
      }
    } else throw repairConflict("This current problem needs a non-mechanical repair");
  }
  for (const [file, source] of Object.entries(after)) assertNeutralSource(file, source);
  return { after, statistics };
}
