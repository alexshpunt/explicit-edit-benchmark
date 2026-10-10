import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";

// This read-only inspector is mounted separately from the candidate sources.
async function roots(source) {
  const child = spawn("clang++", [
    "-std=c++17",
    "-pthread",
    "-fsyntax-only",
    "-Xclang",
    "-ast-dump=json",
    source,
  ]);
  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-65536);
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr || `Clang exited ${code}`)),
    );
  });
  completed.catch(() => {});
  const result = [];
  let depth = 0,
    quoted = false,
    escaped = false,
    active = false;
  let body = "",
    headerKnown = false,
    keep = false,
    file = "";
  function header(text) {
    const value = JSON.parse(text);
    const location = value.loc?.spellingLoc ?? value.loc;
    const nextFile = location?.file ?? file;
    return { file: nextFile, keep: nextFile.startsWith("/workspace/") };
  }
  for await (const chunk of child.stdout) {
    for (const character of chunk) {
      if (!quoted && character === "{" && depth === 1) {
        active = true;
        body = "";
        headerKnown = false;
        keep = false;
      }
      if (active && (!headerKnown || keep)) body += character;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}") {
        depth--;
        if (active && depth === 1) {
          if (!headerKnown) ({ file, keep } = header(body));
          if (keep) result.push({ node: JSON.parse(body), file });
          active = false;
          body = "";
        }
      }
      if (active && !headerKnown && !quoted && depth === 2 && character === ":") {
        const match = /,\s*"inner"\s*:$/.exec(body);
        if (match) {
          ({ file, keep } = header(body.slice(0, match.index) + "}"));
          headerKnown = true;
          if (!keep) body = "";
        }
      }
    }
  }
  await completed;
  if (depth || quoted || active) throw new Error("Incomplete compiler AST");
  return result;
}

// Clang prints lambda types with file/line coordinates. Those change on extraction.
// Keep distinct lexical lambdas, but label them by their owning signature and order.
function lambdaTypes(input) {
  const groups = new Map();
  function visit(node, scope, inherited, owner) {
    const location = node.loc?.spellingLoc ?? node.loc;
    const file = location?.file ?? inherited;
    const nextScope =
      node.name &&
      ["NamespaceDecl", "CXXRecordDecl", "RecordDecl", "FunctionDecl", "CXXMethodDecl"].includes(
        node.kind,
      )
        ? [scope, node.name].filter(Boolean).join("::")
        : scope;
    if (node.kind === "FunctionDecl" || (node.kind === "CXXMethodDecl" && !owner)) {
      const id = `${file}:${location?.offset}`;
      const pattern = !(node.inner ?? []).some((child) => child.kind === "TemplateArgument");
      const signature = (node.type?.qualType ?? "").replace(/\(lambda at [^)]+\)/g, "(lambda)");
      if (!groups.has(id))
        groups.set(id, { label: `${nextScope}:${signature}`, pattern, lambdas: new Map() });
      else if (pattern && !groups.get(id).pattern)
        Object.assign(groups.get(id), { label: `${nextScope}:${signature}`, pattern });
      owner = id;
    }
    if (node.kind === "LambdaExpr" && node.type?.qualType) {
      const begin = node.range?.begin?.spellingLoc ?? node.range?.begin;
      const id = owner ?? `${file}:${scope}`;
      if (!groups.has(id)) groups.set(id, { label: scope, lambdas: new Map() });
      const lambdas = groups.get(id).lambdas;
      if (!lambdas.has(begin.offset)) lambdas.set(begin.offset, new Set());
      lambdas.get(begin.offset).add(node.type.qualType);
    }
    let currentFile = file;
    for (const child of node.inner ?? []) {
      const childLocation = child.loc?.spellingLoc ?? child.loc;
      currentFile = childLocation?.file ?? currentFile;
      visit(child, nextScope, currentFile, owner);
    }
  }
  for (const { node, file } of input) visit(node, "", file);
  const labels = new Map();
  for (const group of groups.values()) {
    const lambdas = [...group.lambdas].sort(([a], [b]) => a - b);
    for (const [index, [, spellings]] of lambdas.entries()) {
      const label = `(lambda in ${group.label}#${index})`;
      for (const spelling of spellings) {
        if (labels.has(spelling) && labels.get(spelling) !== label)
          throw new Error("Ambiguous lexical lambda identity");
        labels.set(spelling, label);
      }
    }
  }
  return (type) =>
    type?.replace(/\(lambda at [^)]+\)/g, (spelling) => {
      if (!labels.has(spelling) && spelling.includes("/workspace/"))
        throw new Error("Missing lexical lambda identity");
      return labels.get(spelling) ?? spelling;
    });
}

