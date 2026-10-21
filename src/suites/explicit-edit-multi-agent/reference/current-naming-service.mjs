import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { scopedNamingSession, applyScopedNamePlan } from "../cpp/scoped-names.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { joinedProject } from "../cpp/joined-project.mjs";
import { cppStructure } from "../cpp/cpp-structure.mjs";

const execFile = promisify(execFileCallback);

const headerBindings = Symbol("current header local bindings");
const headerRoot = "__reference_header_bindings.cpp";
const headerPath = /^(?:[\w.-]+\/)*[\w.-]+\.h$/;
const headerTree = (tree) =>
  Object.fromEntries(Object.entries(tree).filter(([name]) => !name.endsWith(".cpp")));
const viewIdentity = (tree, file) =>
  treeIdentity(file === headerBindings ? headerTree(tree) : tree);
const headerLocalRequest = (task) =>
  task.operations.every(
    (operation) =>
      operation.category === "locals-parameters" &&
      operation.selectors?.length &&
      operation.selectors.every(
        (selector) =>
          selector.kind === "variable" && typeof selector.owner?.definition === "boolean",
      ),
  );

const plainTypeRequest = (task) =>
  task.operations.every(
    (operation) =>
      operation.category === "functions-types" &&
      operation.selectors?.length &&
      operation.selectors.every(
        (selector) =>
          selector.kind === "type" &&
          Object.keys(selector).every((key) => ["kind", "scope"].includes(key)),
      ),
  );

// Local type selectors additionally read their function owner. Reuse only when
// complete current ownership cannot depend on an earlier nominal type rename.
const unrelatedOwnedTypeRequest = (task, spellings) =>
  task.operations.every(
    (operation) =>
      operation.category === "functions-types" &&
      operation.selectors?.length &&
      operation.selectors.every(
        (selector) =>
          selector.kind === "type" &&
          typeof selector.scope === "string" &&
          typeof selector.owner?.scope === "string" &&
          selector.owner.scope.length > 0 &&
          selector.scope.startsWith(selector.owner.scope + "::") &&
          typeof selector.owner.signature === "string" &&
          selector.owner.signature.length > 0 &&
          selector.owner.definition === true &&
          !cppTokens(selector.scope + " " + selector.owner.signature).some((token) =>
            spellings.has(token.text),
          ),
      ),
  );
// A nominal type rename preserves unrelated function identities. Require complete
// owner selectors and reject either spelling wherever selection could read it.
const unrelatedFunctionRequest = (task, spellings) =>
  spellings.size > 0 &&
  task.operations.every(
    (operation) =>
      operation.category === "functions-types" &&
      operation.selectors?.length &&
      operation.mapping.every((item) => !spellings.has(item.from)) &&
      operation.selectors.every(
        (selector) =>
          selector.kind === "function" &&
          typeof selector.scope === "string" &&
          selector.scope.length > 0 &&
          selector.scope === selector.owner?.scope &&
          typeof selector.owner?.signature === "string" &&
          selector.owner.signature.length > 0 &&
          typeof selector.owner.definition === "boolean" &&
          !cppTokens(selector.scope + " " + selector.owner.signature).some((token) =>
            spellings.has(token.text),
          ),
      ),
  );
