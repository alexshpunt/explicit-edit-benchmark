import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { scopedNamingSession, applyScopedNamePlan } from "../cpp/scoped-names.mjs";
import { treeIdentity } from "../generation/generator.mjs";

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

function headerRequest(tree, task) {
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
  return Object.entries(tree)
    .filter(([name]) => name.endsWith(".cpp"))
    .every(([, source]) => {
      const joined = source.replace(/\\\r?\n/g, "");
      return !/##|%:%:|\?\?[/=]/.test(joined) && !spelling.test(joined);
    });
}

/** Retain only compiler work generated from actually delivered public requests.
 * This reference-only cache never reads preparation plans, contracts or answers.
 * A snapshot is reusable only while committed reference plans exactly explain the
 * current source. Pending plans are cached for a rejected CAS, not acknowledged.
 * Structural/unknown mutations, helper-view changes and type renames invalidate
 * reuse. Separate-TU fallback is deliberately disposable. No candidate mount may
 * contain this cache: run it inside the isolated reference service namespace.
 * Owned-variable requests first compile the current headers alone, since
 * unrelated implementation moves can temporarily leave other translation units
 * unbuildable. Other semantic requests may use that view only when no
 * source spelling occurs in implementation text after line splicing; token
 * pasting and trigraph ambiguity reject this optimization. The check is repeated
 * before pending-plan reuse. Compiler selection and candidate gates remain the
 * authority, not this conservative view-selection test.
 * The private root adds includes only, never declarations or saved
 * answers. Missing header selections use ordinary current-project analysis;
 * header compiler errors remain errors. Header views exclude implementation
 * files and are reusable only for identical non-implementation input bytes;
 * including an implementation file is unsupported rather than hidden from that
 * identity. A rejected header-view CAS may reuse the same current plan when
 * those inputs are unchanged, merging it onto fresh implementation bytes; the
 * next commit and acknowledgement still require a matching whole-source snapshot.
 * Full-project views keep their original complete-source identity. Header-only
 * type declarations with plain scope selectors can retain compiler binding IDs
 * across independent type renames. Any signature/owner consumer or request using
 * an earlier destination spelling reopens the actual current compiler source.
 * Candidate gates and full builds are unchanged; this view is never used for
 * preparation certification.
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
    async plan(before, task) {
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
          headerRequest(before, task) &&
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
          : Object.keys(before).some((name) => headerPath.test(name)) && headerRequest(before, task)
            ? headerBindings
            : undefined;
      if (
        file === headerBindings &&
        state &&
        state.file === undefined &&
        state.expected === identity
      )
        file = undefined;
      const plainTypes = plainTypeRequest(task);
      let reused = Boolean(
        state &&
        state.file === file &&
        state.expected === viewIdentity(before, file) &&
        (!state.types ||
          (file === headerBindings &&
            plainTypes &&
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
          return separateCurrent();
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
          return separateCurrent();
        }
        reused = false;
        try {
          plans = [];
          for (const operation of task.operations) plans.push(await state.session.plan(operation));
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
        ...(state.file === headerBindings ? { headerBefore: state.expected } : {}),
        ...(state.file === headerBindings && plainTypes
          ? {
              typeDestinations: task.operations.flatMap((operation) =>
                operation.mapping.map((item) => item.to),
              ),
            }
          : {}),
      };
      return { after, statistics: { ...statistics } };
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
      if (accepted.disposable || (accepted.types && !accepted.typeDestinations)) {
        invalidate();
        return;
      }
      state.applied.push(...accepted.plans);
      for (const name of accepted.typeDestinations ?? []) state.typeDestinations.add(name);
      state.expected = viewIdentity(after, state.file);
    },
    close() {
      stopped = true;
      invalidate();
    },
  };
}
