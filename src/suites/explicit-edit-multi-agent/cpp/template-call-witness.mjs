import { byteToCharacter } from "./cpp-offsets.mjs";

const integral = new Set([
  "bool",
  "char",
  "signed char",
  "unsigned char",
  "short",
  "unsigned short",
  "int",
  "unsigned int",
  "long",
  "unsigned long",
  "long long",
  "unsigned long long",
]);
const builtin = new Set(["void", "float", "double", "long double", ...integral]);
const plain = (location) =>
  Number.isSafeInteger(location?.offset) &&
  location.offset >= 0 &&
  !location.spellingLoc &&
  !location.expansionLoc &&
  !location.includedFrom &&
  !location.isMacroArgExpansion;
const complete = (node) =>
  Number(!!node?.loc) + Number(!!node?.range) + Number(Array.isArray(node?.inner));
const hasPack = (node) => node?.kind === "PackExpansionExpr" || (node?.inner ?? []).some(hasPack);
const typeChildren = (node) => (node.children ?? []).filter((child) => child.role === "type");
const oneType = (node) => (typeChildren(node).length === 1 ? typeChildren(node)[0] : undefined);
const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const samePosition = (first, second) =>
  first?.line === second?.line && first?.character === second?.character;

/** Prove a narrow template-call exclusion using compiler type nodes.
 * A builtin narrow string literal cannot deduce a dependent genuine class-template
 * reference. Otherwise true requires a visible viable sibling with Exact Match
 * reference binding while the selected family cannot obtain Exact Match.
 * Only the resulting surplus call edit may be omitted.
 * Unknown type sugar, deduction, visibility or viability returns false. No type
 * spelling establishes constructor identity; clangd's exact primary-template USR
 * and declaration-bound template parameter identities do. Inspector errors remain
 * operational errors, not evidence of incompatibility. Both inspector methods use
 * ordinary LSP UTF-16 ranges/positions in this unchanged compiler document.
 */
