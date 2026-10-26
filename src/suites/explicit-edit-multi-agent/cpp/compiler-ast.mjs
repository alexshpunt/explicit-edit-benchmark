import { spawn } from "node:child_process";
import path from "node:path";

/** Index written function signatures, not substituted template instantiation copies.
 * A forward template declaration can emit instantiated definitions before the primary
 * definition. Both copies use the primary's physical token, regardless of AST order.
 */
export function writtenFunctionSignatures(roots) {
  const signatures = new Map();
  const kinds = new Set([
    "FunctionDecl",
    "CXXMethodDecl",
    "CXXConstructorDecl",
    "CXXDestructorDecl",
  ]);
  function visit(node) {
    if (kinds.has(node.kind)) {
      if ((node.inner ?? []).some((child) => child.kind === "TemplateArgument")) return;
      if (!node.isImplicit && Number.isInteger(node.loc?.offset) && node.type?.qualType) {
        const previous = signatures.get(node.loc.offset);
        if (previous && previous !== node.type.qualType)
          throw Error("Conflicting written function signatures");
        signatures.set(node.loc.offset, node.type.qualType);
      }
    }
    for (const child of node.inner ?? []) visit(child);
  }
  for (const root of roots) visit(root);
  return signatures;
}
/** Identify substituted function copies whose physical tokens belong to a written template. */
export function isFunctionInstantiation(node, signatures) {
  return (
    signatures.has(node.loc?.offset) &&
    (node.inner ?? []).some((child) => child.kind === "TemplateArgument")
  );
}
/** Resolve typedef names that give anonymous C/C++ records a public binding owner. */
export function anonymousRecordAliases(roots) {
  const nodes = new Map(),
    aliases = new Map();
  function collect(node) {
    if (node.id) nodes.set(node.id, node);
    for (const child of node.inner ?? []) collect(child);
  }
  for (const root of roots) collect(root);
  function tags(node, alias) {
    const id = node.ownedTagDecl?.id ?? (node.kind === "RecordType" ? node.decl?.id : undefined);
    const record = nodes.get(id);
    if (record && !record.name && ["RecordDecl", "CXXRecordDecl"].includes(record.kind))
      aliases.set(id, alias);
    for (const child of node.inner ?? []) tags(child, alias);
  }
  for (const node of nodes.values())
    if (["TypedefDecl", "TypeAliasDecl"].includes(node.kind) && node.name) tags(node, node);
  return aliases;
}

/** Index semantic declaration contexts, including the class owner of out-of-line methods.
 * Context nodes retain physical identities so earlier type renames can change owner labels
 * without changing unrelated classes or falling back to a method spelling.
 */
export function declarationContexts(roots, aliases = anonymousRecordAliases(roots)) {
  const nodes = new Map(),
    parents = new Map(),
    contexts = new Map(),
    active = new Set();
  const kinds = new Set([
    "NamespaceDecl",
    "CXXRecordDecl",
    "ClassTemplateSpecializationDecl",
    "RecordDecl",
    "EnumDecl",
    "TypedefDecl",
    "TypeAliasDecl",
    "FunctionDecl",
    "CXXMethodDecl",
    "CXXConstructorDecl",
    "CXXDestructorDecl",
  ]);
  function index(node, ancestors = []) {
    if (node.id) {
      nodes.set(node.id, node);
      parents.set(node.id, ancestors);
    }
    const named = aliases.get(node.id) ?? node;
    const nested =
      named.name && kinds.has(node.kind) && !node.isImplicit ? [...ancestors, named] : ancestors;
    for (const child of node.inner ?? []) index(child, nested);
  }
  for (const root of roots) index(root);
  function resolve(id) {
    if (contexts.has(id)) return contexts.get(id);
    const node = nodes.get(id);
    if (!node) throw Error("Missing compiler declaration context");
    if (active.has(id)) throw Error("Cyclic compiler declaration context");
    active.add(id);
    const ancestors = node.parentDeclContextId
      ? resolve(node.parentDeclContextId)
      : parents.get(id);
    const named = aliases.get(id) ?? node;
    const context =
      named.name && kinds.has(node.kind) && !node.isImplicit ? [...ancestors, named] : ancestors;
    contexts.set(id, context);
    active.delete(id);
    return context;
  }
  for (const node of nodes.values())
    if (node.parentDeclContextId) resolve(node.parentDeclContextId);
  return contexts;
}
/** Read project AST roots while streaming. Keep system namespace identities without
 * their bodies, so project specializations retain their real semantic namespace owners.
 * recoverSourceErrors is only for located editing repairs; it still requires a
 * complete JSON tree and never turns compiler diagnostics into acceptance.
 */
