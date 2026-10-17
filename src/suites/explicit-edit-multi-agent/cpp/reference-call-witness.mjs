import { byteToCharacter } from "./cpp-offsets.mjs";

const plain = (location) =>
  Number.isSafeInteger(location?.offset) &&
  location.offset >= 0 &&
  !location.spellingLoc &&
  !location.expansionLoc &&
  !location.includedFrom &&
  !location.isMacroArgExpansion;
const complete = (node) =>
  Number(!!node?.loc) + Number(!!node?.range) + Number(Array.isArray(node?.inner));
const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const oneType = (node) => {
  const children = (node?.children ?? []).filter((child) => child.role === "type");
  return children.length === 1 ? children[0] : undefined;
};
const hasPack = (node) => node?.kind === "PackExpansionExpr" || (node?.inner ?? []).some(hasPack);

/** Prove only the ordinary free-function T& versus const T& overload case.
 * The differing parameter and actual argument must reference the same nominal
 * compiler type. A const lvalue cannot bind T&; a mutable lvalue prefers a visible
 * viable T& sibling when every other concrete parameter type is identical.
 * Lambda bodies are unsupported: a captured expression can be const even when
 * its original parameter is mutable. Unknown aliases at that parameter,
 * qualifiers, deduction, attributes or lookup metadata return false. Identical
 * concrete aliases elsewhere are compared by their compiler identities, never
 * by spelling. Inspector positions/ranges are
 * LSP UTF-16 in the unchanged document; operational inspector failures propagate.
 * The caller must still require agreement from every observation of the token.
 */