export function createTemplateCallWitness(roots, source, inspector) {
  const character = byteToCharacter(source);
  const starts = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") starts.push(index + 1);
  function position(byte) {
    const offset = character(byte);
    let low = 0,
      high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { line: low, character: offset - starts[low] };
  }
  function range(node) {
    const begin = node.range?.begin,
      end = node.range?.end;
    if (
      !plain(begin) ||
      !plain(end) ||
      !Number.isSafeInteger(end.tokLen) ||
      end.tokLen < 1 ||
      end.offset < begin.offset ||
      end.offset + end.tokLen > Buffer.byteLength(source)
    )
      return undefined;
    return { start: position(begin.offset), end: position(end.offset + end.tokLen) };
  }
  const nodes = new Map(),
    templateParents = new Map(),
    freeTemplates = new Set();
  function collect(node, blocked = false) {
    if (node.id && complete(node) > complete(nodes.get(node.id))) nodes.set(node.id, node);
    if (node.kind === "FunctionTemplateDecl") {
      if (!blocked) freeTemplates.add(node.id);
      for (const child of node.inner ?? [])
        if (child.kind === "FunctionDecl") {
          const parents = templateParents.get(child.id) ?? new Set();
          parents.add(node.id);
          templateParents.set(child.id, parents);
        }
    }
    const nested =
      blocked ||
      ["FunctionDecl", "CXXRecordDecl", "RecordDecl", "ClassTemplateDecl"].includes(node.kind);
    for (const child of node.inner ?? []) collect(child, nested);
  }
  for (const root of roots) collect(root);
  function canonical(id) {
    const visited = new Set();
    for (;;) {
      const node = nodes.get(id);
      if (!node || node.kind !== "FunctionTemplateDecl" || visited.has(id)) return undefined;
      visited.add(id);
      if (!node.previousDecl) return id;
      id = node.previousDecl;
    }
  }
  function templateOf(node) {
    if (node?.kind === "FunctionTemplateDecl") return canonical(node.id);
    const found = new Set([...(templateParents.get(node?.id) ?? [])].map(canonical));
    return found.size === 1 && !found.has(undefined) ? [...found][0] : undefined;
  }
  function familyOf(functions) {
    if (!Array.isArray(functions) || !functions.length) return undefined;
    const found = new Set(functions.map(templateOf));
    return found.size === 1 && !found.has(undefined) ? [...found][0] : undefined;
  }
  const astCache = new Map(),
    symbolCache = new Map(),
    headerCache = new Map(),
    modelCache = new Map();
  let documentUri;
  function inspect(node) {
    const selected = range(node);
    if (!selected) return undefined;
    const key = JSON.stringify(selected);
    if (!astCache.has(key)) astCache.set(key, inspector.ast(selected));
    return astCache.get(key);
  }
  async function symbols(at) {
    if (!at || !Number.isSafeInteger(at.line) || !Number.isSafeInteger(at.character)) return [];
    const key = JSON.stringify(at);
    if (!symbolCache.has(key)) symbolCache.set(key, inspector.symbols(at));
    const rows = await symbolCache.get(key);
    return Array.isArray(rows) &&
      rows.every((row) => typeof row?.usr === "string" && row.usr.length)
      ? [...new Map(rows.map((row) => [row.usr, row])).values()]
      : [];
  }
  async function identity(at) {
    const rows = await symbols(at);
    return rows.length === 1 ? rows[0].usr : undefined;
  }
  async function parameterType(parameter) {
    const ast = await inspect(parameter);
    if (ast?.role === "type") return ast;
    if (ast?.kind === "ParmVar") return oneType(ast);
    return undefined;
  }
  async function expression(node, parameters, mode) {
    if (node?.kind === "DeclRef" && mode === "pattern" && node.range) {
      const key = await identity(node.range.start),
        parameter = parameters.get(key);
      return parameter?.kind === "value"
        ? { kind: "value-parameter", id: key, type: parameter.type }
        : undefined;
    }
    if (!["Constant", "IntegerLiteral"].includes(node?.kind)) return undefined;
    const value = / '([^']+)'(?::'([^']+)')?(?:Int | )(-?\d+)\s*$/.exec(node.arcana ?? "");
    const type = value?.[2] ?? value?.[1];
    return integral.has(type)
      ? { kind: "value", type, value: BigInt(value[3]).toString() }
      : undefined;
  }
  async function parse(node, parameters, mode) {
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
      return parse(oneType(node), parameters, mode);
    }
    if (["LValueReference", "Pointer", "Qualified"].includes(node.kind)) {
      if (
        node.kind === "Qualified" &&
        !["const", "volatile", "const volatile"].includes(node.detail)
      )
        return undefined;
      const child = await parse(oneType(node), parameters, mode);
      return child ? { kind: node.kind, qualifier: node.detail, child } : undefined;
    }
    if (node.kind === "Builtin")
      return builtin.has(node.detail) ? { kind: "builtin", name: node.detail } : undefined;
    if (node.kind === "TemplateTypeParm") {
      if (mode === "concrete" || !node.range) return undefined;
      const id = await identity(node.range.start);
      if (!id) return undefined;
      if (mode === "pattern")
        return parameters.get(id)?.kind === "type" ? { kind: "type-parameter", id } : undefined;
      return { kind: "opaque-type", id };
    }
    if (node.kind === "TemplateSpecialization") {
      const names = (node.children ?? []).filter((child) => child.role === "template name");
      const arguments_ = (node.children ?? []).filter(
        (child) => child.role === "template argument",
      );
      if (
        names.length !== 1 ||
        !["Template", "UsingTemplate"].includes(names[0].kind) ||
        !node.range ||
        names.length + arguments_.length !== (node.children ?? []).length
      )
        return undefined;
      let named = await symbols(node.range.start);
      if (names[0].kind === "UsingTemplate") {
        const imports = named.filter((row) => /@UD@[A-Za-z_]\w*$/.test(row.usr));
        if (
          imports.some((row) => {
            if (!documentUri) return true;
            if (row.declarationRange?.uri !== documentUri) return true;
            const shadows = [...nodes.values()].filter(
              (entry) =>
                entry.kind === "UsingShadowDecl" &&
                plain(entry.loc) &&
                samePosition(position(entry.loc.offset), row.declarationRange.range?.start),
            );
            return (
              !shadows.length ||
              shadows.some(
                (entry) =>
                  entry.target?.kind !== "ClassTemplateDecl" ||
                  entry.target.name !== names[0].detail,
              )
            );
          })
        )
          return undefined;
        named = named.filter((row) => !imports.includes(row));
      }
      if (named.length !== 1 || named[0].name !== names[0].detail) return undefined;
      const declaration = /@ST>(\d+)[^@]*@([A-Za-z_]\w*)$/.exec(named[0].usr);
      if (
        !declaration ||
        declaration[2] !== named[0].name ||
        arguments_.length > Number(declaration[1])
      )
        return undefined;
      const args = [];
      for (const argument of arguments_) {
        if (argument.children?.length !== 1) return undefined;
        const child = argument.children[0];
        const value =
          argument.kind === "Type"
            ? await parse(child, parameters, mode)
            : argument.kind === "Expression"
              ? await expression(child, parameters, mode)
              : undefined;
        if (!value) return undefined;
        args.push(value);
      }
      return {
        kind: "template",
        id: named[0].usr,
        omitted: Number(declaration[1]) - args.length,
        args,
      };
    }
    if (["Typedef", "Using", "Record", "Enum"].includes(node.kind) && node.range) {
      const start = starts[node.range.start.line] + node.range.start.character;
      const end = starts[node.range.end.line] + node.range.end.character;
      if (!/^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*$/.test(source.slice(start, end))) return undefined;
      const values = [...new Set((await symbols(node.range.start)).map((row) => row.usr))].sort();
      return values.length ? { kind: "nominal", ids: values } : undefined;
    }
    return undefined;
  }
  function unsafe(node) {
    return (
      (node.inner ?? []).some((child) => child.kind.endsWith("Attr")) ||
      node.variadic ||
      node.requiresClause ||
      node.associatedConstraints
    );
  }
  async function header(id) {
    if (!headerCache.has(id)) headerCache.set(id, buildHeader(id));
    return headerCache.get(id);
  }
  async function model(id) {
    if (!modelCache.has(id)) modelCache.set(id, buildModel(id));
    return modelCache.get(id);
  }
  async function buildHeader(id) {
    const templates = [...nodes.values()].filter(
      (node) => node.kind === "FunctionTemplateDecl" && canonical(node.id) === id,
    );
    if (!templates.length || templates.some((node) => !freeTemplates.has(node.id) || unsafe(node)))
      return undefined;
    let representative, owner, returnType, count;
    for (const template of templates) {
      if (
        (template.inner ?? []).some(
          (node) =>
            !["TemplateTypeParmDecl", "NonTypeTemplateParmDecl", "FunctionDecl"].includes(
              node.kind,
            ),
        )
      )
        return undefined;
      for (const parameter of (template.inner ?? []).filter(
        (node) => node.kind !== "FunctionDecl",
      )) {
        if (
          !parameter.name ||
          parameter.isParameterPack ||
          parameter.defaultArg !== undefined ||
          parameter.defaultArgument !== undefined ||
          parameter.inner?.length ||
          !plain(parameter.loc)
        )
          return undefined;
        if (
          parameter.kind === "NonTypeTemplateParmDecl" &&
          !integral.has(parameter.type?.desugaredQualType ?? parameter.type?.qualType)
        )
          return undefined;
      }
      for (const observed of (template.inner ?? []).filter(
        (node) => node.kind === "FunctionDecl",
      )) {
        const fn = nodes.get(observed.id) ?? observed;
        if (
          unsafe(fn) ||
          unsafe(observed) ||
          (fn.inner ?? []).some(
            (node) =>
              !["ParmVarDecl", "CompoundStmt", "TemplateArgument", "FullComment"].includes(
                node.kind,
              ),
          )
        )
          return undefined;
        if ((fn.inner ?? []).some((node) => node.kind === "TemplateArgument")) continue;
        const parameters = (fn.inner ?? []).filter((node) => node.kind === "ParmVarDecl");
        const result = /^([^()]+) \(/.exec(fn.type?.qualType ?? "")?.[1];
        if (
          !builtin.has(result) ||
          !fn.type.qualType.endsWith(")") ||
          !plain(fn.loc) ||
          !parameters.length ||
          (returnType && returnType !== result) ||
          (count !== undefined && count !== parameters.length) ||
          parameters.some(
            (parameter) =>
              parameter.init !== undefined ||
              parameter.defaultArg !== undefined ||
              parameter.hasInheritedDefaultArg ||
              parameter.isParameterPack ||
              unsafe(parameter),
          )
        )
          return undefined;
        representative ??= fn;
        owner ??= template;
        returnType = result;
        count = parameters.length;
      }
    }
    if (!representative || !owner || !owner.inner.some((node) => node.kind !== "FunctionDecl"))
      return undefined;
    const parameters = new Map();
    for (const parameter of owner.inner.filter((node) => node.kind !== "FunctionDecl")) {
      const at = position(parameter.loc.offset);
      const declared = await symbols(at);
      if (
        declared.length !== 1 ||
        !declared[0].declarationRange?.uri ||
        !samePosition(declared[0].declarationRange.range?.start, at)
      )
        return undefined;
      const id_ = declared[0].usr;
      if (parameters.has(id_) || (documentUri && documentUri !== declared[0].declarationRange.uri))
        return undefined;
      documentUri = declared[0].declarationRange.uri;
      parameters.set(
        id_,
        parameter.kind === "TemplateTypeParmDecl"
          ? { kind: "type" }
          : { kind: "value", type: parameter.type.desugaredQualType ?? parameter.type.qualType },
      );
    }
    const inputs = representative.inner.filter((node) => node.kind === "ParmVarDecl");
    return { id, returnType, count, parameters, inputs };
  }
  async function buildModel(id) {
    const declaration = await header(id);
    if (!declaration) return undefined;
    const { inputs, parameters } = declaration;
    const prefix = [];
    for (const parameter of inputs.slice(0, -1)) {
      const parsed = await parse(await parameterType(parameter), parameters, "concrete");
      if (!parsed) return undefined;
      prefix.push(parsed);
    }
    const last = await parse(await parameterType(inputs.at(-1)), parameters, "pattern");
    const core = constReference(last);
    return core?.kind === "template" ? { ...declaration, prefix, last: core } : undefined;
  }
  function deducedParameter(type) {
    if (["type-parameter", "value-parameter"].includes(type.kind)) return true;
    if (type.kind === "template") return type.args.some(deducedParameter);
    return type.child ? deducedParameter(type.child) : false;
  }
  async function literalDeductionMismatch(declaration, call, callee) {
    if (callee.range.begin.offset !== callee.range.end.offset) return false;
    for (const [index, argument] of call.inner.slice(1).entries()) {
      if (
        argument?.kind !== "StringLiteral" ||
        argument.valueCategory !== "lvalue" ||
        !/^const char\s*\[[1-9]\d*\]$/.test(argument.type?.qualType ?? "") ||
        !range(argument)
      )
        continue;
      const type = await parse(
        await parameterType(declaration.inputs[index]),
        declaration.parameters,
        "pattern",
      );
      if (type?.kind !== "LValueReference") continue;
      const core =
        type.child.kind === "Qualified" && type.child.qualifier === "const"
          ? type.child.child
          : type.child;
      if (core.kind === "template" && deducedParameter(core)) return true;
    }
    return false;
  }
  function constReference(type) {
    return type?.kind === "LValueReference" &&
      type.child?.kind === "Qualified" &&
      type.child.qualifier === "const"
      ? type.child.child
      : undefined;
  }
  async function actualArgument(argument) {
    while (
      ["ParenExpr", "ImplicitCastExpr"].includes(argument?.kind) &&
      argument.inner?.length === 1
    ) {
      if (argument.kind === "ImplicitCastExpr" && argument.castKind !== "NoOp") return undefined;
      argument = argument.inner[0];
    }
    if (argument?.valueCategory !== "lvalue" || !range(argument)) return undefined;
    let type;
    if (argument.kind === "DeclRefExpr" && argument.referencedDecl?.kind === "ParmVarDecl") {
      const declaration = nodes.get(argument.referencedDecl.id);
      if (!declaration || !plain(declaration.loc)) return undefined;
      type = await parameterType(declaration);
    } else if (argument.kind === "CStyleCastExpr") {
      const ast = await inspect(argument);
      if (ast?.kind !== "CStyleCast") return undefined;
      type = oneType(ast);
    }
    return constReference(await parse(type, new Map(), "actual"));
  }
  function bind(pattern, actual, bindings) {
    if (pattern.kind === "type-parameter" || pattern.kind === "value-parameter") {
      if (
        pattern.kind === "value-parameter" &&
        (actual.kind !== "value" || actual.type !== pattern.type)
      )
        return false;
      if (pattern.kind === "type-parameter" && ["value", "value-parameter"].includes(actual.kind))
        return false;
      if (bindings.has(pattern.id)) return same(bindings.get(pattern.id), actual);
      bindings.set(pattern.id, actual);
      return true;
    }
    if (pattern.kind !== actual.kind) return false;
    if (pattern.kind === "template")
      return (
        pattern.id === actual.id &&
        pattern.omitted === actual.omitted &&
        pattern.args.length === actual.args.length &&
        pattern.args.every((item, index) => bind(item, actual.args[index], bindings))
      );
    if (pattern.child)
      return pattern.qualifier === actual.qualifier && bind(pattern.child, actual.child, bindings);
    return same(pattern, actual);
  }
  function constructorMismatch(pattern, actual) {
    if (pattern.kind !== "template" || actual.kind !== "template") return false;
    if (pattern.id !== actual.id) return true;
    return (
      pattern.args.length === actual.args.length &&
      pattern.args.some((item, index) => constructorMismatch(item, actual.args[index]))
    );
  }
  return async ({ selectedFunctions, candidateFamilies, call }) => {
    if (!Array.isArray(call?.inner) || !Array.isArray(candidateFamilies)) return false;
    let callee = call.inner[0];
    while (["ParenExpr", "ImplicitCastExpr"].includes(callee?.kind) && callee.inner?.length === 1)
      callee = callee.inner[0];
    if (
      callee?.kind !== "UnresolvedLookupExpr" ||
      !Array.isArray(callee.lookups) ||
      !range(callee) ||
      callee.templateArgs ||
      callee.hasExplicitTemplateArgs ||
      call.inner.slice(1).some(hasPack) ||
      callee.range.end.tokLen !== Buffer.byteLength(callee.name ?? "") ||
      Buffer.from(source)
        .subarray(callee.range.end.offset, callee.range.end.offset + callee.range.end.tokLen)
        .toString("utf8") !== callee.name
    )
      return false;
    const lookup = new Set(callee.lookups.map((item) => templateOf(nodes.get(item.id))));
    const selectedId = familyOf(selectedFunctions);
    if (!selectedId || !lookup.has(selectedId)) return false;
    const declaration = await header(selectedId);
    if (!declaration || declaration.count !== call.inner.length - 1) return false;
    if (await literalDeductionMismatch(declaration, call, callee)) return true;
    const selected = await model(selectedId);
    if (!selected) return false;
    const actual = await actualArgument(call.inner.at(-1));
    if (!actual || !constructorMismatch(selected.last, actual)) return false;
    for (const functions of candidateFamilies) {
      const candidateId = familyOf(functions);
      if (!candidateId || candidateId === selectedId || !lookup.has(candidateId)) continue;
      const candidate = await model(candidateId);
      if (
        !candidate ||
        candidate.count !== selected.count ||
        candidate.returnType !== selected.returnType ||
        !same(candidate.prefix, selected.prefix)
      )
        continue;
      const bindings = new Map();
      if (
        bind(candidate.last, actual, bindings) &&
        [...candidate.parameters.keys()].every((id) => bindings.has(id))
      )
        return true;
    }
    return false;
  };
}