export async function projectAst(sourcePath, flags, { recoverSourceErrors = false } = {}) {
  const child = spawn(
    "clang++",
    [
      ...flags,
      ...(recoverSourceErrors ? ["-ferror-limit=0"] : []),
      "-fsyntax-only",
      "-Xclang",
      "-ast-dump=json",
      sourcePath,
    ],
    {
      env: { ...process.env, LC_ALL: "C" },
    },
  );
  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            Object.assign(new Error(`Compiler AST failed: ${stderr}`), {
              compilerSourceFailure:
                code === 1 &&
                !signal &&
                /(?:^|\n)[^\n]+:\d+:\d+:\s*(?:fatal )?error:/.test(stderr) &&
                !/^(?:(?:\S*[\\/])?(?:clang[^\s:]*|LLVM|LLD):\s*(?:fatal )?error:|LLVM ERROR:|PLEASE submit a bug report|Stack dump:|fatal error: error in backend:)/m.test(
                  stderr,
                ),
              compilerExitCode: code,
              compilerSignal: signal,
            }),
          ),
    );
  });
  // Attach a handler before streaming so early compiler failures are not unhandled.
  completed.catch(() => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  const roots = [],
    namespaceContexts = [];
  let depth = 0,
    quoted = false,
    escaped = false,
    active = false;
  let parts = [];
  let body = "",
    headerKnown = false,
    keep = false,
    file = "";
  function inspectHeader(header) {
    const location = header.loc?.spellingLoc ?? header.loc;
    const nextFile = location?.file ?? file;
    const keep =
      !!header.kind && !location?.includedFrom && path.resolve(nextFile || ".") === sourcePath;
    if (!keep && header.kind === "NamespaceDecl" && header.name)
      namespaceContexts.push({ id: header.id, kind: header.kind, name: header.name });
    return { file: nextFile, keep };
  }
  try {
    for await (const chunk of child.stdout) {
      // Retain complete chunk slices once the small root header is known.
      // Appending each character of a large namespace creates millions of
      // transient string nodes before JSON.parse can read the same bytes.
      const text = chunk.toString("utf8");
      const punctuation = /["\\{}:]/g;
      let partStart = 0,
        headerStart = 0;
      if (escaped && text.length) {
        escaped = false;
        punctuation.lastIndex = 1;
      }
      for (let match; (match = punctuation.exec(text));) {
        const index = match.index;
        const character = match[0];
        if (!quoted && character === "{" && depth === 1) {
          active = true;
          body = "";
          parts = [];
          headerStart = index;
          headerKnown = false;
          keep = false;
        }
        if (active && !headerKnown) {
          body += text.slice(headerStart, index + 1);
          headerStart = index + 1;
        }
        if (quoted) {
          if (character === "\\") {
            if (index + 1 < text.length) punctuation.lastIndex = index + 2;
            else escaped = true;
          } else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "{") depth++;
        else if (character === "}") {
          depth--;
          if (active && depth === 1) {
            if (!headerKnown) ({ file, keep } = inspectHeader(JSON.parse(body)));
            if (keep) {
              if (headerKnown) {
                parts.push(text.slice(partStart, index + 1));
                roots.push(JSON.parse(parts.join("")));
              } else roots.push(JSON.parse(body));
            }
            active = false;
            body = "";
            parts = [];
          }
        }
        if (active && !headerKnown && !quoted && depth === 2 && character === ":") {
          const match = /,\s*"inner"\s*:$/.exec(body);
          if (match) {
            ({ file, keep } = inspectHeader(JSON.parse(body.slice(0, match.index) + "}")));
            headerKnown = true;
            if (keep) {
              parts.push(body);
              partStart = index + 1;
            }
            body = "";
          }
        }
      }
      if (active && !headerKnown) body += text.slice(headerStart);
      if (active && headerKnown && keep) parts.push(text.slice(partStart));
    }
    try {
      await completed;
    } catch (error) {
      // A located repair can inspect the compiler's complete recovery tree.
      // Signals, driver/backend failures and truncated JSON are never usable.
      if (!recoverSourceErrors || !error.compilerSourceFailure) throw error;
    }
    if (depth || quoted || active) throw new Error("Incomplete compiler AST");
    return [...roots, ...namespaceContexts];
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
