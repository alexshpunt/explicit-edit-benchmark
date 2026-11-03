import assert from "node:assert/strict";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { ambiguityAnchorsProse } from "./ambiguity-anchors.mjs";

/** Add snapshot-bound unique contexts without changing a sealed historical plan. */
export function isolatedAnchors(plan) {
  const source = plan.initial["main.cpp"];
  const structure = cppStructure(source);
  const candidates = [
    ...structure.units,
    ...structure.directives.map((item) => ({ ...item, kind: "directive" })),
  ];
  const hints = new Map();
  const tasks = plan.tasks.map((task) => {
    if (task.kind !== "implementation") return task;
    const entries = [];
    const fragments = task.fragments.map((fragment) => {
      if (fragment.beforeFragment || fragment.afterFragment) return fragment;
      const matches = candidates.filter(
        (item) =>
          item.kind === fragment.kind &&
          item.scope === fragment.scope &&
          source.slice(item.start, item.end).trim() === fragment.text.trim(),
      );
      if (matches.length < 2) return fragment;
      assert.equal(source.slice(fragment.start, fragment.end), fragment.text);
      let radius = 1,
        left,
        right,
        context;
      do {
        left = Math.max(0, fragment.start - radius);
        left = left ? source.lastIndexOf("\n", left - 1) + 1 : 0;
        const end = Math.min(source.length, fragment.end + radius);
        const newline = source.indexOf("\n", end);
        right = newline < 0 ? source.length : newline + 1;
        context = source.slice(left, right);
        assert.ok(
          left > 0 ||
            right < source.length ||
            source.indexOf(context) === source.lastIndexOf(context),
          "Cannot isolate source occurrence",
        );
        radius *= 2;
      } while (source.indexOf(context) !== source.lastIndexOf(context));
      const anchor = { context, offset: fragment.start - left };
      entries.push({
        fragmentId: fragment.id,
        target: fragment.text,
        startLine: 1 + (source.slice(0, fragment.start).match(/\n/g) ?? []).length,
        endLine: 1 + (source.slice(0, fragment.end - 1).match(/\n/g) ?? []).length,
        targetSide: "context",
        anchor: context,
        offset: anchor.offset,
      });
      return { ...fragment, isolatedAnchor: anchor };
    });
    if (entries.length) hints.set(task.id, ambiguityAnchorsProse(entries));
    return { ...task, fragments };
  });
  return { plan: { ...plan, tasks }, hints };
}
