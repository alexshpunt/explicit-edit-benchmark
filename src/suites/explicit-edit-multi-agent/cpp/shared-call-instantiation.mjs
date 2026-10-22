import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectAst } from "./compiler-ast.mjs";
import { createDirectCallEditFilter } from "./direct-call-edits.mjs";
import { cppTokens } from "./cpp-tokens.mjs";

const identifier = /^[A-Za-z_]\w*$/;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const plain = (location) =>
  Number.isSafeInteger(location?.offset) &&
  location.offset >= 0 &&
  !location.spellingLoc &&
  !location.expansionLoc &&
  !location.includedFrom &&
  !location.isMacroArgExpansion;
const parameters = (node) => (node.inner ?? []).filter((child) => child.kind === "ParmVarDecl");
const substituted = (node) => (node.inner ?? []).some((child) => child.kind === "TemplateArgument");
function walk(roots, visit) {
  function descend(node, ancestors) {
    visit(node, ancestors);
    for (const child of node.inner ?? []) descend(child, [...ancestors, node]);
  }
  for (const root of roots) descend(root, []);
}
function index(roots) {
  const nodes = new Map();
  walk(roots, (node) => {
    const score = (item) => Number(!!item?.loc) + Number(!!item?.range) + Number(!!item?.inner);
    if (node.id && score(node) > score(nodes.get(node.id))) nodes.set(node.id, node);
  });
  return nodes;
}
function unsupported(node) {
  // Clang emits {} for absent ForStmt slots; other nameless metadata is unknown.
  if (typeof node.kind !== "string") return Object.keys(node).length !== 0;
  return (
    node.kind.endsWith("Attr") ||
    node.isParameterPack ||
    node.variadic ||
    ["RequiresExpr", "ConceptSpecializationExpr"].includes(node.kind) ||
    (node.inner ?? []).some(unsupported)
  );
}
function writtenFunction(node) {
  return (
    plain(node.loc) &&
    plain(node.range?.begin) &&
    plain(node.range?.end) &&
    parameters(node).every(
      (parameter) => plain(parameter.range?.begin) && plain(parameter.range?.end),
    )
  );
}
function callee(call) {
  let node = call.inner?.[0];
  while (["ImplicitCastExpr", "ParenExpr"].includes(node?.kind) && node.inner?.length === 1)
    node = node.inner[0];
  return node;
}
function reference(node) {
  return node?.range?.begin?.offset === node?.range?.end?.offset &&
    plain(node.range.begin) &&
    plain(node.range.end)
    ? node.range.begin.offset
    : undefined;
}
function canonical(nodes, node, kind) {
  const seen = new Set();
  while (node?.kind === kind && !seen.has(node.id)) {
    seen.add(node.id);
    if (!node.previousDecl) return node.id;
    node = nodes.get(node.previousDecl);
  }
  return undefined;
}
function withoutIds(node) {
  const { id: _id, inner, ...rest } = node;
  return { ...rest, ...(inner ? { inner: inner.map(withoutIds) } : {}) };
}

/** Prove PRIVATE shared-call binding by instantiating the original template.
 * The supported free template has one type parameter, the concrete overloads'
 * argument count plus one parameter, and one unambiguous int slot. Probe calls
 * explicitly supply every enclosing parameter. If the enclosing template itself
 * shares the call, a fresh empty type can witness its original binding; no new
 * target overload is added. Concrete parameter spellings and substitution text
 * generate guesses only: successful compilation, fresh declaration
 * origins and resolution of the same original call token establish the proof.
 * Original source bytes are an unchanged prefix of a unique probe file. A private
 * VFS overlay retains the original logical filename and relative include context.
 * Clock-sensitive input is unsupported. The original disk file is never replaced. AST IDs
 * are never compared across compiler lifetimes. Resolved observations are mapped
 * back through original declaration byte offsets, then combined with ALL original
 * observations so unknown metadata and incomplete lookup coverage still veto.
 * Undefined means unsupported syntax, failed instantiation or insufficient proof.
 * Filesystem/compiler launch errors propagate. The caller owns private directory
 * cleanup and must hash-bind returned evidence; none of it belongs in worker input.
 */
