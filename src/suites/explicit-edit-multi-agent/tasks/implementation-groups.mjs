import { assertNeutralSource } from "../generation/origin-markers.mjs";

const kinds = new Set(["function", "type", "variable", "conditional"]);
const word = (value) => typeof value === "string" && /^[A-Za-z_]\w*$/.test(value);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function selectorOf(selector) {
  if (
    !selector ||
    !kinds.has(selector.kind) ||
    typeof selector.scope !== "string" ||
    !(
      /^(?:[A-Za-z_]\w*)(?:::[A-Za-z_]\w*)*$/.test(selector.scope) ||
      (selector.kind === "conditional" && selector.scope === "::")
    )
  )
    throw new Error("Missing or unsupported implementation owner selector");
  const result = { kind: selector.kind, scope: selector.scope };
  if (selector.declarator !== undefined) {
    if (typeof selector.declarator !== "string" || !selector.declarator.trim())
      throw new Error("Missing physical declaration selector");
    result.declarator = selector.declarator;
  }
  if (selector.kind === "conditional") {
    if (
      typeof selector.condition !== "string" ||
      !selector.condition.trim() ||
      /[\r\n]/.test(selector.condition)
    )
      throw new Error("Missing conditional block selector");
    return { ...result, condition: selector.condition };
  }
  if (
    !word(selector.name) &&
    !(selector.kind === "function" && /^operator[+*/=<>!&|^~%,()[\]-]+$/.test(selector.name ?? ""))
  )
    throw new Error("Missing implementation name selector");
  if (selector.kind !== "function") return { ...result, name: selector.name };
  if (selector.definition !== undefined) {
    if (typeof selector.definition !== "boolean")
      throw new Error("Invalid function definition selector");
    result.definition = selector.definition;
  }
  if (
    typeof selector.signature !== "string" ||
    !selector.signature.includes("(") ||
    !selector.signature.includes(")") ||
    /[\r\n@]| at .+:\d+:\d+/.test(selector.signature)
  )
    throw new Error("Missing or unsafe implementation function signature");
  return { ...result, name: selector.name, signature: selector.signature };
}

/** Form the smallest dependency-connected implementation groups from a complete inventory.
 * References are binding IDs, not name matches. A dependency declared in a project header
 * can stay in another group/file; a private helper, type or datum travels with all its users.
 * Preserve original order within each file and group. Conditional blocks are whole units.
 * The caller must inventory inactive code, directives and initializer order as well as AST
 * bindings. This planner neither discovers those facts nor proves complete renderer extraction.
 * Explicit external IDs cover header/system bindings; unresolved IDs always fail closed.
 */
export function implementationGroups(input, { external = [] } = {}) {
  if (!Array.isArray(input) || !input.length) throw new Error("Missing implementation inventory");
  if (!Array.isArray(external) || external.some((id) => typeof id !== "string" || !id))
    throw new Error("Invalid external binding inventory");
  const externalIds = new Set(external);
  const ids = new Set();
  const positions = new Set();
  const selectors = new Set();
  const units = input
    .map((unit) => {
      if (!unit || typeof unit.id !== "string" || !unit.id || ids.has(unit.id))
        throw new Error("Missing or duplicate implementation binding id");
      if (
        typeof unit.file !== "string" ||
        !/^[\w.-]+\.cpp$/.test(unit.file) ||
        unit.file.startsWith(".")
      )
        throw new Error("Unsupported implementation target file");
      if (!Number.isSafeInteger(unit.order) || unit.order < 0)
        throw new Error("Missing implementation source order");
      const position = `${unit.file}:${unit.order}`;
      if (positions.has(position)) throw new Error("Duplicate physical implementation unit");
      if (typeof unit.headerDeclared !== "boolean")
        throw new Error("Missing project-header ownership classification");
      if (
        !Array.isArray(unit.references) ||
        unit.references.some((id) => typeof id !== "string" || !id)
      )
        throw new Error("Missing implementation binding references");
      const selector = selectorOf(unit.selector);
      const key = JSON.stringify([unit.file, selector]);
      if (selectors.has(key)) throw new Error("Ambiguous implementation owner selector");
      if (externalIds.has(unit.id))
        throw new Error("Implementation binding also classified as external");
      ids.add(unit.id);
      positions.add(position);
      selectors.add(key);
      return {
        id: unit.id,
        file: unit.file,
        order: unit.order,
        headerDeclared: unit.headerDeclared,
        selector,
        references: [...new Set(unit.references)].sort(compare),
        context: [...(unit.context ?? [])],
      };
    })
    .sort((a, b) => compare(a.file, b.file) || a.order - b.order);
  const byId = new Map(units.map((unit, index) => [unit.id, index]));
  const parents = units.map((_, index) => index);
  function root(index) {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }
  for (const [index, unit] of units.entries()) {
    for (const id of unit.references) {
      const targetIndex = byId.get(id);
      if (targetIndex === undefined) {
        if (!externalIds.has(id)) throw new Error(`Unresolved implementation binding: ${id}`);
        continue;
      }
      const target = units[targetIndex];
      if (target.headerDeclared) continue;
      if (target.file !== unit.file)
        throw new Error(`Private implementation dependency crosses files: ${unit.id} -> ${id}`);
      const left = root(index),
        right = root(targetIndex);
      parents[Math.max(left, right)] = Math.min(left, right);
    }
  }
  const groups = new Map();
  for (const [index, unit] of units.entries()) {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, { file: unit.file, units: [] });
    groups.get(key).units.push(unit);
  }
  return [...groups.values()].map((group, index) => ({
    id: `implementation-${String(index + 1).padStart(3, "0")}`,
    ...group,
  }));
}

