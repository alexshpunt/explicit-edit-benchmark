import path from "node:path";
import { cppTokens, headerSpan, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { byteToCharacter } from "../cpp/cpp-offsets.mjs";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { diagnoseRepairRequirements } from "./repair-requirements.mjs";

const identifier = (text) => /^[A-Za-z_]\w*$/.test(text);
const relative = (file) =>
  typeof file === "string" &&
  file.length > 0 &&
  !path.posix.isAbsolute(file) &&
  !file.split("/").some((part) => part === ".." || part === ".");

/** Private map failures locate candidate work; expected declarations remain private. */
export function taskDiagnostics(checked) {
  return (checked.obligations ?? checked.records ?? [])
    .filter((record) => record.status !== "pass")
    .map((record) => ({
      category: "structure",
      ...Object.fromEntries(
        ["status", "kind", "scope", "selector"]
          .filter((field) => record[field] !== undefined)
          .map((field) => [field, record[field]]),
      ),
      ...(relative(record.file) ? { file: record.file } : {}),
    }));
}

/** Only located candidate compiler output is public; commands and host paths stay private. */
export function compilerDiagnostics(stderr, tree) {
  const result = [];
  for (const line of (stderr ?? "").split("\n")) {
    const match =
      /^(?:\/workspace\/)?([^:\n]+):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/.exec(
        line,
      );
    if (!match) continue;
    const [, reportedFile, row, column, severity, message] = match;
    const file = path.posix.normalize(reportedFile);
    if (!relative(file) || !Object.hasOwn(tree, file)) continue;
    result.push({
      category: "build",
      file,
      line: Number(row),
      column: Number(column),
      severity,
      message: message
        .replace(/\/workspace\//g, "")
        .replace(/\/(?:[^\s'"<>]+)/g, "[external path]")
        .replace(/[\u0000-\u001f\u007f]/g, " "),
    });
  }
  return result;
}

function candidateCompiler(items, tree) {
  const located = items
    .filter((item) => relative(item.file) && Object.hasOwn(tree, item.file))
    .map((item) =>
      Object.fromEntries(
        ["file", "line", "column", "severity", "message"]
          .filter((key) => item[key] !== undefined)
          .map((key) => [key, item[key]]),
      ),
    );
  return [...new Map(located.map((item) => [JSON.stringify(item), item])).values()];
}
function missingMemberGoal(operation, error) {
  if (operation.action !== "rename-binding" || operation.target.role !== "field") return false;
  const member = /^no member named '([^']+)' in '([^']+)'/.exec(error.message ?? "");
  if (
    !member ||
    operation.required?.name !== member[1] ||
    typeof operation.target.scope !== "string"
  )
    return false;
  const separator = operation.target.scope.lastIndexOf("::");
  if (separator < 0) return false;
  const owner = operation.target.scope.slice(0, separator);
  return owner.replace(/^::/, "") === member[2].replace(/^::/, "");
}
function problemDiagnostics(operation, errors) {
  if (operation.action === "rename-binding")
    return errors.filter(
      (error) => operation.files.includes(error.file) && missingMemberGoal(operation, error),
    );
  if (!["replace-identifier", "inspect"].includes(operation.action)) return [];
  return errors.filter(
    (item) =>
      (!operation.target.file || item.file === operation.target.file) &&
      (operation.target.line === undefined || item.line === operation.target.line) &&
      (operation.target.column === undefined || item.column === operation.target.column),
  );
}
function publicSetup(operation) {
  const result = {};
  if (Array.isArray(operation.includes))
    result.includes = operation.includes
      .filter((item) => relative(item?.file) && typeof item.quoted === "boolean")
      .map(({ file, quoted }) => ({ file, quoted }));
  if (
    typeof operation.preamble === "string" &&
    !operation.preamble
      .replace(/^\s*#(?:include|if\w*|endif|else|elif)\b[^\n]*(?:\n|$)/gm, "")
      .trim()
  )
    result.preamble = operation.preamble;
  if (Array.isArray(operation.context))
    result.context = operation.context.filter(
      (line) =>
        typeof line === "string" &&
        /^using\s+(?:namespace\s+)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\s*;$/.test(line.trim()),
    );
  return result;
}
function publicOperation(operation, tree) {
  if (
    ![
      "rename-binding",
      "replace-identifier",
      "move-declaration",
      "remove-declaration",
      "create-module",
      "remove-source-module",
      "repair-module-includes",
      "inspect",
    ].includes(operation.action)
  )
    throw Error("Unsupported directed repair operation");
  const target = Object.fromEntries(
    ["file", "identifier", "name", "role", "translationUnit", "line", "column", "scope"]
      .filter((key) => operation.target?.[key] !== undefined)
      .map((key) => [key, operation.target[key]]),
  );
  if (operation.target?.owner)
    target.owner = Object.fromEntries(
      ["scope", "signature", "definition"]
        .filter((key) => operation.target.owner[key] !== undefined)
        .map((key) => [key, operation.target.owner[key]]),
    );
  for (const key of ["file", "translationUnit"])
    if (target[key] !== undefined && !relative(target[key]))
      throw Error("Invalid current repair location");
  const required = Object.fromEntries(
    [
      "file",
      "qualifiedName",
      "name",
      "scope",
      "signature",
      "kind",
      "definition",
      "guard",
      "macro",
      "declarationsCopy",
      "implementationCopy",
    ]
      .filter((key) => operation.required?.[key] !== undefined)
      .map((key) => [key, operation.required[key]]),
  );
  if (required.file !== undefined && !relative(required.file))
    throw Error("Invalid public repair destination");
  if (
    ["rename-binding", "replace-identifier"].includes(operation.action) &&
    (!Object.hasOwn(tree, target.file) ||
      !Number.isSafeInteger(target.identifier) ||
      target.identifier < 0 ||
      !identifier(target.name) ||
      !identifier(required.name))
  )
    throw Error("Invalid current repair binding locator");
  const files = [
    ...new Set([...(operation.files ?? []), target.file, required.file].filter(relative)),
  ].sort();
  return {
    phase: "repair",
    action: operation.action,
    target,
    ...(Object.keys(required).length ? { required } : {}),
    ...(operation.category ? { category: operation.category } : {}),
    ...(operation.setup ? { setup: publicSetup(operation.setup) } : {}),
    files,
  };
}

function compilerIdentifier(error, tree, tokenCache) {
  const source = tree[error.file];
  if (
    typeof source !== "string" ||
    !Number.isSafeInteger(error.line) ||
    error.line < 1 ||
    !Number.isSafeInteger(error.column) ||
    error.column < 1
  )
    return undefined;
  const lines = source.split("\n");
  if (error.line > lines.length) return undefined;
  const prefix = lines.slice(0, error.line - 1).join("\n") + (error.line > 1 ? "\n" : "");
  const byte = Buffer.byteLength(prefix) + error.column - 1;
  if (
    byte > Buffer.byteLength(source) ||
    error.column > Buffer.byteLength(lines[error.line - 1]) + 1
  )
    return undefined;
  let offset;
  try {
    offset = byteToCharacter(source)(byte);
  } catch (error) {
    if (error.constructor !== Error) throw error;
    // Changed source or an invalid UTF-8 boundary cannot locate repair work.
    return undefined;
  }
  if (!tokenCache.has(error.file))
    tokenCache.set(
      error.file,
      cppTokens(source).filter((token) => identifier(token.text)),
    );
  const tokens = tokenCache.get(error.file);
  const index = tokens.findIndex((token) => token.start === offset);
  return index < 0 ? undefined : { token: tokens[index], index };
}
// Only a unique final public spelling can repair an unresolved compiler token.
// Ambiguous scopes and names reused by another rename remain diagnostic work.
function compilerNameProblems(nodes, errors, tree) {
  const names = new Map();
  for (const node of nodes)
    for (const operation of node.operations ?? [])
      if (operation.phase === "names")
        for (const mapping of operation.mapping ?? []) {
          if (!names.has(mapping.from)) names.set(mapping.from, new Set());
          names.get(mapping.from).add(mapping.to);
        }
  const result = [];
  const tokenCache = new Map();
  for (const error of errors) {
    if (error.severity !== "error" && error.severity !== "fatal error") continue;
    const match =
      /(?:use of undeclared identifier|unknown type name|no (?:type|member) named) '([A-Za-z_]\w*)'/.exec(
        error.message ?? "",
      );
    if (!match || names.get(match[1])?.size !== 1) continue;
    const from = match[1],
      to = [...names.get(from)][0];
    if (!identifier(to) || names.has(to)) continue;
    const located = compilerIdentifier(error, tree, tokenCache);
    if (!located || located.token.text !== from) continue;
    const { index } = located;
    result.push({
      phase: "repair",
      action: "replace-identifier",
      target: {
        file: error.file,
        identifier: index,
        name: from,
        line: error.line,
        column: error.column,
      },
      required: { name: to },
      files: [error.file],
    });
  }
  return result;
}

function moduleProblems(nodes, tree, failedFiles) {
  const modules = new Map();
  for (const node of nodes)
    for (const operation of node.operations ?? []) {
      if (operation.phase !== "structure" || !relative(operation.file)) continue;
      if (
        !["header", "vendor-header", "vendor-implementation", "implementation"].includes(
          operation.action,
        )
      )
        continue;
      const previous = modules.get(operation.file);
      const setup = publicSetup(operation);
      const includes = [
        ...new Map(
          [...(previous?.setup.includes ?? []), ...(setup.includes ?? [])].map((item) => [
            JSON.stringify(item),
            item,
          ]),
        ).values(),
      ];
      modules.set(operation.file, { operation, setup: { ...previous?.setup, ...setup, includes } });
    }
  const result = [];
  let sourceStructure;
  if (
    [...modules.values()].some(
      ({ operation }) => operation.guard || operation.action === "vendor-implementation",
    ) &&
    typeof tree["main.cpp"] === "string"
  ) {
    try {
      sourceStructure = cppStructure(tree["main.cpp"]);
    } catch (error) {
      if (error.constructor !== Error) throw error;
      // The verifier already rejected this candidate; unsupported/incomplete
      // syntax remains explicit repair work rather than an infrastructure stop.
      result.push({
        phase: "repair",
        action: "inspect",
        target: { file: "main.cpp" },
        files: ["main.cpp"],
      });
    }
  }
  for (const [file, { operation, setup }] of modules) {
    if (failedFiles.size && !failedFiles.has(file) && !failedFiles.has("main.cpp")) continue;
    const required = {
      file,
      kind: operation.action,
      ...Object.fromEntries(
        ["guard", "macro", "declarationsCopy", "implementationCopy"]
          .filter((key) => operation[key] !== undefined)
          .map((key) => [key, operation[key]]),
      ),
    };
    if (!Object.hasOwn(tree, file)) {
      // Named declaration moves create implementation files with their setup.
      if (operation.action !== "implementation")
        result.push({
          phase: "repair",
          action: "create-module",
          target: { file: "main.cpp" },
          required,
          setup,
          files: ["main.cpp", file],
        });
      continue;
    }
    if (operation.guard && sourceStructure) {
      try {
        // Vendor goals explicitly select two copies; retain their existing editor's
        // copy policy rather than applying a project's unique-header requirement.
        const remaining =
          operation.action === "header"
            ? headerSpan(tree["main.cpp"], operation.guard, { allowMissing: true })
            : sourceStructure.units.some(
                (unit) =>
                  unit.kind === "conditional" && unit.condition === `#ifndef ${operation.guard}`,
              );
        if (remaining)
          result.push({
            phase: "repair",
            action: "remove-source-module",
            target: { file: "main.cpp" },
            required,
            setup,
            files: ["main.cpp", file],
          });
      } catch (error) {
        if (error.constructor !== Error) throw error;
        result.push({
          phase: "repair",
          action: "inspect",
          target: { file: "main.cpp" },
          files: ["main.cpp"],
        });
      }
    }
    if (
      operation.action === "vendor-implementation" &&
      identifier(operation.macro) &&
      sourceStructure?.directives.some((unit) =>
        new RegExp(`^#\\s*define\\s+${operation.macro}(?:\\s|$)`).test(unit.text),
      )
    )
      result.push({
        phase: "repair",
        action: "remove-source-module",
        target: { file: "main.cpp" },
        required,
        setup,
        files: ["main.cpp", file],
      });
    const existing = new Set(
      includeDirectives(tree[file]).map((item) =>
        JSON.stringify({ file: item.file, quoted: item.quoted }),
      ),
    );
    const missing = setup.includes?.filter((item) => !existing.has(JSON.stringify(item))) ?? [];
    if (missing.length)
      result.push({
        phase: "repair",
        action: "repair-module-includes",
        target: { file },
        required,
        setup: { includes: missing },
        files: [file],
      });
  }
  return result;
}
function currentProblemLocation(file, diagnostics, bindings, tree) {
  const target = { file };
  if (typeof tree[file] !== "string") return target;
  let units;
  try {
    units = cppStructure(tree[file]).units;
  } catch (error) {
    if (error.constructor !== Error) throw error;
    return target;
  }
  for (const problem of diagnostics.filter(
    (item) => item.file === file && item.selector !== undefined,
  )) {
    const unit = units.find(
      (item) =>
        (problem.scope === undefined || (item.scope || "") === problem.scope) &&
        unitDeclarator(tree[file], item) === problem.selector,
    );
    if (!unit) continue;
    const position = byteToCharacter(tree[file]);
    let declaration;
    const length = Buffer.byteLength(tree[file]);
    for (const item of bindings) {
      if (
        item.file !== file ||
        !["function", "type"].includes(item.role) ||
        !Number.isSafeInteger(item.offset) ||
        item.offset < 0 ||
        item.offset > length
      )
        continue;
      const start = position(item.offset);
      if (
        unit.start <= start &&
        start < unit.end &&
        (!declaration || item.offset < declaration.offset)
      )
        declaration = item;
    }
    if (declaration)
      return {
        file,
        name: declaration.name,
        scope: declaration.scope,
        role: declaration.role,
        line: declaration.line,
        column: declaration.column,
      };
  }
  return target;
}
const priority = (operation) =>
  ({
    "replace-identifier": 0,
    "rename-binding": 1,
    "create-module": 2,
    "repair-module-includes": 2,
    "move-declaration": 3,
    "remove-source-module": 3,
    "remove-declaration": 4,
    inspect: 5,
  })[operation.action] ?? 5;
function description(operation) {
  if (operation.action === "rename-binding")
    return `The declaration ${operation.target.name} in ${operation.target.file} must be named ${operation.required.name}. Rename the binding and its bound uses.`;
  if (operation.action === "replace-identifier")
    return `The compiler cannot resolve ${operation.target.name} in ${operation.target.file}. The public requirement names it ${operation.required.name}. Fix this use.`;
  if (operation.action === "move-declaration")
    return `${operation.target.name} is in ${operation.target.file}; its required owner is ${operation.required.file}. Move the current declaration without changing its body.`;
  if (operation.action === "remove-declaration")
    return `The temporary declaration in ${operation.target.file} must be absent. Remove only that declaration.`;
  if (operation.action === "create-module")
    return `The required module ${operation.required.file} is missing. Create it from current source with the public setup.`;
  if (operation.action === "remove-source-module")
    return `The module block remains in ${operation.target.file} after ${operation.required.file} was created. Remove the leftover source block and preserve the destination.`;
  if (operation.action === "repair-module-includes")
    return `Required direct includes are missing from ${operation.target.file}. Add the listed includes and preserve other source.`;
  return operation.target.file
    ? `The barrier detected a source or binding mismatch${operation.target.scope ? ` in ${operation.target.scope}` : ""} in ${operation.target.file}. Repair the affected declaration and preserve other requirements.`
    : "Repair the remaining shared-project barrier problem.";
}

/** New repair work describes current problems. Historical atoms are goal facts only. */
export function barrierRepairNodes({
  category,
  diagnostics = [],
  compiler = [],
  nodes = [],
  tree = {},
  bindings = [],
}) {
  const errors = candidateCompiler(category === "build" ? diagnostics : compiler, tree);
  const compilerNames = new Set();
  const tokenCache = new Map();
  for (const error of errors) {
    if (!["error", "fatal error"].includes(error.severity)) continue;
    const named =
      /^(?:no matching function for call to|use of undeclared identifier|unknown type name) '([A-Za-z_]\w*)'/.exec(
        error.message ?? "",
      );
    if (named) compilerNames.add(named[1]);
    const located = compilerIdentifier(error, tree, tokenCache);
    if (located) compilerNames.add(located.token.text);
  }
  // Rank existing current goals, never add prerequisites or suppress errors.
  // Clearing located compiler blockers avoids recovering every unrelated rename.
  const repairPriority = (operation) =>
    priority(operation) -
    (operation.action === "rename-binding" && compilerNames.has(operation.required?.name)
      ? 0.5
      : 0);
  const failedFiles = new Set(diagnostics.map((item) => item.file).filter(relative));
  const raw =
    category === "structure"
      ? [
          ...diagnoseRepairRequirements({ nodes, bindings, tree }),
          ...compilerNameProblems(nodes, errors, tree),
          ...moduleProblems(nodes, tree, failedFiles),
        ]
      : category === "build"
        ? compilerNameProblems(nodes, errors, tree)
        : [];
  for (const error of errors) {
    if (!["error", "fatal error"].includes(error.severity)) continue;
    const memberGoals = raw.filter((operation) => missingMemberGoal(operation, error));
    if (memberGoals.length === 1) {
      const [goal] = memberGoals;
      goal.files = [...new Set([...goal.files, error.file])].sort();
      continue;
    }
    if (
      raw.some(
        (operation) =>
          operation.action === "replace-identifier" &&
          operation.target.file === error.file &&
          operation.target.line === error.line &&
          operation.target.column === error.column,
      )
    )
      continue;
    raw.push({
      phase: "repair",
      action: "inspect",
      category: "build",
      target: {
        file: error.file,
        ...(error.line !== undefined ? { line: error.line } : {}),
        ...(error.column !== undefined ? { column: error.column } : {}),
      },
      files: [error.file],
    });
  }
  const operations = [
    ...new Map(
      raw.map((operation) => {
        const safe = publicOperation(operation, tree);
        return [JSON.stringify(safe), safe];
      }),
    ).values(),
  ].sort((left, right) => repairPriority(left) - repairPriority(right));
  const covered = new Set(operations.flatMap((operation) => operation.files));
  for (const file of failedFiles)
    if (!covered.has(file))
      operations.push({
        phase: "repair",
        action: "inspect",
        target: currentProblemLocation(file, diagnostics, bindings, tree),
        files: [file],
      });
  if (!operations.length)
    operations.push({ phase: "repair", action: "inspect", target: {}, files: [] });
  const groups = [];
  for (const operation of operations) {
    const hits = groups.filter((group) => operation.files.some((file) => group.files.has(file)));
    const group = hits.shift() ?? { files: new Set(), operations: [] };
    if (!groups.includes(group)) groups.push(group);
    for (const other of hits) {
      for (const file of other.files) group.files.add(file);
      group.operations.push(...other.operations);
      groups.splice(groups.indexOf(other), 1);
    }
    for (const file of operation.files) group.files.add(file);
    group.operations.push(operation);
  }
  return groups.flatMap((group, groupIndex) =>
    group.operations
      .sort((left, right) => repairPriority(left) - repairPriority(right))
      .map((operation, index) => ({
        id: `problem-${groupIndex}-${index}`,
        dependencies: index ? [`problem-${groupIndex}-${index - 1}`] : [],
        operations: [operation],
        repairFiles: [...group.files].sort(),
        diagnostics: problemDiagnostics(operation, errors),
        prompt: `${description(operation)}\n\nPreserve other source and earlier public requirements.\n\n${JSON.stringify({ problems: [operation] })}`,
      })),
  );
}