// Count only flat parameter lists and simple single-type template arguments.
// Nested declarators, defaults and templates containing commas stay unknown.
// This excludes incompatible candidates; it never proves a binding or a rename.
function simpleParameterCount(source) {
  const list = /^\s*\(([^()]*)\)/.exec(source)?.[1];
  if (list === undefined) return undefined;
  const flat = list.replace(
    /\b(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*\s*<\s*(?:const\s+)?(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*(?:\s*[*&])?\s*>/g,
    "TemplateType",
  );
  if (!/^[\s:,*&]*$/.test(flat.replace(/[A-Za-z_]\w*/g, ""))) return undefined;
  if (!flat.trim() || flat.trim() === "void") return 0;
  const parameters = flat.split(",");
  return parameters.every((parameter) => parameter.trim()) ? parameters.length : undefined;
}
// Use the unique physical function-definition candidate, not uniqueness of the
// variable's spelling across unrelated owners. This only chooses a compiler view:
// its AST must still prove the exact owner and a definition-local binding in that
// implementation. Alternate include contexts and manufactured spellings reject it.
function mayContainBinding(task, source) {
  if (!source) return true;
  let units;
  try {
    units = cppStructure(source, { expandNamespaceConditionals: true }).units;
  } catch {
    return true; // Unsupported preprocessed syntax cannot exclude a compiler candidate.
  }
  return task.operations.every((operation) => {
    const owner = operation.selectors[0].owner;
    const name = owner.scope.split("::").at(-1);
    const expectedCount = simpleParameterCount(owner.signature.slice(owner.signature.indexOf("(")));
    const from = operation.mapping[0].from;
    let found = false;
    for (const unit of units) {
      if (!unit.definition) continue;
      const text = source.slice(unit.start, unit.end);
      const header = text.slice(0, text.indexOf("{"));
      const candidates = cppTokens(header).filter(
        (token) => token.text === name && /^\s*\(/.test(header.slice(token.end)),
      );
      if (!candidates.length) continue;
      found = true;
      if (
        expectedCount !== undefined &&
        candidates.every((token) => {
          const count = simpleParameterCount(header.slice(token.end));
          return count !== undefined && count !== expectedCount;
        })
      )
        continue;
      if (cppTokens(text).some((token) => token.text === from)) return true;
    }
    return !found; // Missing owner coverage is unknown, not proof of absence.
  });
}
async function localTranslationUnit(tree, task, resolveOwners) {
  if (
    !task.operations.every((operation) => {
      const selector = operation.selectors?.[0];
      const from = operation.mapping?.[0]?.from;
      return (
        operation.category === "locals-parameters" &&
        operation.mapping?.length === 1 &&
        /^[A-Za-z_]\w*$/.test(from ?? "") &&
        operation.selectors?.length === 1 &&
        selector.kind === "variable" &&
        typeof selector.owner?.scope === "string" &&
        selector.owner.scope.length > 0 &&
        typeof selector.scope === "string" &&
        selector.scope.startsWith(selector.owner.scope + "::") &&
        selector.scope.endsWith("::" + from) &&
        typeof selector.owner.signature === "string" &&
        selector.owner.signature.length > 0 &&
        selector.owner.definition === true
      );
    })
  )
    return undefined;
  const owners = new Set(
    task.operations.map((operation) => operation.selectors[0].owner.scope.split("::").at(-1)),
  );
  if ([...owners].some((name) => !/^[A-Za-z_]\w*$/.test(name))) return undefined;
  const candidates = [];
  for (const [file, source] of Object.entries(tree)) {
    const joined = source.replace(/\\\r?\n/g, "");
    if (/\?\?[/=]/.test(joined)) return undefined;
    if (!file.endsWith(".cpp") || ![...owners].every((name) => joined.includes(name))) continue;
    let definitions;
    try {
      definitions = cppStructure(joined, { expandNamespaceConditionals: true }).units.filter(
        (unit) => unit.definition,
      );
    } catch {
      return undefined;
    }
    const found = new Set();
    for (const unit of definitions) {
      const text = joined.slice(unit.start, unit.end);
      const header = text.slice(0, text.indexOf("{"));
      for (const token of cppTokens(header))
        if (owners.has(token.text) && /^\s*\(/.test(header.slice(token.end))) found.add(token.text);
    }
    if (![...owners].every((name) => found.has(name))) continue;
    candidates.push(file);
  }
  if (!candidates.length) return undefined;
  if (candidates.length === 1)
    return standaloneTranslationUnit(tree, candidates[0]) ? candidates[0] : undefined;
  return resolveOwners(tree, task, candidates);
}
function standaloneTranslationUnit(tree, selected) {
  for (const [file, source] of Object.entries(tree)) {
    const joined = source.replace(/\\\r?\n/g, "");
    if (/\?\?[/=]/.test(joined) || /^[ \t]*(?:#|%:)[ \t]*(?:line\b|\d)/m.test(joined)) return false;
    for (const include of includeDirectives(joined)) {
      const relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), include.file),
      );
      const target = [relative, include.file, "support/" + include.file].find(
        (name) => typeof tree[name] === "string",
      );
      if (target === selected) return false;
    }
  }
  return !/##|%:%:/.test(joinedProject(tree, [selected]).source.replace(/\\\r?\n/g, ""));
}
async function confinedVariableTranslationUnit(tree, task, externalUse) {
  if (
    !task.operations.every(
      (operation) =>
        operation.category === "locals-parameters" &&
        operation.mapping?.length === 1 &&
        /^[A-Za-z_]\w*$/.test(operation.mapping[0].from) &&
        operation.selectors?.length &&
        operation.selectors.every((selector) => selector.kind === "variable"),
    )
  )
    return undefined;
  const names = task.operations.map((operation) => operation.mapping[0].from);
  const spelling = new RegExp(`\\b(?:${names.join("|")})\\b`);
  const sources = Object.entries(tree).map(([file, source]) => [
    file,
    source.replace(/\\\r?\n/g, ""),
  ]);
  const files = sources.filter(([, source]) => spelling.test(source)).map(([file]) => file);
  if (files.length !== 1 || !files[0].endsWith(".cpp")) return undefined;
  const selected = files[0];
  if (!standaloneTranslationUnit(tree, selected)) return undefined;
  // Raw spelling closure is insufficient when another TU can manufacture a name.
  // Preprocessing retains its actual includes/macros without requiring unrelated
  // function bodies to be semantically valid during a concurrent move.
  if (await externalUse(tree, selected, spelling)) return undefined;
  return selected;
}
async function implementationHeaderContext(tree, spelling, readActiveMacros) {
  const relevant = new Set();
  const external = new Set();
  const visit = (file, selected) => {
    if (selected.has(file) || (selected === external && relevant.has(file))) return;
    selected.add(file);
    for (const include of includeDirectives(tree[file])) {
      const relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), include.file),
      );
      const target = [relative, include.file, "support/" + include.file].find(
        (name) => typeof tree[name] === "string",
      );
      if (target) visit(target, selected);
    }
  };
  for (const [file, source] of Object.entries(tree))
    if (headerPath.test(file) && spelling.test(source)) visit(file, relevant);
  for (const file of Object.keys(tree)) if (file.endsWith(".cpp")) visit(file, external);
  const names = new Set(
    [...relevant].flatMap((file) => cppTokens(tree[file]).map((token) => token.text)),
  );
  const candidates = new Set();
  for (const file of external) {
    const joined = tree[file].replace(/\\\r?\n/g, "");
    let clean = joined;
    if (joined.includes("/*") || joined.includes("//")) {
      const comments = cppTokens(joined).filter(
        (token) => token.text.startsWith("/*") || token.text.startsWith("//"),
      );
      for (const token of comments.reverse())
        clean =
          clean.slice(0, token.start) +
          token.text.replace(/[^\r\n]/g, " ") +
          clean.slice(token.end);
    }
    for (const macro of clean.matchAll(/^[ \t]*#[ \t]*(?:define|undef)[ \t]+([A-Za-z_]\w*)/gm))
      if (names.has(macro[1])) candidates.add(macro[1]);
  }
  if (!candidates.size) return false;
  const active = await readActiveMacros(tree);
  return [...candidates].some((name) => active.has(name));
}
async function headerRequest(tree, task, readActiveMacros) {
  if (headerLocalRequest(task)) return true;
  if (
    !task.operations.every(
      (operation) =>
        ["functions-types", "fields"].includes(operation.category) &&
        operation.selectors?.length &&
        operation.selectors.every((selector) =>
          operation.category === "fields"
            ? selector.kind === "record"
            : ["function", "type", "record"].includes(selector.kind),
        ),
    )
  )
    return false;
  const names = task.operations.flatMap((operation) => operation.mapping.map((item) => item.from));
  if (names.some((name) => !/^[A-Za-z_]\w*$/.test(name))) return false;
  const spelling = new RegExp(`\\b(?:${names.join("|")})\\b`);
  const closed = Object.entries(tree)
    .filter(([name]) => name.endsWith(".cpp"))
    .every(([, source]) => {
      const joined = source.replace(/\\\r?\n/g, "");
      return !/##|%:%:|\?\?[/=]/.test(joined) && !spelling.test(joined);
    });
  return closed && !(await implementationHeaderContext(tree, spelling, readActiveMacros));
}

/** Retain only compiler work generated from actually delivered public requests.
 * This reference-only cache never reads preparation plans, contracts or answers.
 * A snapshot is reusable only while committed reference plans exactly explain the
 * current source. Pending plans are cached for a rejected CAS, not acknowledged.
 * Structural/unknown mutations, helper-view changes and affected type selectors
 * invalidate reuse. Separate-TU fallback is deliberately disposable. No candidate mount may
 * contain this cache: run it inside the isolated reference service namespace.
 * Fully definition-owned locals with one physical implementation owner candidate
 * may compile that actual translation unit and its includes. Token pasting in
 * that view, project trigraph ambiguity, a repeated implementation owner or an
 * include of that implementation rejects this optimization. Complete source
 * identity, current owner/signature selection and errors in that TU still apply.
 * Nested lambda/operator scopes may sit below that enclosing function owner;
 * their complete nested scope and owner signature are still matched by the AST.
 * Same-spelling implementation candidates are disambiguated by actual compiler
 * owner scope/signature. Only known acknowledged local renames retain that proof;
 * repeated physical owners and unknown input reopen or reject the selection.
 * Before body compilation, actual preprocessing may exclude an implementation
 * whose same-spelling definition units cannot contain the requested variable.
 * Generated spellings remain visible. Missing owner coverage, explicit line
 * directives and unsupported syntax require ordinary AST proof, not exclusion.
 * A variable binding may also use one implementation when every literal spelling
 * is confined to that standalone TU. Multiple block-scope extern owners and its
 * namespace declaration remain compiler-selected together. Every other TU is
 * actually preprocessed; generated uses and alternate implementation includes
 * reject the view. Text is cached only for identical complete TU input.
 * Selected includes and owner signatures still compile; no declarations are added.
 * An already valid complete-project snapshot takes priority over a narrower
 * local view; unexplained whole-source changes still invalidate that reuse.
 * Other owned-variable requests first compile the current headers alone, since
 * unrelated implementation moves can temporarily leave other translation units
 * unbuildable. Other semantic requests may use that view only when no
 * source spelling occurs in implementation text after line splicing; token
 * pasting and trigraph ambiguity reject this optimization. Headers containing
 * selected spellings and their include dependencies also retain implementation
 * macro context: an active external define/undef affecting their tokens forces
 * full-project analysis, even when no selected spelling appears in a .cpp file.
 * Clang preprocessing of actual source distinguishes active directives from
 * dormant platform branches; its one retained result is bound to complete bytes.
 * The check repeats before pending-plan reuse. Compiler selection and candidate
 * gates remain the authority, not this conservative view-selection test.
 * The private root adds includes only, never declarations or saved
 * answers. Missing header selections use ordinary current-project analysis;
 * header compiler errors remain errors. Header views exclude implementation
 * files and are reusable only for identical non-implementation input bytes;
 * including an implementation file is unsupported rather than hidden from that
 * identity. A rejected header-view CAS may reuse the same current plan when
 * those inputs are unchanged, merging it onto fresh implementation bytes; the
 * next commit and acknowledgement still require a matching whole-source snapshot.
 * Full-project views keep their original complete-source identity. Type
 * declarations with plain scope selectors, or local types with complete function
 * owners unaffected by earlier type spellings, can retain compiler binding IDs
 * across independent type renames in either view. Unknown input still reopens the
 * compiler. A function with complete owner selectors can also reuse the view
 * when neither its scope nor signature reads either spelling of an accepted type
 * rename. Missing owner metadata, affected signatures/scopes and requests using
 * an earlier destination spelling reopen the actual current compiler source.
 * Candidate gates and full builds are unchanged; this view is never used for
 * preparation certification. An optional readCurrent callback rechecks the
 * whole source after compiler failure. A changed snapshot returns undefined for
 * a caller-owned retry of the same delivery, never acceptance; unchanged compiler
 * failures and all other errors still propagate. It grants no deadline reset.
 */
export function currentNamingPlanner(directory, { signal } = {}) {
  let state,
    pending,
    analysisDirectory,
    stopped = false;
  const statistics = { snapshotAttempts: 0, cacheHits: 0, pendingHits: 0, fallbacks: 0 };
  const invalidate = () => {
    state?.session.close();
    state = undefined;
    pending = undefined;
  };
  const check = () => {
    signal?.throwIfAborted();
    if (stopped) throw Error("Reference naming planner closed");
  };
  let macroState;
  const readActiveMacros = async (tree) => {
    const identity = treeIdentity(tree);
    if (macroState?.identity === identity) return macroState.active;
    check();
    await mkdir(directory, { recursive: true });
    const sourcePath = path.resolve(directory, "context.cpp");
    await writeFile(sourcePath, joinedProject(tree).source);
    const { stdout } = await execFile(
      "clang++",
      ["-std=c++17", "-pthread", "-E", "-dD", sourcePath],
      {
        timeout: 45_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    const active = new Set(
      [...stdout.matchAll(/^[ \t]*#[ \t]*(?:define|undef)[ \t]+([A-Za-z_]\w*)/gm)].map(
        (match) => match[1],
      ),
    );
    macroState = { identity, active };
    return active;
  };
  const externalViews = new Map();
  const preprocessedTU = async (tree, file) => {
    check();
    const source = joinedProject(tree, [file]).source;
    const identity = treeIdentity({ [file]: source });
    let view = externalViews.get(file);
    if (view?.identity !== identity) {
      await mkdir(directory, { recursive: true });
      const sourcePath = path.resolve(directory, "external.cpp");
      await writeFile(sourcePath, source);
      const { stdout } = await execFile(
        "clang++",
        ["-std=c++17", "-pthread", "-E", "-dD", sourcePath],
        { timeout: 45_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      );
      let inProject = false;
      const project = [];
      for (const line of stdout.split("\n")) {
        const marker = /^#\s+\d+\s+"([^"]+)"/.exec(line);
        if (marker) inProject = marker[1] === sourcePath;
        else if (inProject) project.push(line);
      }
      const explicitLines = /^[ \t]*(?:#|%:)[ \t]*(?:line\b|\d)/m.test(
        source.replace(/\\\r?\n/g, ""),
      );
      view = { identity, source: stdout, project: explicitLines ? undefined : project.join("\n") };
      externalViews.set(file, view);
    }
    return view;
  };
  const externalUse = async (tree, selected, spelling) => {
    for (const file of Object.keys(tree).filter(
      (name) => name.endsWith(".cpp") && name !== selected,
    ))
      if (spelling.test((await preprocessedTU(tree, file)).source)) return true;
    return false;
  };
  let ownerIdentity;
  let ownerSnapshot = 0;
  const ownerMatches = new Map();
  const resolveOwners = async (tree, task, candidates) => {
    const identity = treeIdentity(tree);
    if (ownerIdentity !== identity) {
      ownerMatches.clear();
      ownerIdentity = identity;
    }
    const owners = task.operations.map((operation) => operation.selectors[0].owner);
    const matches = [];
    for (const file of candidates) {
      check();
      const view = await preprocessedTU(tree, file);
      if (!mayContainBinding(task, view.project)) continue;
      if (!standaloneTranslationUnit(tree, file)) return undefined;
      const key = JSON.stringify({ file, owners });
      let proof = ownerMatches.get(key);
      if (!proof) {
        const analysis = path.join(directory, `owner-${++ownerSnapshot}`);
        await mkdir(analysis, { recursive: true });
        let session;
        try {
          session = await scopedNamingSession(tree, analysis, { file });
          proof = {
            matches: owners.every((owner) => session.hasDefinitionOwner(owner)),
            names: new Set(
              owners.flatMap((owner) =>
                cppTokens(owner.scope + " " + owner.signature).map((token) => token.text),
              ),
            ),
          };
          ownerMatches.set(key, proof);
        } finally {
          session?.close();
          await rm(analysis, { recursive: true, force: true });
        }
      }
      if (proof.matches) matches.push(file);
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
  const open = async (tree, file, allowAbsentOwners = false) => {
    check();
    if (analysisDirectory) await rm(analysisDirectory, { recursive: true, force: true });
    const analysis = path.join(directory, `snapshot-${++statistics.snapshotAttempts}`);
    analysisDirectory = analysis;
    await mkdir(analysis, { recursive: true });
    let current = tree;
    if (file === headerBindings) {
      assert.ok(!(headerRoot in tree), "Reserved reference header root already exists");
      const headers = Object.keys(tree).filter((name) => headerPath.test(name));
      current = {
        ...headerTree(tree),
        [headerRoot]: headers
          .sort()
          .map((name) => `#include "${name}"\n`)
          .join(""),
      };
      file = headerRoot;
    }
    return scopedNamingSession(current, analysis, {
      file,
      allowAbsentOwners,
      onSelection: (origins) => {
        if (state) state.types ||= origins.some((origin) => origin.role === "type");
      },
    });
  };
  const fresh = async (before, file) => {
    invalidate();
    const session = await open(before, file);
    state = {
      session,
      file,
      expected: viewIdentity(before, file),
      applied: [],
      types: false,
      typeDestinations: new Set(),
      typeSpellings: new Set(),
    };
  };
  const separate = async (before, task) => {
    const merged = task.operations.map(() => new Map());
    for (const file of Object.keys(before)
      .filter((name) => name.endsWith(".cpp"))
      .sort()) {
      const session = await open(before, file, true);
      try {
        for (const [index, operation] of task.operations.entries()) {
          const plan = await session.plan(operation);
          for (const edit of plan.edits) {
            const key = JSON.stringify([edit.file, edit.start]);
            const previous = merged[index].get(key);
            if (previous && (previous.old !== edit.old || previous.new !== edit.new))
              throw Error("Conflicting translation-unit binding edit");
            merged[index].set(key, edit);
          }
        }
      } finally {
        session.close();
      }
    }
    const plans = task.operations.map((operation, index) => {
      const edits = [...merged[index].values()];
      for (const mapping of operation.mapping)
        if (!edits.some((edit) => edit.old === mapping.from && edit.new === mapping.to))
          throw Error(`Missing current owner/signature binding: ${mapping.from}`);
      return { id: operation.id ?? operation.target, edits };
    });
    let after = before;
    const applied = [];
    for (const plan of plans) {
      after = applyScopedNamePlan(after, plan, applied);
      applied.push(plan);
    }
    return after;
  };
  return {
    async plan(before, task, readCurrent) {
      try {
        check();
        assert.ok(
          task.operations?.length &&
            task.operations.every((operation) => operation.phase === "names"),
          "Reference service accepts current naming tasks only",
        );
        const key = JSON.stringify(task);
        const identity = treeIdentity(before);
        if (pending?.key === key) {
          if (pending.before === identity) {
            statistics.pendingHits++;
            return { after: pending.after, statistics: { ...statistics } };
          }
          if (
            pending.headerBefore &&
            (await headerRequest(before, task, readActiveMacros)) &&
            pending.headerBefore === viewIdentity(before, headerBindings)
          ) {
            // The failed whole-source CAS changed only files this compiler view
            // cannot read. Keep its one consumed plan, not the stale peer bytes.
            pending.before = identity;
            pending.after = { ...before, ...headerTree(pending.after) };
            statistics.pendingHits++;
            return { after: pending.after, statistics: { ...statistics } };
          }
        }
        if (pending) invalidate();
        const separateCurrent = async () => {
          invalidate();
          statistics.fallbacks++;
          const after = await separate(before, task);
          check();
          pending = { key, before: identity, after, disposable: true };
          return { after, statistics: { ...statistics } };
        };
        // An explained full view already covers semantic requests. Choose it
        // before probing a narrower view: that probe may itself run Clang's
        // preprocessor. Unknown source still takes the complete selection path,
        // and the type/owner guards below still decide whether reuse is valid.
        const explainedFullView = state && state.file === undefined && state.expected === identity;
        const localFile =
          !explainedFullView && task.operations[0].category !== "helpers"
            ? await localTranslationUnit(before, task, resolveOwners)
            : undefined;
        const file =
          task.operations[0].category === "helpers"
            ? task.operations[0].file
            : explainedFullView
              ? undefined
              : (localFile ??
                (await confinedVariableTranslationUnit(before, task, externalUse)) ??
                (Object.keys(before).some((name) => headerPath.test(name)) &&
                (await headerRequest(before, task, readActiveMacros))
                  ? headerBindings
                  : undefined));
        const localDefinitionOnly = Boolean(localFile);
        const retainedTypes =
          plainTypeRequest(task) ||
          unrelatedOwnedTypeRequest(task, state?.typeSpellings ?? new Set());
        let reused = Boolean(
          state &&
          state.file === file &&
          state.expected === viewIdentity(before, file) &&
          (!state.types ||
            unrelatedFunctionRequest(task, state.typeSpellings) ||
            (retainedTypes &&
              task.operations.every((operation) =>
                operation.mapping.every((item) => !state.typeDestinations.has(item.from)),
              ))),
        );
        if (!reused) {
          try {
            await fresh(before, file);
          } catch (error) {
            invalidate();
            if (file || !error.message.startsWith("Compiler AST failed:")) throw error;
            return await separateCurrent();
          }
        }
        let plans;
        try {
          plans = [];
          for (const operation of task.operations)
            plans.push(await state.session.plan(operation, { localDefinitionOnly }));
        } catch (error) {
          // The indexed public selector may have become stale after a known scope
          // or written signature rename. Reopen the ACTUAL source, never translate
          // a selector by broad text replacement or fall back to saved answers.
          if (!reused && file !== headerBindings) {
            invalidate();
            throw error;
          }
          try {
            await fresh(before, file === headerBindings ? undefined : file);
          } catch (freshError) {
            invalidate();
            if (file !== headerBindings || !freshError.message.startsWith("Compiler AST failed:"))
              throw freshError;
            return await separateCurrent();
          }
          reused = false;
          try {
            plans = [];
            for (const operation of task.operations)
              plans.push(await state.session.plan(operation, { localDefinitionOnly }));
          } catch (freshError) {
            invalidate();
            throw freshError;
          }
        }
        check();
        let after = before;
        const applied = [...state.applied];
        for (const plan of plans) {
          after = applyScopedNamePlan(after, plan, applied);
          applied.push(plan);
        }
        if (reused) statistics.cacheHits++;
        pending = {
          key,
          before: identity,
          after,
          plans,
          types: state.types,
          localDefinitionOnly,
          changedNames: task.operations.flatMap((operation) =>
            operation.mapping.flatMap((item) => [item.from, item.to]),
          ),
          unrelatedTypes: unrelatedFunctionRequest(task, state.typeSpellings),
          ...(state.file === headerBindings ? { headerBefore: state.expected } : {}),
          ...(retainedTypes
            ? {
                typeDestinations: task.operations.flatMap((operation) =>
                  operation.mapping.map((item) => item.to),
                ),
                typeSpellings: task.operations.flatMap((operation) =>
                  operation.mapping.flatMap((item) => [item.from, item.to]),
                ),
              }
            : {}),
        };
        return { after, statistics: { ...statistics } };
      } catch (error) {
        if (
          !readCurrent ||
          !error.message.startsWith("Compiler AST failed:") ||
          treeIdentity(await readCurrent()) === treeIdentity(before)
        )
          throw error;
        // Like a rejected CAS, failure on an obsolete snapshot cannot decide
        // the current delivery. Replan actual bytes; unchanged errors still fail.
        return undefined;
      }
    },
    acknowledge(before, after) {
      check();
      assert.ok(
        pending &&
          pending.before === treeIdentity(before) &&
          treeIdentity(pending.after) === treeIdentity(after),
        "CAS acknowledgement differs from pending naming transaction",
      );
      const accepted = pending;
      if (accepted.localDefinitionOnly && ownerIdentity === accepted.before) {
        for (const [key, proof] of ownerMatches)
          if (accepted.changedNames.some((name) => proof.names.has(name))) ownerMatches.delete(key);
        ownerIdentity = treeIdentity(after);
      } else {
        ownerIdentity = undefined;
        ownerMatches.clear();
      }
      pending = undefined;
      if (
        accepted.disposable ||
        (accepted.types && !accepted.typeDestinations && !accepted.unrelatedTypes)
      ) {
        invalidate();
        return;
      }
      state.applied.push(...accepted.plans);
      for (const name of accepted.typeDestinations ?? []) state.typeDestinations.add(name);
      for (const name of accepted.typeSpellings ?? []) state.typeSpellings.add(name);
      state.expected = viewIdentity(after, state.file);
    },
    close() {
      stopped = true;
      invalidate();
      macroState = undefined;
      externalViews.clear();
      ownerMatches.clear();
    },
  };
}
