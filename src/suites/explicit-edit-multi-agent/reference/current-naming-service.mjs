import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { scopedNamingSession, applyScopedNamePlan } from "../cpp/scoped-names.mjs";
import { treeIdentity } from "../generation/generator.mjs";

/** Retain only compiler work generated from actually delivered public requests.
 * This reference-only cache never reads preparation plans, contracts or answers.
 * A snapshot is reusable only while committed reference plans exactly explain the
 * current source. Pending plans are cached for a rejected CAS, not acknowledged.
 * Structural/unknown mutations, helper-view changes and type renames invalidate
 * reuse. Separate-TU fallback is deliberately disposable. No candidate mount may
 * contain this cache: run it inside the isolated reference service namespace.
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
    return scopedNamingSession(tree, analysis, {
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
    state = { session, file, expected: treeIdentity(before), applied: [], types: false };
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
      if (pending?.key === key && pending.before === identity) {
        statistics.pendingHits++;
        return { after: pending.after, statistics: { ...statistics } };
      }
      if (pending) invalidate();
      const file = task.operations[0].category === "helpers" ? task.operations[0].file : undefined;
      let reused = Boolean(state && state.expected === identity && state.file === file);
      if (!reused) {
        try {
          await fresh(before, file);
        } catch (error) {
          invalidate();
          if (file || !error.message.startsWith("Compiler AST failed:")) throw error;
          statistics.fallbacks++;
          const after = await separate(before, task);
          check();
          pending = { key, before: identity, after, disposable: true };
          return { after, statistics: { ...statistics } };
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
        if (!reused) {
          invalidate();
          throw error;
        }
        await fresh(before, file);
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
      pending = { key, before: identity, after, plans, types: state.types };
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
      if (accepted.disposable || accepted.types) {
        invalidate();
        return;
      }
      state.applied.push(...accepted.plans);
      state.expected = treeIdentity(after);
    },
    close() {
      stopped = true;
      invalidate();
    },
  };
}