export function createReferenceCallWitness(roots, source, inspector) {
  const character = byteToCharacter(source);
  const bytes = Buffer.from(source);
  const lines = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") lines.push(index + 1);
  function position(byte) {
    const offset = character(byte);
    let low = 0,
      high = lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle] <= offset) low = middle;
      else high = middle;
    }
    return { line: low, character: offset - lines[low] };
  }
  function range(node) {
    const begin = node?.range?.begin,
      end = node?.range?.end;
    if (
      !plain(begin) ||
      !plain(end) ||
      !Number.isSafeInteger(end.tokLen) ||
      end.tokLen < 1 ||
      end.offset < begin.offset ||
      end.offset + end.tokLen > bytes.length
    )
      return undefined;
    return { start: position(begin.offset), end: position(end.offset + end.tokLen) };
  }
  const nodes = new Map(),
    free = new Set(),
    lambdaNodes = new WeakSet();
  function collect(node, blocked = false, inLambda = false) {
    inLambda ||= node.kind === "LambdaExpr";
    if (inLambda) lambdaNodes.add(node);
    if (node.id && complete(node) > complete(nodes.get(node.id))) nodes.set(node.id, node);
    if (node.kind === "FunctionDecl" && !blocked) free.add(node.id);
    const nested =
      blocked ||
      [
        "FunctionDecl",
        "FunctionTemplateDecl",
        "CXXRecordDecl",
        "RecordDecl",
        "ClassTemplateDecl",
      ].includes(node.kind);
    for (const child of node.inner ?? []) collect(child, nested, inLambda);
  }
  roots.forEach((root) => collect(root));
  function canonical(id) {
    const seen = new Set();
    for (;;) {
      const node = nodes.get(id);
      if (node?.kind !== "FunctionDecl" || !free.has(id) || seen.has(id)) return undefined;
      seen.add(id);
      if (!node.previousDecl) return id;
      id = node.previousDecl;
    }
  }
  function family(functions) {
    if (!Array.isArray(functions) || !functions.length) return undefined;
    const found = new Set(functions.map((node) => canonical(node?.id)));
    return found.size === 1 && !found.has(undefined) ? [...found][0] : undefined;
  }
  const inspections = new Map(),
    symbols = new Map(),
    models = new Map();
  async function identity(at) {
    if (!at || !Number.isSafeInteger(at.line) || !Number.isSafeInteger(at.character)) return [];
    const key = JSON.stringify(at);
    if (!symbols.has(key)) symbols.set(key, inspector.symbols(at));
    const rows = await symbols.get(key);
    return Array.isArray(rows) &&
      rows.length &&
      rows.every((row) => typeof row?.usr === "string" && row.usr.length)
      ? [...new Set(rows.map((row) => row.usr))].sort()
      : [];
  }
  async function parameterType(parameter) {
    const selected = range(parameter);
    if (!selected) return undefined;
    const key = JSON.stringify(selected);
    if (!inspections.has(key)) inspections.set(key, inspector.ast(selected));
    const ast = await inspections.get(key);
    return parse(ast?.role === "type" ? ast : ast?.kind === "ParmVar" ? oneType(ast) : undefined);
  }
  async function parse(node) {
    if (!node || node.role !== "type") return undefined;
    if (node.kind === "Elaborated") {
      if (
        (node.children ?? []).some(
          (child) =>
            child.role !== "type" &&
            !(child.role === "specifier" && ["Namespace", "Global"].includes(child.kind)),
        )
      )
        return undefined;
      return parse(oneType(node));
    }
    if (["LValueReference", "Pointer", "Qualified"].includes(node.kind)) {
      if (node.kind === "Qualified" && node.detail !== "const") return undefined;
      const child = await parse(oneType(node));
      return child ? { kind: node.kind, qualifier: node.detail, child } : undefined;
    }
    if (node.kind === "Builtin") return { kind: "builtin", name: node.detail };
    if (["Record", "Enum", "Typedef", "Using"].includes(node.kind) && node.range) {
      const start = lines[node.range.start.line] + node.range.start.character;
      const end = lines[node.range.end.line] + node.range.end.character;
      if (!/^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*$/.test(source.slice(start, end))) return undefined;
      const ids = await identity(node.range.start);
      if (!ids.length || (["Record", "Enum"].includes(node.kind) && ids.length !== 1))
        return undefined;
      return { kind: node.kind === "Record" ? "record" : "nominal", ids };
    }
    return undefined;
  }
  function reference(type) {
    if (type?.kind !== "LValueReference") return undefined;
    const isConst = type.child?.kind === "Qualified" && type.child.qualifier === "const";
    const core = isConst ? type.child.child : type.child;
    return core?.kind === "record" && core.ids.length === 1
      ? { id: core.ids[0], isConst }
      : undefined;
  }
  function unsafe(node) {
    return (
      node.variadic ||
      node.isDeleted ||
      node.explicitlyDeleted ||
      node.requiresClause ||
      node.associatedConstraints ||
      (node.inner ?? []).some((child) => child.kind.endsWith("Attr"))
    );
  }
  async function model(id) {
    if (!models.has(id)) models.set(id, buildModel(id));
    return models.get(id);
  }
  async function buildModel(id) {
    const functions = [...nodes.values()].filter(
      (node) => node.kind === "FunctionDecl" && canonical(node.id) === id,
    );
    let expected;
    for (const fn of functions) {
      if (
        unsafe(fn) ||
        !plain(fn.loc) ||
        !range(fn) ||
        !fn.type?.qualType?.endsWith(")") ||
        !Array.isArray(fn.inner) ||
        fn.inner.some((node) => !["ParmVarDecl", "CompoundStmt", "FullComment"].includes(node.kind))
      )
        return undefined;
      const parameters = fn.inner.filter((node) => node.kind === "ParmVarDecl");
      if (
        !parameters.length ||
        parameters.some(
          (node) =>
            unsafe(node) ||
            node.init !== undefined ||
            node.defaultArg !== undefined ||
            node.hasInheritedDefaultArg ||
            node.isParameterPack,
        )
      )
        return undefined;
      const types = [];
      for (const parameter of parameters) {
        const type = await parameterType(parameter);
        if (!type) return undefined;
        types.push(type);
      }
      if (expected && !same(expected, types)) return undefined;
      expected = types;
    }
    return expected;
  }
  async function actual(argument) {
    while (
      ["ParenExpr", "ImplicitCastExpr"].includes(argument?.kind) &&
      argument.inner?.length === 1
    ) {
      if (argument.kind === "ImplicitCastExpr" && argument.castKind !== "NoOp") return undefined;
      argument = argument.inner[0];
    }
    if (
      argument?.kind !== "DeclRefExpr" ||
      lambdaNodes.has(argument) ||
      argument.valueCategory !== "lvalue" ||
      argument.referencedDecl?.kind !== "ParmVarDecl" ||
      !range(argument)
    )
      return undefined;
    const declaration = nodes.get(argument.referencedDecl.id);
    return declaration && plain(declaration.loc)
      ? reference(await parameterType(declaration))
      : undefined;
  }
  return async ({ selectedFunctions, candidateFamilies, call }) => {
    if (
      !Array.isArray(call?.inner) ||
      !Array.isArray(candidateFamilies) ||
      call.inner.slice(1).some(hasPack)
    )
      return false;
    let callee = call.inner[0];
    while (["ParenExpr", "ImplicitCastExpr"].includes(callee?.kind) && callee.inner?.length === 1)
      callee = callee.inner[0];
    if (
      callee?.kind !== "UnresolvedLookupExpr" ||
      !Array.isArray(callee.lookups) ||
      !range(callee) ||
      callee.templateArgs ||
      callee.hasExplicitTemplateArgs ||
      callee.range.end.tokLen !== Buffer.byteLength(callee.name ?? "") ||
      bytes
        .subarray(callee.range.end.offset, callee.range.end.offset + callee.range.end.tokLen)
        .toString("utf8") !== callee.name
    )
      return false;
    const lookup = new Set(callee.lookups.map((node) => canonical(node.id)));
    const selectedId = family(selectedFunctions);
    if (!selectedId || !lookup.has(selectedId)) return false;
    const selected = await model(selectedId);
    if (!selected || selected.length !== call.inner.length - 1) return false;
    for (const functions of candidateFamilies) {
      const id = family(functions);
      if (!id || id === selectedId || !lookup.has(id)) continue;
      const candidate = await model(id);
      if (!candidate || candidate.length !== selected.length) continue;
      const differences = selected.flatMap((type, index) =>
        same(type, candidate[index]) ? [] : [index],
      );
      if (differences.length !== 1) continue;
      const index = differences[0],
        from = reference(selected[index]),
        to = reference(candidate[index]);
      if (!from || !to || from.id !== to.id || from.isConst === to.isConst) continue;
      const argument = await actual(call.inner[index + 1]);
      if (!argument || argument.id !== from.id) continue;
      if (
        (!from.isConst && to.isConst && argument.isConst) ||
        (from.isConst && !to.isConst && !argument.isConst)
      )
        return true;
    }
    return false;
  };
}