/** Prepare short neutral structural requests from already inventoried implementation units.
 * Public selectors and placement anchors identify current code, never private IDs or offsets.
 * Include requirements must come from trusted module context, not be inferred from names.
 * This does not add an independent C++ executor or establish inventory completeness.
 */
export function implementationRequests(
  input,
  { external = [], includesByFile, preamblesByFile = {} } = {},
) {
  const groups = implementationGroups(input, { external });
  const ordered = new Map();
  for (const group of groups) {
    const units = ordered.get(group.file) ?? [];
    units.push(...group.units);
    ordered.set(group.file, units);
  }
  for (const units of ordered.values()) units.sort((a, b) => a.order - b.order);
  const delivered = new Set();
  const requests = [];
  for (const group of groups) {
    const includes = includesByFile?.[group.file];
    if (
      !Array.isArray(includes) ||
      !includes.length ||
      includes.some(
        (item) =>
          !item ||
          typeof item.quoted !== "boolean" ||
          typeof item.file !== "string" ||
          !/^(?:[A-Za-z0-9_-]+\/)*[\w.-]+$/.test(item.file) ||
          item.file.startsWith(".") ||
          item.file.split("/").some((part) => part === "." || part === ".."),
      )
    )
      throw new Error(`Missing or unsafe direct includes for implementation file: ${group.file}`);
    const targets = group.units.map((unit) => {
      const existing = ordered.get(group.file).filter((item) => delivered.has(item.id));
      const after = existing.findLast((item) => item.order < unit.order)?.selector;
      const before = existing.find((item) => item.order > unit.order)?.selector;
      delivered.add(unit.id);
      return {
        selector: unit.selector,
        ...(unit.context.length ? { context: unit.context } : {}),
        ...(after ? { after } : {}),
        ...(before ? { before } : {}),
      };
    });
    const request = {
      id: group.id,
      phase: "structure",
      group: `implementation:${group.file}`,
      file: group.file,
      targets,
      includes: includes.map(({ file, quoted }) => ({ file, quoted })),
      ...(preamblesByFile[group.file] ? { preamble: preamblesByFile[group.file] } : {}),
      dependsOn: requests.length ? [requests.at(-1).id] : [],
      prompt: `Move the complete selected namespace-level units from \`main.cpp\` into \`${group.file}\`, in the listed order. Keep shared private helpers, types and data together. Preserve current names, function bodies, literals, conditional branches and namespace/using context. Leave public header declarations and bound call sites unchanged. Place each unit between its listed current-code anchors when those anchors are present. Compile the destination as a separate translation unit; do not include a .cpp file.\nTargets: ${JSON.stringify(targets)}\nDirect includes: ${JSON.stringify(includes)}\nDirective preamble: ${JSON.stringify(preamblesByFile[group.file] ?? "")}\nKeep earlier changes, do not restore names or add comments, and leave unrelated code alone. The grader checks the completed batch, not this intermediate edit.`,
    };
    assertNeutralSource("implementation-request", JSON.stringify(request));
    requests.push(request);
  }
  return requests;
}