function summarize(input) {
  const normalizeType = lambdaTypes(input);
  const declarations = [];
  const members = new Map();
  function index(node) {
    if (node.id && node.name) members.set(node.id, node.name);
    for (const inner of node.inner ?? []) index(inner);
  }
  for (const { node } of input) index(node);
  function shape(node) {
    return [
      node.kind,
      node.opcode ?? null,
      node.value ?? null,
      node.referencedDecl?.name ??
        (node.referencedMemberDecl
          ? (members.get(node.referencedMemberDecl) ?? node.name)
          : null) ??
        null,
      (node.inner ?? []).map(shape),
    ];
  }
  function variables(node, result = []) {
    if (["ParmVarDecl", "VarDecl"].includes(node.kind) && node.name) result.push(node.name);
    for (const inner of node.inner ?? []) variables(inner, result);
    return result;
  }
  function visit(node, scope, inherited, ownerType) {
    const location = node.loc?.spellingLoc ?? node.loc;
    const file = location?.file ?? inherited;
    const body = node.inner?.find((item) => item.kind === "CompoundStmt");
    if (
      node.name &&
      node.kind?.endsWith("Decl") &&
      !node.isImplicit &&
      file?.startsWith("/workspace/")
    ) {
      declarations.push({
        kind: node.kind,
        name: node.name,
        scope,
        file: file.slice("/workspace/".length),
        offset: location?.offset,
        type: normalizeType(node.type?.qualType),
        ownerType: normalizeType(ownerType),
        ...(node.kind === "FunctionDecl"
          ? {
              definition: !!body,
              parameters: (node.inner ?? [])
                .filter((item) => item.kind === "ParmVarDecl")
                .map((item) => item.name ?? ""),
              locals: variables(node),
              ...(body ? { body: shape(body) } : {}),
            }
          : {}),
      });
    }
    const nextScope =
      [
        "NamespaceDecl",
        "CXXRecordDecl",
        "RecordDecl",
        "EnumDecl",
        "FunctionDecl",
        "CXXMethodDecl",
      ].includes(node.kind) && node.name
        ? [scope, node.name].filter(Boolean).join("::")
        : scope;
    let currentFile = file;
    for (const inner of node.inner ?? []) {
      const childLocation = inner.loc?.spellingLoc ?? inner.loc;
      currentFile = childLocation?.file ?? currentFile;
      visit(
        inner,
        nextScope,
        currentFile,
        ["FunctionDecl", "CXXMethodDecl"].includes(node.kind) ? node.type?.qualType : ownerType,
      );
    }
  }
  for (const { node, file } of input) visit(node, "", file);
  return declarations;
}

try {
  const files = (await readdir("/workspace")).filter((file) => file.endsWith(".cpp")).sort();
  const entries = new Map();
  for (const file of files) {
    for (const declaration of summarize(await roots(`/workspace/${file}`))) {
      const key = JSON.stringify([
        declaration.file,
        declaration.offset,
        declaration.kind,
        declaration.name,
        declaration.scope,
        declaration.type,
        declaration.ownerType,
      ]);
      if (!entries.has(key)) entries.set(key, declaration);
    }
  }
  process.stdout.write(JSON.stringify([...entries.values()]));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
