import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  scopedNamingSession,
  applyScopedNamePlan,
  hasCurrentNamingBinding,
} from "../cpp/scoped-names.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { joinedProject } from "../cpp/joined-project.mjs";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { implementationResolutionNeeded, locateImplementation } from "./implementation-edit.mjs";

const execFile = promisify(execFileCallback);

// A correction can reach an executor that never saw the original turn. Select
// the public destination spelling through the compiler before choosing a no-op.
function destinationRequest(operation) {
  const names = new Map(operation.mapping.map(({ from, to }) => [from, to]));
  const spelling = (value) => {
    let result = value;
    for (const token of cppTokens(value).reverse())
      if (names.has(token.text))
        result = result.slice(0, token.start) + names.get(token.text) + result.slice(token.end);
    return result;
  };
  const selector = (value) => ({
    ...value,
    ...(value.scope ? { scope: spelling(value.scope) } : {}),
    ...(value.signature ? { signature: spelling(value.signature) } : {}),
    ...(value.owner ? { owner: selector(value.owner) } : {}),
  });
  return {
    ...operation,
    mapping: operation.mapping.map(({ from, to }) => ({ from: to, to: from })),
    ...(operation.selectors ? { selectors: operation.selectors.map(selector) } : {}),
  };
}
function bindingProbes(operation) {
  const selectors = operation.selectors?.length
    ? operation.selectors.map((selector) => [selector])
    : [undefined];
  return operation.mapping.map((mapping) =>
    selectors.map((selected) => ({ ...operation, mapping: [mapping], selectors: selected })),
  );
}
const missingBinding = (error) =>
  error.message.startsWith("Missing current owner/signature binding:");
const headerBindings = Symbol("current header local bindings");
const headerRoot = "__reference_header_bindings.cpp";
const headerPath = /^(?:[\w.-]+\/)*[\w.-]+\.h$/;
const headerTree = (tree) =>
  Object.fromEntries(Object.entries(tree).filter(([name]) => !name.endsWith(".cpp")));
