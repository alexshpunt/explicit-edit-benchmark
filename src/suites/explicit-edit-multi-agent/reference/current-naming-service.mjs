import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { scopedNamingSession, applyScopedNamePlan } from "../cpp/scoped-names.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { joinedProject } from "../cpp/joined-project.mjs";

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
 * Owned-variable requests first compile the current headers alone, since
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
        let file =
          task.operations[0].category === "helpers"
            ? task.operations[0].file
            : Object.keys(before).some((name) => headerPath.test(name)) &&
                (await headerRequest(before, task, readActiveMacros))
              ? headerBindings
              : undefined;
        if (
          file === headerBindings &&
          state &&
          state.file === undefined &&
          state.expected === identity
        )
          file = undefined;
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
          for (const operation of task.operations) plans.push(await state.session.plan(operation));
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
              plans.push(await state.session.plan(operation));
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
    },
  };
}
