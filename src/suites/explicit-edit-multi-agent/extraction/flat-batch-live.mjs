import assert from "node:assert/strict";

export function projectedSource(plan, completed) {
  const original = plan.initial["main.cpp"];
  const edits = plan.tasks
    .flatMap((task) =>
      task.fragments
        .filter((f) => completed.has(f.id))
        .map((f) => ({
          start: f.start,
          end: f.end,
          text: f.id === task.fragments[0].id ? task.replacement : "",
        })),
    )
    .sort((a, b) => a.start - b.start);
  let source = "",
    cursor = 0;
  for (const edit of edits) {
    assert.ok(cursor <= edit.start);
    source += original.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return { source: source + original.slice(cursor), edits };
}
// Rebuild an original unique context after verified original-range removals.
// The result must still occur exactly once in the actual live source.
export function currentBatchAnchors(initial, source, task, batch, completed, projection) {
  const edits = task.fragments
    .filter((f) => completed.has(f.id))
    .map((f) => ({
      start: f.start,
      end: f.end,
      text: f.id === task.fragments[0].id ? task.replacement : "",
    }));
  return batch.fragments.map((f) => {
    if (!f.isolatedAnchor) return f;
    const { context, offset } = f.isolatedAnchor;
    const begin = initial.indexOf(context),
      end = begin + context.length;
    assert.ok(begin >= 0 && begin === initial.lastIndexOf(context));
    assert.equal(begin + offset, f.start);
    let built = "",
      cursor = begin,
      targetOffset,
      changed = false;
    for (const edit of edits) {
      if (edit.end <= begin || edit.start >= end) continue;
      changed = true;
      const left = Math.max(begin, edit.start),
        right = Math.min(end, edit.end);
      assert.ok(cursor <= left);
      if (targetOffset === undefined && f.start < left)
        targetOffset = built.length + (f.start - cursor);
      built += initial.slice(cursor, left) + (edit.start >= begin ? edit.text : "");
      cursor = right;
    }
    if (targetOffset === undefined) targetOffset = built.length + (f.start - cursor);
    built += initial.slice(cursor, end);
    if (changed)
      assert.ok(
        projection && projection.source === source,
        "Cannot verify changed anchor ownership",
      );
    assert.equal(
      built.slice(targetOffset, targetOffset + f.text.length),
      f.text,
      "Live anchor lost its target",
    );
    if (!source.includes(built) || source.indexOf(built) !== source.lastIndexOf(built)) {
      assert.ok(projection && projection.source === source, "Live anchor is missing or ambiguous");
      const pos =
        f.start +
        projection.edits
          .filter((e) => e.end <= f.start)
          .reduce((n, e) => n + e.text.length - (e.end - e.start), 0);
      assert.equal(source.slice(pos, pos + f.text.length), f.text, "Projected target changed");
      let radius = 1,
        left,
        right;
      do {
        left = Math.max(0, pos - radius);
        left = left ? source.lastIndexOf("\n", left - 1) + 1 : 0;
        const edge = Math.min(source.length, pos + f.text.length + radius),
          newline = source.indexOf("\n", edge);
        right = newline < 0 ? source.length : newline + 1;
        built = source.slice(left, right);
        radius *= 2;
      } while (source.indexOf(built) !== source.lastIndexOf(built));
      targetOffset = pos - left;
    }
    return { ...f, isolatedAnchor: { context: built, offset: targetOffset } };
  });
}