export async function proveSharedCallInstantiation({
  roots,
  source,
  required,
  allowed,
  edit,
  directory,
  sourcePath,
}) {
  if (
    typeof source !== "string" ||
    typeof sourcePath !== "string" ||
    !path.isAbsolute(sourcePath) ||
    !Array.isArray(roots) ||
    !Array.isArray(required) ||
    required.length < 2 ||
    !Array.isArray(allowed) ||
    !identifier.test(edit?.old ?? "") ||
    !identifier.test(edit?.new ?? "") ||
    edit.old === edit.new ||
    !Number.isSafeInteger(edit.start) ||
    edit.start < 0 ||
    source.slice(edit.start, edit.start + edit.old.length) !== edit.old
  )
    return undefined;
  // A new compiler invocation cannot preserve wall-clock builtins. Reject their
  // source tokens and expanded literal forms, including token-pasted macros.
  const clocks = new Set(["__TIME__", "__DATE__", "__TIMESTAMP__"]);
  if (cppTokens(source).some((token) => clocks.has(token.text))) return undefined;
  const clockLiterals = [];
  walk(roots, (node) => {
    if (
      node.kind === "StringLiteral" &&
      /(?:\d{2}:\d{2}:\d{2}|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [\w :]+ \d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]{2} \d{4})/.test(
        node.value ?? "",
      )
    )
      clockLiterals.push(node);
  });
  if (clockLiterals.length) return undefined;
  if ((await readFile(sourcePath, "utf8")) !== source)
    throw Error("Private instantiation source file differs from its compiler snapshot");
  const bytes = Buffer.from(source),
    offset = Buffer.byteLength(source.slice(0, edit.start)),
    nodes = index(roots),
    templateParents = new Map();
  walk(roots, (node) => {
    if (node.kind === "FunctionTemplateDecl")
      for (const child of node.inner ?? [])
        if (child.kind === "FunctionDecl") templateParents.set(child.id, node);
  });
  const families = new Map(),
    origin = new Map();
  for (const node of nodes.values()) {
    if (node.kind !== "FunctionDecl" || !plain(node.loc) || substituted(node)) continue;
    const key = canonical(nodes, node, "FunctionDecl");
    if (!key) continue;
    const family = families.get(key) ?? [];
    family.push(node);
    families.set(key, family);
    const keys = origin.get(node.loc.offset) ?? new Set();
    keys.add(key);
    origin.set(node.loc.offset, keys);
  }
  function select(entries) {
    const result = new Map();
    for (const entry of entries) {
      if (
        entry?.role !== "function" ||
        entry.name !== edit.old ||
        entry.newName !== edit.new ||
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        bytes.subarray(entry.offset, entry.offset + Buffer.byteLength(edit.old)).toString() !==
          edit.old
      )
        return undefined;
      const keys = origin.get(entry.offset);
      if (keys?.size !== 1) return undefined;
      const key = [...keys][0],
        family = families.get(key);
      if (!family?.length || family.some((node) => !writtenFunction(node) || unsupported(node)))
        return undefined;
      result.set(key, family);
    }
    return result;
  }
  const needed = select(required),
    permitted = select(allowed);
  if (
    !needed ||
    needed.size < 2 ||
    !permitted ||
    [...needed.keys()].some((key) => !permitted.has(key))
  )
    return undefined;
  function lookupFamily(id) {
    let node = nodes.get(id);
    if (node?.kind === "FunctionTemplateDecl")
      node = node.inner?.find((child) => child.kind === "FunctionDecl" && !substituted(child));
    return canonical(nodes, node, "FunctionDecl");
  }
  const enclosing = [];
  walk(roots, (node, ancestors) => {
    if (node.kind !== "CallExpr") return;
    const target = callee(node);
    if (
      target?.kind !== "UnresolvedLookupExpr" ||
      target.name !== edit.old ||
      reference(target) !== offset
    )
      return;
    if (!Array.isArray(target.lookups)) return;
    const lookup = new Set(target.lookups.map((item) => lookupFamily(item.id)));
    if ([...needed.keys()].some((key) => !lookup.has(key))) return;
    const owner = ancestors.findLast((item) => item.kind === "FunctionDecl");
    const template = templateParents.get(owner?.id);
    if (!owner || substituted(owner) || !template) return;
    const parents = ancestors.slice(0, ancestors.indexOf(template));
    if (parents.some((item) => item.kind !== "NamespaceDecl" || !identifier.test(item.name ?? "")))
      return;
    enclosing.push({ owner, template, namespaces: parents.map((item) => item.name) });
  });
  if (!enclosing.length) return undefined;
  const chosen = enclosing[0];
  const templateKey = canonical(nodes, chosen.template, "FunctionTemplateDecl");
  if (
    !templateKey ||
    enclosing.some(
      (item) => canonical(nodes, item.template, "FunctionTemplateDecl") !== templateKey,
    )
  )
    return undefined;
  const templateFamily = [...nodes.values()].filter(
    (node) =>
      node.kind === "FunctionTemplateDecl" &&
      canonical(nodes, node, "FunctionTemplateDecl") === templateKey,
  );
  const enclosingOffsets = new Set();
  for (const template of templateFamily) {
    const types = (template.inner ?? []).filter((node) => node.kind !== "FunctionDecl");
    if (types.length !== 1 || types[0].kind !== "TemplateTypeParmDecl" || unsupported(template))
      return undefined;
    for (const child of template.inner ?? []) {
      if (child.kind !== "FunctionDecl") continue;
      // Forward template declarations can carry shallow instantiation stubs.
      // Resolve their complete metadata before separating written declarations
      // from substituted copies, as the current-source selector view does.
      const fn = nodes.get(child.id) ?? child;
      if (substituted(fn)) continue;
      if (!writtenFunction(fn)) return undefined;
      enclosingOffsets.add(fn.loc.offset);
    }
  }
  const ownerParameters = parameters(chosen.owner);
  const arity = ownerParameters.length - 1;
  const integerSlots = ownerParameters.flatMap((parameter, position) =>
    parameter.type?.qualType === "int" ? [position] : [],
  );
  if (arity < 1 || integerSlots.length !== 1) return undefined;
  const integerSlot = integerSlots[0];
  const qualified = `::${[...chosen.namespaces, chosen.owner.name].join("::")}`;
  if (!identifier.test(chosen.owner.name ?? "")) return undefined;
  const namespace = `atomic_instantiation_${hash(source + JSON.stringify(required)).slice(0, 20)}`;
  const freshType = `::${[...chosen.namespaces, namespace, "SharedValue"].join("::")}`;
  const typeParameter = chosen.template.inner.find((node) => node.kind === "TemplateTypeParmDecl");
  const chunks = [],
    generated = [];
  let needsFreshType = false;
  for (const [key, family] of needed) {
    const templates = family.map((node) => templateParents.get(node.id));
    const self = templates.some(Boolean);
    if (
      self &&
      (templates.some(
        (template) => canonical(nodes, template, "FunctionTemplateDecl") !== templateKey,
      ) ||
        !identifier.test(typeParameter?.name ?? ""))
    )
      return undefined;
    if (!self && family.some((node) => parameters(node).length !== arity)) return undefined;
    let types = (self ? ownerParameters : parameters(family[0])).map((node) => node.type?.qualType);
    if (self) {
      const parameter = new RegExp(`\\b${typeParameter.name}\\b`, "g");
      if (!types.some((type) => typeof type === "string" && parameter.test(type))) return undefined;
      types = types.map((type) => type?.replace(parameter, freshType));
      needsFreshType = true;
    }
    // These strings are candidate source, never a semantic type comparison.
    if (
      types.some(
        (type) => typeof type !== "string" || !/^(?:::)?[A-Za-z_][A-Za-z_0-9 :<>,*&]*$/.test(type),
      )
    )
      return undefined;
    const ordinal = chunks.length;
    const args = types.map((type, number) => `${type} argument_${ordinal}_${number}();`).join("\n");
    const arguments_ = types.map((_, number) => `argument_${ordinal}_${number}()`);
    if (self) arguments_[integerSlot] = "0";
    else arguments_.splice(integerSlot, 0, "0");
    chunks.push(
      `${args}\nvoid invoke_${ordinal}() { (void) ${qualified}(${arguments_.join(", ")}); }`,
    );
    generated.push(key);
  }
  const suffix = `\n${chosen.namespaces.map((name) => `namespace ${name} {`).join("\n")}\nnamespace ${namespace} {\n${needsFreshType ? "struct SharedValue {};\n" : ""}${chunks.join("\n")}\n}\n${chosen.namespaces.map(() => "}").join("\n")}\n`;
  const probeSource = source + suffix;
  const probeDirectory = await mkdtemp(path.join(directory, "shared-call-probe-"));
  const probeFile = path.join(probeDirectory, "probe.cpp");
  await writeFile(probeFile, probeSource, { flag: "wx", mode: 0o600 });
  const originalStat = await stat(sourcePath);
  await utimes(probeFile, originalStat.atime, originalStat.mtime);
  const overlay = JSON.stringify({
    version: 0,
    "use-external-names": false,
    roots: [{ type: "file", name: sourcePath, "external-contents": probeFile }],
  });
  const overlayFile = path.join(probeDirectory, "overlay.json");
  await writeFile(overlayFile, overlay, { flag: "wx", mode: 0o600 });
  let probeRoots;
  try {
    probeRoots = await projectAst(sourcePath, [
      "-std=c++17",
      "-pthread",
      "-ivfsoverlay",
      overlayFile,
    ]);
  } catch (error) {
    if (error.message.startsWith("Compiler AST failed:") && /\berror:/.test(error.message))
      return undefined;
    throw error;
  }
  const probeNodes = index(probeRoots),
    invocationOrigins = [];
  walk(probeRoots, (node) => {
    if (node.kind !== "CallExpr" || node.range?.begin?.offset < bytes.length) return;
    const target = callee(node);
    if (target?.kind !== "DeclRefExpr" || target.referencedDecl?.name !== chosen.owner.name) return;
    const declaration = probeNodes.get(target.referencedDecl.id);
    if (!plain(declaration?.loc) || !enclosingOffsets.has(declaration.loc.offset)) return;
    invocationOrigins.push(declaration.loc.offset);
  });
  if (invocationOrigins.length !== generated.length) return undefined;
  if (!createDirectCallEditFilter(probeRoots, probeSource).sharedCall({ required, allowed, edit }))
    return undefined;
  const mapped = [];
  walk(probeRoots, (node) => {
    if (node.kind !== "CallExpr") return;
    const target = callee(node);
    if (target?.kind !== "DeclRefExpr" || reference(target) !== offset) return;
    const declaration = probeNodes.get(target.referencedDecl?.id);
    if (!plain(declaration?.loc)) return;
    const keys = origin.get(declaration.loc.offset);
    if (keys?.size !== 1) return;
    const key = [...keys][0];
    if (!permitted.has(key)) return;
    const row = withoutIds(node);
    const mappedCallee = callee(row);
    mappedCallee.referencedDecl = { id: key, kind: "FunctionDecl", name: edit.old };
    delete mappedCallee.foundReferencedDecl;
    mapped.push(row);
  });
  const keep = createDirectCallEditFilter([...roots, ...mapped], source);
  if (!keep.sharedCall({ required, allowed, edit })) return undefined;
  return {
    sharedCall: (input) =>
      Number.isSafeInteger(input?.edit?.start) &&
      identifier.test(input?.edit?.old ?? "") &&
      input.edit.start >= 0 &&
      input.edit.start + input.edit.old.length <= source.length &&
      keep.sharedCall(input),
    evidence: {
      version: "renderer-shared-call-instantiation-v2",
      sourceSha256: hash(source),
      probeSha256: hash(probeSource),
      suffix,
      probeFile,
      logicalFile: sourcePath,
      overlayFile,
      overlaySha256: hash(overlay),
      calleeOffset: offset,
      enclosingOffsets: [...enclosingOffsets].sort((a, b) => a - b),
      requiredDeclarations: [...needed.values()].map((family) =>
        [...new Set(family.map((node) => node.loc.offset))].sort((a, b) => a - b),
      ),
      invocationOrigins,
    },
  };
}