const viewIdentity = (tree, file) => {
  if (file === headerBindings) return treeIdentity(headerTree(tree));
  if (file === undefined) return treeIdentity(tree);
  const { source, spans } = joinedProject(tree, [file]);
  return treeIdentity({ source, origins: JSON.stringify(spans) });
};
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
function mayContainBinding(task, view) {
  if (!view.project) return true;
  if (view.units === undefined) {
    try {
      view.units = cppStructure(view.project, { expandNamespaceConditionals: true })
        .units.filter((unit) => unit.definition)
        .map((unit) => {
          const text = view.project.slice(unit.start, unit.end);
          const header = text.slice(0, text.indexOf("{"));
          return {
            calls: cppTokens(header)
              .filter((token) => /^\s*\(/.test(header.slice(token.end)))
              .map((token) => ({
                name: token.text,
                count: simpleParameterCount(header.slice(token.end)),
              })),
            names: new Set(cppTokens(text).map((token) => token.text)),
          };
        });
    } catch {
      view.units = null; // Unsupported syntax cannot exclude a compiler candidate.
    }
  }
  if (!view.units) return true;
  return task.operations.every((operation) => {
    const owner = operation.selectors[0].owner;
    const name = owner.scope.split("::").at(-1);
    const expectedCount = simpleParameterCount(owner.signature.slice(owner.signature.indexOf("(")));
    const from = operation.mapping[0].from;
    let found = false;
    for (const unit of view.units) {
      const candidates = unit.calls.filter((call) => call.name === name);
      if (!candidates.length) continue;
      found = true;
      if (
        expectedCount !== undefined &&
        candidates.every((call) => call.count !== undefined && call.count !== expectedCount)
      )
        continue;
      if (unit.names.has(from)) return true;
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
 * Up to three compiler sessions are retained in least-recently-used order, each
 * with separate source files and consumed-plan history. Switching views does not
 * discard an acknowledged session whose actual inputs and physical origins are
 * unchanged. Accepted edits advance unaffected views; changed inputs evict them.
 * An unexplained whole-source change drops implementation/full-project sessions.
 * Header-only reuse retains the existing closed-header input/context checks.
 * A snapshot is reusable only while committed reference plans exactly explain the
 * current source. Pending plans remain local until the caller records its edit.
 * Structural/unknown mutations, changed helper inputs and affected type selectors
 * invalidate reuse. Separate-TU fallback is deliberately disposable. No candidate mount may
 * contain this cache: it belongs to this executor's private namespace.
 * Fully definition-owned locals with one physical implementation owner candidate
 * may compile that actual translation unit and its includes. Token pasting in
 * that view, project trigraph ambiguity, a repeated implementation owner or an
 * include of that implementation rejects this optimization. Complete source
 * identity, current owner/signature selection and errors in that TU still apply.
 * Nested lambda/operator scopes may sit below that enclosing function owner;
 * their complete nested scope and owner signature are still matched by the AST.
 * Same-spelling implementation candidates are disambiguated by exact compiler
 * binding queries on retained current views, without consuming the rename or
 * rerunning preprocessing first. Absent/changed views use actual preprocessing
 * and compilation. Owner/signature reads affected by accepted names, or a request
 * using an earlier destination, reopen current source. Repeated physical owners
 * and unknown input still reopen or reject selection. Preprocessor inventories
 * are parsed once per exact TU input, never advanced over changed source.
 * A successfully compiled .cpp candidate that lacks the requested owner/binding
 * does not exclude a header-defined overload. Such selection misses try actual
 * headers; an absent header binding preserves the original selection error.
 * Selected implementation and header compiler errors still fail.
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
 * identity. A retried header plan can be reused when those inputs are unchanged,
 * keeping fresh implementation bytes. Recording a planned edit advances only
 * this private cache; it never guards or accepts a filesystem publication.
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
export function currentNamingPlanner(directory, { signal, maxViews = 3 } = {}) {
  assert.ok(
    Number.isSafeInteger(maxViews) && maxViews > 0 && maxViews <= 3,
    "Invalid private compiler-view budget",
  );
  let state,
    pending,
    stopped = false;
  const views = new Map();
  const discarded = new Set();
  const statistics = { snapshotAttempts: 0, cacheHits: 0, pendingHits: 0, fallbacks: 0 };
  const retire = (view) => {
    view.session.close();
    views.delete(view.file);
    discarded.add(view.analysis);
    if (state === view) state = undefined;
    globalThis.gc?.();
  };
  const invalidate = () => {
    if (state) retire(state);
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
  // Plain declaration summaries retain no ASTs and are reusable only for the
  // identical actual translation unit, including its current includes/origins.
  const bindingViews = new Map();
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
  const resolveOwners = async (tree, task, candidates) => {
    const reads = new Set(
      task.operations.flatMap((operation) =>
        cppTokens(
          operation.selectors[0].owner.scope + " " + operation.selectors[0].owner.signature,
        ).map((token) => token.text),
      ),
    );
    const from = new Set(
      task.operations.flatMap((operation) => operation.mapping.map((item) => item.from)),
    );
    const matches = [];
    for (const file of candidates) {
      check();
      let cached = views.get(file);
      const changedSelector = cached?.applied.some((plan) =>
        plan.edits.some((edit) => reads.has(edit.old) || reads.has(edit.new) || from.has(edit.new)),
      );
      let guarded = false;
      if (!cached || !reusable(cached, tree, task) || changedSelector) {
        const view = await preprocessedTU(tree, file);
        if (!mayContainBinding(task, view)) continue;
        if (!standaloneTranslationUnit(tree, file)) return undefined;
        guarded = true;
        await fresh(tree, file);
        cached = state;
      }
      if (task.operations.every((operation) => cached.session.hasLocalBinding(operation))) {
        if (!guarded && !standaloneTranslationUnit(tree, file)) return undefined;
        matches.push(file);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
  const open = async (tree, file, allowAbsentOwners = false, repairOnly = false) => {
    check();
    for (const analysis of discarded) {
      await rm(analysis, { recursive: true, force: true });
      discarded.delete(analysis);
    }
    const analysis = path.join(directory, `snapshot-${++statistics.snapshotAttempts}`);
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
    try {
      const session = await scopedNamingSession(current, analysis, {
        file,
        allowAbsentOwners,
        repairOnly,
        onSelection: (origins) => {
          if (state) state.types ||= origins.some((origin) => origin.role === "type");
        },
      });
      return { session, analysis };
    } catch (error) {
      discarded.add(analysis);
      throw error;
    }
  };
  const fresh = async (before, file) => {
    const previous = views.get(file);
    if (previous) retire(previous);
    state = undefined;
    pending = undefined;
    // Retire before opening, not afterwards: a replacement AST/server must not
    // temporarily exceed this actor's retained-view budget.
    while (views.size >= maxViews) retire(views.values().next().value);
    const opened = await open(before, file);
    state = {
      ...opened,
      file,
      createdAt: statistics.snapshotAttempts,
      expected: viewIdentity(before, file),
      wholeExpected: treeIdentity(before),
      applied: [],
      types: false,
      typeDestinations: new Set(),
      typeSpellings: new Set(),
    };
    views.set(file, state);
  };
  const reusable = (cached, before, task) => {
    const retainedTypes =
      plainTypeRequest(task) || unrelatedOwnedTypeRequest(task, cached.typeSpellings);
    return (
      cached.expected === viewIdentity(before, cached.file) &&
      (!cached.types ||
        unrelatedFunctionRequest(task, cached.typeSpellings) ||
        (retainedTypes &&
          task.operations.every((operation) =>
            operation.mapping.every((item) => !cached.typeDestinations.has(item.from)),
          )))
    );
  };
  const activate = async (before, task, file) => {
    const cached = views.get(file);
    if (cached && reusable(cached, before, task)) {
      state = cached;
      views.delete(file);
      views.set(file, cached);
      return true;
    }
    await fresh(before, file);
    return false;
  };
  const implementationBindings = async (tree, file) => {
    const identity = viewIdentity(tree, file);
    const cached = bindingViews.get(file);
    if (cached?.identity === identity) {
      statistics.cacheHits++;
      return cached.bindings;
    }
    // Summaries contain no compiler objects. Release retained ASTs before a
    // disposable structural lookup so this actor's view budget stays bounded.
    for (const view of views.values()) retire(view);
    pending = undefined;
    bindingViews.delete(file);
    const { session, analysis } = await open(tree, file, true);
    try {
      const bindings = session.bindings();
      bindingViews.set(file, { identity, bindings });
      return bindings;
    } finally {
      session.close();
      discarded.add(analysis);
    }
  };
  const actualFiles = (tree) =>
    Object.keys(tree)
      .filter((name) => name.endsWith(".cpp"))
      .sort();
  const cachedDestinations = (before, task) => {
    const files = actualFiles(before);
    if (!files.length) return false;
    const bindings = [];
    for (const file of files) {
      const view = bindingViews.get(file);
      if (!view || view.identity !== viewIdentity(before, file)) return false;
      bindings.push(view.bindings);
    }
    return task.operations.every(
      (operation) =>
        !bindings.some((entries) =>
          hasCurrentNamingBinding(entries, operation, { complete: false }),
        ) &&
        bindingProbes(destinationRequest(operation))
          .flat()
          .every((probe) => bindings.some((entries) => hasCurrentNamingBinding(entries, probe))),
    );
  };
  const separate = async (before, task) => {
    const merged = task.operations.map(() => new Map());
    const originals = task.operations.map((operation) => operation.mapping.map(() => false));
    const probes = task.operations.map((operation) => bindingProbes(destinationRequest(operation)));
    const covered = probes.map((mappings) =>
      mappings.map((selectors) => selectors.map(() => false)),
    );
    const recordDestinations = (query) => {
      for (const [index, mappings] of probes.entries())
        for (const [mapping, selectors] of mappings.entries())
          for (const [selector, probe] of selectors.entries())
            covered[index][mapping][selector] ||= query(probe);
    };
    for (const file of actualFiles(before)) {
      const identity = viewIdentity(before, file);
      let view = bindingViews.get(file);
      let opened;
      try {
        if (!view || view.identity !== identity) {
          bindingViews.delete(file);
          opened = await open(before, file, true);
          view = { identity, bindings: opened.session.bindings() };
          bindingViews.set(file, view);
        }
        recordDestinations((probe) => hasCurrentNamingBinding(view.bindings, probe));
        let hasOriginal = false;
        for (const [index, operation] of task.operations.entries())
          for (const [mapping, entry] of operation.mapping.entries()) {
            const present = hasCurrentNamingBinding(
              view.bindings,
              { ...operation, mapping: [entry] },
              { complete: false },
            );
            originals[index][mapping] ||= present;
            hasOriginal ||= present;
          }
        if (!hasOriginal) continue;
        opened ??= await open(before, file, true);
        for (const [index, operation] of task.operations.entries()) {
          if (operation.category === "helpers" && operation.file !== file) continue;
          // Earlier requests can advance owner scopes in this private session.
          // Query its current compiler ledger before planning the next operation.
          for (const [mapping, selectors] of probes[index].entries())
            for (const [selector, probe] of selectors.entries())
              covered[index][mapping][selector] ||= opened.session.hasBinding(probe);
          for (const [mapping, entry] of operation.mapping.entries())
            originals[index][mapping] ||= opened.session.hasBinding(
              { ...operation, mapping: [entry] },
              { complete: false },
            );
          const plan = await opened.session.plan(operation);
          for (const edit of plan.edits) {
            const key = JSON.stringify([edit.file, edit.start]);
            const previous = merged[index].get(key);
            if (previous && (previous.old !== edit.old || previous.new !== edit.new))
              throw Error("Conflicting translation-unit binding edit");
            merged[index].set(key, edit);
          }
        }
      } finally {
        if (opened) {
          opened.session.close();
          discarded.add(opened.analysis);
        }
      }
    }
    const plans = task.operations.map((operation, index) => {
      const edits = [...merged[index].values()];
      for (const [mappingIndex, mapping] of operation.mapping.entries())
        if (
          !edits.some((edit) => edit.old === mapping.from && edit.new === mapping.to) &&
          (originals[index][mappingIndex] || !covered[index][mappingIndex].every(Boolean))
        )
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
    async currentBindings(tree, file) {
      check();
      if (typeof file !== "string" || !file.endsWith(".cpp") || !Object.hasOwn(tree, file))
        throw Object.assign(Error("Current compiler context is absent"), { repairConflict: true });
      return implementationBindings(tree, file);
    },
    /** Resolve a stale physical declarator through this actor's current compiler.
     * Public function identity excludes parameter names; no old body is replayed.
     */
    async implementation(before, request) {
      check();
      if (!implementationResolutionNeeded(before, request)) return undefined;
      const targets = request.targets.map(() => ({}));
      for (const [file, slot] of [
        ["main.cpp", "source"],
        [request.file, "destination"],
      ]) {
        const source = before[file];
        if (typeof source !== "string") continue;
        const structure = cppStructure(source);
        let bindings;
        for (const [index, target] of request.targets.entries()) {
          const { occurrence: _occurrence, ...moved } = target.selector;
          const selector = slot === "source" ? target.selector : moved;
          const exact = locateImplementation(source, selector, structure, { allowMissing: true });
          if (exact) {
            targets[index][slot] = exact;
            continue;
          }
          if (selector.kind !== "function" || !selector.name || !selector.signature) continue;
          const possible = structure.units.filter(
            (unit) =>
              (unit.scope || "::") === selector.scope &&
              unit.definition === selector.definition &&
              unitDeclarator(source, unit).includes(selector.name),
          );
          if (!possible.length) continue;
          bindings ??= await implementationBindings(before, file);
          const qualified = [selector.scope === "::" ? "" : selector.scope, selector.name]
            .filter(Boolean)
            .join("::");
          const owners = new Map(
            bindings
              .filter(
                (entry) =>
                  entry.file === file &&
                  entry.role === "function" &&
                  entry.scope === qualified &&
                  entry.owner?.scope === qualified &&
                  entry.owner.signature === selector.signature &&
                  entry.owner.definition === selector.definition,
              )
              .map((entry) => [entry.start, entry]),
          );
          if (owners.size > 1) throw Error("Ambiguous current compiler implementation owner");
          const matches = possible.filter((unit) =>
            [...owners.keys()].some((start) => unit.start <= start && start < unit.end),
          );
          if (matches.length > 1 || (owners.size && matches.length !== 1))
            throw Error("Missing or ambiguous physical compiler implementation owner");
          if (matches.length) targets[index][slot] = matches[0];
        }
      }
      return {
        before: treeIdentity(before),
        request: JSON.stringify(request),
        targets,
        statistics: { ...statistics },
      };
    },
    /** Plan a fresh problem at a current declaration, not an old task selector. */
    async repair(before, operation) {
      check();
      const { target, required } = operation;
      const conflict = () =>
        Object.assign(Error("Current repair declaration changed"), { repairConflict: true });
      const selectionFailure = (error) => {
        if (
          /^(?:Missing current owner\/signature binding:|Binding already changed by an earlier request|Unsupported local reference:|Empty current naming request|No semantic edits for |Rename crosses fixed source boundary:)/.test(
            error.message,
          )
        )
          error.repairConflict = true;
        return error;
      };
      if (
        operation.phase !== "repair" ||
        operation.action !== "rename-binding" ||
        !target ||
        !Object.hasOwn(before, target.file) ||
        !/^[A-Za-z_]\w*$/.test(required?.name ?? "") ||
        !Number.isSafeInteger(target.identifier) ||
        target.identifier < 0
      )
        throw conflict();
      const token = cppTokens(before[target.file])
        .filter((item) => /^[A-Za-z_]\w*$/.test(item.text))
        .at(target.identifier);
      if (!token || ![target.name, required.name].includes(token.text)) throw conflict();
      const files = actualFiles(before);
      const context = files.includes(target.translationUnit)
        ? target.translationUnit
        : files.includes(target.file)
          ? target.file
          : files[0];
      if (!context) throw conflict();
      const local =
        target.role === "variable" &&
        (files.length === 1 ||
          (target.owner?.scope && target.scope?.startsWith(target.owner.scope + "::")));
      const file = local || operation.category === "helpers" ? context : undefined;
      const key = JSON.stringify(operation);
      const identity = treeIdentity(before);
      try {
        if (pending) invalidate();
        const cached = [...views.values()].find(
          (view) =>
            !view.types &&
            (view.file === file || (view.file === undefined && files.length === 1)) &&
            view.expected === viewIdentity(before, view.file),
        );
        if (cached) {
          state = cached;
          views.delete(cached.file);
          views.set(cached.file, cached);
          statistics.cacheHits++;
        } else await fresh(before, file);
        const plan = await state.session.planRepair(operation, before);
        const after = plan.edits.length ? applyScopedNamePlan(before, plan, state.applied) : before;
        pending = {
          key,
          before: identity,
          after,
          plans: plan.edits.length ? [plan] : [],
          ...(target.role === "type" ? { types: true } : {}),
        };
        return { after, statistics: { ...statistics } };
      } catch (error) {
        invalidate();
        if (
          error.compilerSourceFailure &&
          (["field", "function"].includes(target.role) ||
            (target.role === "variable" && !target.owner))
        ) {
          // A partially renamed declaration can make its users ill-formed.
          // Inspect each actual TU independently, never a synthetic merged
          // error tree, and merge only this physical declaration's uses.
          const contexts =
            file === undefined
              ? [context, ...files.filter((candidate) => candidate !== context)]
              : [file];
          const edits = new Map();
          let found = false;
          for (const currentFile of contexts) {
            if (
              !joinedProject(before, [currentFile]).spans.some((span) => span.file === target.file)
            )
              continue;
            const { session, analysis } = await open(before, currentFile, false, true);
            try {
              let plan;
              try {
                plan = await session.planRepair(operation, before);
              } catch (failure) {
                // An enabled declaration in the primary actual TU is required.
                // Other TUs may not enable the same macro-controlled declaration.
                if (found && failure.repairAbsent) continue;
                throw selectionFailure(failure);
              }
              found = true;
              for (const edit of plan.edits) {
                const site = JSON.stringify([edit.file, edit.start]);
                const previous = edits.get(site);
                if (previous && (previous.old !== edit.old || previous.new !== edit.new))
                  throw conflict();
                edits.set(site, edit);
              }
            } finally {
              session.close();
              discarded.add(analysis);
            }
          }
          if (!found) throw conflict();
          const plan = { id: operation.id, edits: [...edits.values()] };
          const after = plan.edits.length ? applyScopedNamePlan(before, plan) : before;
          pending = { key, before: identity, after, disposable: true };
          return { after, statistics: { ...statistics } };
        }
        if (
          (!error.compilerSourceFailure && !error.repairConflict) ||
          file !== undefined ||
          files.length < 2
        )
          throw selectionFailure(error);
        // Some independent implementation files cannot share one compiler TU.
        // Resolve this current point in its real context, then use the existing
        // separate-TU merger for the same compiler-proven semantic binding.
        const bindings = await implementationBindings(before, context);
        const matches = bindings.filter(
          (entry) =>
            entry.file === target.file && entry.start === token.start && entry.role === target.role,
        );
        const unique = [...new Map(matches.map((entry) => [entry.start, entry])).values()];
        if (unique.length !== 1) throw conflict();
        const entry = unique[0];
        if (token.text === required.name) {
          pending = { key, before: identity, after: before, disposable: true };
          return { after: before, statistics: { ...statistics } };
        }
        if (
          entry.owner?.scope &&
          entry.scope.startsWith(entry.owner.scope + "::") &&
          entry.role === "variable"
        ) {
          await fresh(before, context);
          const plan = await state.session.planRepair(operation, before);
          const after = applyScopedNamePlan(before, plan);
          pending = { key, before: identity, after, plans: [plan] };
          return { after, statistics: { ...statistics } };
        }
        const category =
          operation.category ??
          (entry.role === "variable"
            ? "locals-parameters"
            : entry.role === "field"
              ? "fields"
              : "functions-types");
        const selector =
          entry.role === "field"
            ? { kind: "record", scope: entry.declaringScope }
            : {
                kind: entry.role,
                scope: entry.scope,
                ...(entry.owner
                  ? {
                      owner:
                        entry.role === "function"
                          ? { scope: entry.owner.scope, signature: entry.owner.signature }
                          : entry.owner,
                    }
                  : {}),
              };
        return this.plan(before, {
          id: operation.id,
          operations: [
            {
              id: operation.id,
              phase: "names",
              category,
              ...(category === "helpers" ? { file: target.file } : {}),
              mapping: [{ from: entry.name, to: required.name }],
              selectors: [selector],
            },
          ],
        }).catch((error) => {
          throw selectionFailure(error);
        });
      }
    },
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
        const snapshotStart = statistics.snapshotAttempts;
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
            // The intervening source change affected only files this compiler view
            // cannot read. Keep its one consumed plan, not the stale peer bytes.
            pending.before = identity;
            pending.after = { ...before, ...headerTree(pending.after) };
            statistics.pendingHits++;
            return { after: pending.after, statistics: { ...statistics } };
          }
        }
        if (pending) invalidate();
        for (const view of views.values())
          if (view.file !== headerBindings && view.wholeExpected !== identity) retire(view);
        const separateCurrent = async () => {
          invalidate();
          statistics.fallbacks++;
          const after = await separate(before, task);
          check();
          pending = { key, before: identity, after, disposable: true };
          return { after, statistics: { ...statistics } };
        };
        if (cachedDestinations(before, task)) {
          invalidate();
          statistics.cacheHits++;
          pending = { key, before: identity, after: before, disposable: true };
          return { after: before, statistics: { ...statistics } };
        }
        // An explained full view already covers semantic requests. Choose it
        // before probing a narrower view: that probe may itself run Clang's
        // preprocessor. Unknown source still takes the complete selection path,
        // and the type/owner guards below still decide whether reuse is valid.
        const fullView = views.get(undefined);
        const explainedFullView = fullView && fullView.expected === identity;
        const localFile =
          !explainedFullView && task.operations[0].category !== "helpers"
            ? await localTranslationUnit(before, task, resolveOwners)
            : undefined;
        let file =
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
        let localDefinitionOnly = Boolean(localFile);
        let reused;
        try {
          reused = await activate(before, task, file);
          reused &&= state.createdAt <= snapshotStart;
        } catch (error) {
          invalidate();
          if (file || !error.message.startsWith("Compiler AST failed:")) throw error;
          return await separateCurrent();
        }
        const retainedTypes =
          plainTypeRequest(task) || unrelatedOwnedTypeRequest(task, state.typeSpellings);
        const selectPlans = async () => {
          const selected = [];
          for (const operation of task.operations)
            selected.push(await state.session.plan(operation, { localDefinitionOnly }));
          return selected;
        };
        let plans;
        try {
          plans = await selectPlans();
        } catch (error) {
          if (
            missingBinding(error) &&
            (actualFiles(before).length === 0 ||
              (actualFiles(before).length === 1 &&
                (file === undefined || file === actualFiles(before)[0]))) &&
            task.operations.every(
              (operation) =>
                !state.session.hasBinding(operation, { complete: false }) &&
                state.session.hasBinding(destinationRequest(operation)),
            )
          ) {
            pending = { key, before: identity, after: before, plans: [] };
            return { after: before, statistics: { ...statistics } };
          }
          if (
            localDefinitionOnly &&
            (error.message.startsWith("Missing current owner/signature binding:") ||
              error.message.startsWith("Unsupported local reference")) &&
            Object.keys(before).some((name) => headerPath.test(name))
          ) {
            // A physical .cpp name candidate may be another overload, while the
            // requested definition lives in a header. Its successful compilation
            // does not prove that the requested binding belongs to that view.
            // Only an exact actual-header compiler plan can recover this miss.
            invalidate();
            file = headerBindings;
            localDefinitionOnly = false;
            try {
              reused = await activate(before, task, file);
              reused &&= state.createdAt <= snapshotStart;
              plans = await selectPlans();
            } catch (headerError) {
              invalidate();
              if (missingBinding(headerError)) return await separateCurrent();
              throw headerError;
            }
          }
          if (!plans) {
            // Reopen the ACTUAL source after a missed cached/header selector.
            // Never translate selectors or fall back to saved reference answers.
            if (!reused && file !== headerBindings) {
              invalidate();
              if (missingBinding(error)) return await separateCurrent();
              throw error;
            }
            invalidate();
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
              plans = await selectPlans();
            } catch (freshError) {
              invalidate();
              if (missingBinding(freshError)) return await separateCurrent();
              throw freshError;
            }
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
        // A compiler failure on an obsolete snapshot cannot decide
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
        "Recorded edit differs from pending naming plan",
      );
      const accepted = pending;
      pending = undefined;
      const afterIdentity = treeIdentity(after);
      for (const view of views.values()) {
        if (view === state) continue;
        if (
          (view.wholeExpected === accepted.before || view.file === headerBindings) &&
          view.expected === viewIdentity(after, view.file)
        )
          view.wholeExpected = afterIdentity;
        else retire(view);
      }
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
      state.wholeExpected = afterIdentity;
    },
    close() {
      stopped = true;
      invalidate();
      for (const view of views.values()) retire(view);
      macroState = undefined;
      externalViews.clear();
      bindingViews.clear();
    },
  };
}
