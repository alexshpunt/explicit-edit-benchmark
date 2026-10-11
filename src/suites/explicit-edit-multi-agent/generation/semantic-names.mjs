import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cppTokens, treeIdentity, writeTree } from "./generator.mjs";
import { semanticEdits } from "../cpp/clangd-renames.mjs";
import { projectAst } from "../cpp/compiler-ast.mjs";
import { byteToCharacter } from "../cpp/cpp-offsets.mjs";
import { assignNames, namingSummary, vocabularyIdentity } from "./name-vocabulary.mjs";

const execFile = promisify(execFileCallback);
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
const options = {
  timeout: 180_000,
  maxBuffer: 256 * 1024 * 1024,
  env: { ...process.env, LC_ALL: "C" },
};

function candidates(roots, bytes, sourcePath, category) {
  const found = new Map(),
    excluded = new Map(),
    nodes = new Map();
  const types = new Set([
    "CXXRecordDecl",
    "RecordDecl",
    "EnumDecl",
    "TypedefDecl",
    "TypeAliasDecl",
  ]);
  const dependentMembers = new Set();
  const macroWords = new Set();
  const text = bytes.toString("utf8");
  for (const directive of text.matchAll(/^[ \t]*#define[^\n]*(?:\\\r?\n[^\n]*)*/gm))
    for (const token of cppTokens(directive[0]))
      if (identifier.test(token.text)) macroWords.add(token.text);
  // Token pasting synthesizes identifiers with no editable physical token.
  for (const directive of text.matchAll(/^[ \t]*#define[^\n]*##[^\n]*/gm)) {
    const macro = /#define[ \t]+([A-Za-z_][A-Za-z_0-9]*)/.exec(directive[0])?.[1];
    if (!macro) continue;
    for (const call of text.matchAll(new RegExp("\\b" + macro + "\\(([^)]+)\\)", "g"))) {
      for (const token of cppTokens(call[1]))
        if (identifier.test(token.text)) {
          macroWords.add(token.text);
          for (const suffix of directive[0].matchAll(/##[ \t]*([A-Za-z_][A-Za-z_0-9]*)/g))
            macroWords.add(token.text + suffix[1]);
        }
    }
  }
  function collect(node) {
    if (node.id) nodes.set(node.id, node);
    if (node.kind === "CXXDependentScopeMemberExpr") dependentMembers.add(node.member);
    for (const child of node.inner ?? []) collect(child);
  }
  for (const root of roots) collect(root);
  function canonical(node) {
    while (node.previousDecl && nodes.has(node.previousDecl)) node = nodes.get(node.previousDecl);
    return node.loc?.offset ?? node.loc?.spellingLoc?.offset;
  }
  function visit(node, scope = "", inFunction = false, owner) {
    const isFunction = /^(FunctionDecl|CXXMethodDecl|CXXConstructorDecl|CXXDestructorDecl)$/.test(
      node.kind,
    );
    const functionContext = inFunction || isFunction;
    const functionOwner =
      owner ??
      (isFunction
        ? {
            kind: "function",
            scope: [scope, node.name].filter(Boolean).join("::"),
            signature: (node.type?.qualType ?? "").replace(/ at [^()]+:\d+:\d+(?=\))/g, ""),
          }
        : undefined);
    let role;
    if (category === "functions-types") {
      if (["FunctionDecl", "CXXMethodDecl"].includes(node.kind)) role = "function";
      else if (types.has(node.kind)) role = "type";
    } else if (category === "fields" && node.kind === "FieldDecl") role = "field";
    else if (
      category === "locals-parameters" &&
      (node.kind === "ParmVarDecl" || node.kind === "VarDecl")
    )
      role =
        node.kind === "ParmVarDecl"
          ? "parameter"
          : !functionContext || node.storageClass === "extern"
            ? "variable"
            : "local";
    const location = node.loc;
    if (
      role &&
      !node.isImplicit &&
      identifier.test(node.name ?? "") &&
      location &&
      !location.includedFrom &&
      (!location.file || path.resolve(location.file) === sourcePath)
    ) {
      const physical = location.offset ?? location.spellingLoc?.offset;
      let reason;
      if (!Number.isInteger(location.offset)) reason = "macro declaration";
      else if (macroWords.has(node.name)) reason = "macro-sensitive identifier";
      else if (node.kind === "CXXMethodDecl")
        reason = "member protocol (not selected independently)";
      else if (
        role === "function" &&
        ["main", "begin", "end", "size", "swap", "get"].includes(node.name)
      )
        reason = "language/library protocol";
      else if (role === "field" && dependentMembers.has(node.name))
        reason = "dependent member reference";
      if (
        Number.isInteger(physical) &&
        bytes.subarray(physical, physical + Buffer.byteLength(node.name)).toString("utf8") ===
          node.name
      ) {
        if (reason) excluded.set(physical, { name: node.name, offset: physical, reason });
        else {
          const family = [
            scope,
            role,
            node.name,
            ["local", "parameter", "variable"].includes(role) ? canonical(node) : "",
          ].join(":");
          const entry = { name: node.name, offset: physical, role, scope, family };
          if (["local", "parameter"].includes(role)) {
            if (!functionOwner?.signature) throw new Error("Missing function binding owner");
            entry.owner = functionOwner;
          }
          // Template instantiations can repeat a declaration at the same physical token.
          if (!found.has(physical)) found.set(physical, entry);
        }
      }
    }
    let childScope = scope;
    if (
      node.kind === "NamespaceDecl" ||
      ["CXXRecordDecl", "RecordDecl", "EnumDecl"].includes(node.kind)
    )
      childScope = [scope, node.name || "anonymous@" + node.loc?.offset].filter(Boolean).join("::");
    else if (isFunction)
      childScope = [scope, node.name + "@" + canonical(node)].filter(Boolean).join("::");
    for (const child of node.inner ?? []) visit(child, childScope, functionContext, functionOwner);
  }
  for (const root of roots) visit(root);
  // An extern in a function and its namespace definition belong to one family.
  const localFamilies = new Map();
  for (const entry of found.values()) {
    if (!["local", "parameter", "variable"].includes(entry.role)) continue;
    const identity = entry.family.split(":").at(-1);
    const key = entry.role + ":" + identity;
    if (localFamilies.has(key)) entry.family = localFamilies.get(key);
    else localFamilies.set(key, entry.family);
  }
  return {
    selection: [...found.values()].sort((a, b) => a.offset - b.offset),
    excluded: [...excluded.values()].sort((a, b) => a.offset - b.offset),
  };
}

// Local references carry an exact declaration ID in Clang's AST. Use it only
// in memory; neither compiler IDs nor unrelated same-spelling tokens are edited.
/** @param {((a: string, b: string) => void) | null} merge */
function localEdits(roots, selection, source, merge = null) {
  const byOffset = new Map(selection.map((entry) => [entry.offset, entry]));
  const bindings = new Map();
  const nodes = new Map();
  const bytes = Buffer.from(source);
  const characterOffset = byteToCharacter(source);
  function declarations(node) {
    if (["VarDecl", "ParmVarDecl"].includes(node.kind)) {
      nodes.set(node.id, node);
      const entry = byOffset.get(node.loc?.offset);
      if (entry && node.name === entry.name) bindings.set(node.id, entry);
    }
    for (const child of node.inner ?? []) declarations(child);
  }
  for (const root of roots) declarations(root);
  function canonical(id) {
    while (nodes.get(id)?.previousDecl) id = nodes.get(id).previousDecl;
    return id;
  }
  const groups = new Map([...bindings].map(([id, entry]) => [canonical(id), entry]));
  for (const [id] of nodes) {
    const entry = groups.get(canonical(id));
    if (entry) bindings.set(id, entry);
  }
  const edits = new Map();
  function add(entry, location) {
    location = location?.spellingLoc ?? location;
    if (
      !Number.isInteger(location?.offset) ||
      bytes.subarray(location.offset, location.offset + location.tokLen).toString("utf8") !==
        entry.name
    )
      throw new Error(`Unsupported local reference: ${entry.name} at byte ${location?.offset}`);
    const start = characterOffset(location.offset);
    const edit = { start, old: entry.name, new: entry.newName, families: [entry.family] };
    const previous = edits.get(start);
    if (previous && previous.new !== edit.new) {
      if (merge && previous.old === edit.old) merge(previous.new, edit.new);
      else throw new Error(`Conflicting local bindings at ${start}: ${entry.name}`);
    }
    if (previous) edit.families = [...new Set([...previous.families, ...edit.families])].sort();
    edits.set(start, edit);
  }
  for (const entry of selection)
    add(entry, { offset: entry.offset, tokLen: Buffer.byteLength(entry.name) });
  // A block-scope extern and its namespace definition are one binding.
  for (const [id, node] of nodes) {
    const entry = bindings.get(id);
    if (entry && node.loc && !node.isImplicit) add(entry, node.loc);
  }
  function references(node, captureInitializer = false) {
    if (node.kind === "DeclRefExpr") {
      const entry = bindings.get(node.referencedDecl?.id);
      const location = node.range?.end;
      // An implicit [&] or [=] capture has no identifier token to rename.
      const implicitCapture =
        captureInitializer &&
        location?.tokLen === 1 &&
        node.range.begin.offset === location.offset &&
        ["&", "="].includes(bytes.subarray(location.offset, location.offset + 1).toString());
      if (entry && !implicitCapture) add(entry, location);
    }
    for (const child of node.inner ?? []) {
      const capture =
        node.kind === "LambdaExpr"
          ? !["CXXRecordDecl", "CompoundStmt"].includes(child.kind)
          : captureInitializer;
      references(child, capture);
    }
  }
  for (const root of roots) references(root);
  return [...edits.values()].sort((a, b) => a.start - b.start);
}

/** Resolve selected current variable declarations and their compiler-bound uses.
 * Selection offsets address this exact live compiler view, not generation records.
 * Implicit lambda capture punctuation is not an editable identifier.
 */
export function variableBindingEdits(roots, selection, source) {
  return localEdits(roots, selection, source);
}
// Instantiations can bind one physical template token to parameters declared
// at different sites. Join only families connected by actual compiler-bound uses.
function coupledLocals(roots, selection, source) {
  const parents = new Map(selection.map((entry) => [entry.family, entry.family]));
  const order = new Map(selection.map((entry, index) => [entry.family, index]));
  function leader(family) {
    const parent = parents.get(family);
    if (parent === family) return family;
    const root = leader(parent);
    parents.set(family, root);
    return root;
  }
  localEdits(
    roots,
    selection.map((entry) => ({ ...entry, newName: entry.family })),
    source,
    (a, b) => {
      const first = leader(a),
        second = leader(b);
      if (first !== second)
        parents.set(
          order.get(first) < order.get(second) ? second : first,
          order.get(first) < order.get(second) ? first : second,
        );
    },
  );
  return selection.map((entry) => ({ ...entry, family: leader(entry.family) }));
}

function spliceTokens(source, edits, inverse = false) {
  const parts = [];
  let cursor = 0;
  for (const edit of edits) {
    const start = inverse ? edit.afterStart : edit.start;
    const old = inverse ? edit.new : edit.old;
    const replacement = inverse ? edit.old : edit.new;
    if (
      !Number.isInteger(start) ||
      start < cursor ||
      source.slice(start, start + old.length) !== old
    )
      throw new Error("Token edit does not match source");
    parts.push(source.slice(cursor, start), replacement);
    cursor = start + old.length;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function editRecord(tree, changed, category, selection, excluded, compilerEdits) {
  for (const name of Object.keys(tree)) {
    if (name !== "main.cpp" && changed[name] !== tree[name])
      throw new Error(`Compiler changed fixed source: ${name}`);
  }
  if (Object.keys(changed).length !== Object.keys(tree).length)
    throw new Error("Compiler changed the source file set");
  const before = tree["main.cpp"],
    after = changed["main.cpp"];
  const beforeTokens = cppTokens(before),
    afterTokens = cppTokens(after);
  if (beforeTokens.length !== afterTokens.length)
    throw new Error("Rename changed source token structure");
  const allowed = new Set(selection.map((entry) => `${entry.name}:${entry.newName}`));
  const edits = [];
  for (let index = 0; index < beforeTokens.length; index++) {
    const oldToken = beforeTokens[index],
      newToken = afterTokens[index];
    if (oldToken.text === newToken.text) continue;
    if (!identifier.test(oldToken.text) || !allowed.has(`${oldToken.text}:${newToken.text}`))
      throw new Error("Rename changed a protected or unselected token");
    edits.push({
      start: oldToken.start,
      afterStart: newToken.start,
      old: oldToken.text,
      new: newToken.text,
    });
  }
  const replay = spliceTokens(before, edits);
  if (replay !== after) throw new Error("Rename changed layout or non-identifier source");
  if (!edits.length) throw new Error(`No semantic rename edits for ${category}`);
  const bindings = new Map(compilerEdits.map((edit) => [edit.start, edit]));
  const families = new Set(selection.map((entry) => entry.family));
  for (const edit of edits) {
    const bound = bindings.get(edit.start);
    if (
      bound?.old !== edit.old ||
      bound?.new !== edit.new ||
      !bound.families?.length ||
      bound.families.some((family) => !families.has(family))
    )
      throw new Error("Rename lost physical binding ownership");
    edit.families = bound.families;
  }
  const byStart = new Map(edits.map((edit) => [edit.start, edit]));
  const bytes = Buffer.from(before);
  for (const entry of selection) {
    const offset = bytes.subarray(0, entry.offset).toString("utf8").length;
    if (byStart.get(offset)?.new !== entry.newName)
      throw new Error(`Selected declaration was not renamed: ${entry.name}`);
  }
  return {
    kind: "rename",
    category,
    vocabulary: vocabularyIdentity,
    variety: namingSummary(selection),
    counts: { declarations: selection.length, tokenEdits: edits.length, excluded: excluded.length },
    before: treeIdentity(tree),
    after: treeIdentity(changed),
    selection,
    excluded,
    edits,
  };
}

/** Rename supported project/vendor bindings in a disposable single-TU source copy. */
export async function renameCategory(tree, category, scratch) {
  if (!["functions-types", "fields", "locals-parameters"].includes(category))
    throw new Error(`Unknown rename category: ${category}`);
  await writeTree(scratch, tree);
  const sourcePath = path.resolve(scratch, "main.cpp");
  const flags = ["-std=c++17", "-pthread"];
  const compilerVersion = (await execFile("clang++", ["--version"], options)).stdout;
  if (!/clang version 18\./.test(compilerVersion))
    throw new Error("Semantic naming requires Clang 18");
  if (category !== "locals-parameters") {
    const version = (await execFile("clangd-18", ["--version"], options)).stdout;
    if (!/clangd version 18\./.test(version)) throw new Error("Semantic naming requires clangd 18");
  }
  const roots = await projectAst(sourcePath, flags);
  const { selection: eligible, excluded } = candidates(
    roots,
    Buffer.from(tree["main.cpp"]),
    sourcePath,
    category,
  );
  if (!eligible.length) throw new Error(`No eligible declarations for ${category}`);
  const used = new Set(
    cppTokens(tree["main.cpp"])
      .filter((token) => identifier.test(token.text))
      .map((token) => token.text),
  );
  const families =
    category === "locals-parameters" ? coupledLocals(roots, eligible, tree["main.cpp"]) : eligible;
  const selection = assignNames(families, used);
  const edits =
    category === "locals-parameters"
      ? localEdits(roots, selection, tree["main.cpp"])
      : await semanticEdits(sourcePath, tree["main.cpp"], selection, flags);
  const source = spliceTokens(tree["main.cpp"], edits);
  const changed = { ...tree, "main.cpp": source };
  await writeFile(sourcePath, source);
  await execFile("clang++", [...flags, "-fsyntax-only", sourcePath], options);
  const record = editRecord(tree, changed, category, selection, excluded, edits);
  return { tree: changed, record };
}

/** Reverse semantic token edits after checking exact input and output tree identities. */
export function undoNames(tree, record) {
  if (record.kind !== "rename" || treeIdentity(tree) !== record.after)
    throw new Error("Renamed tree identity does not match");
  const source = spliceTokens(tree["main.cpp"], record.edits, true);
  const restored = { ...tree, "main.cpp": source };
  if (treeIdentity(restored) !== record.before)
    throw new Error("Restored tree identity does not match");
  return restored;
}
