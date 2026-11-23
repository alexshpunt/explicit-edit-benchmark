/** Turns trace hunks into CodeMirror changes, so the editor follows the playhead with small
 * edits instead of replacing a megabyte document on every frame.
 *
 * The document holds the lines joined with "\n" plus a trailing "\n" when there are lines,
 * so line i (0-based) always starts at doc.line(i + 1).from, and i == line count is the end. */
import { ChangeSet, type ChangeSpec, type Text } from "@codemirror/state";
import type { Hunk } from "../../trace/types.ts";

export const documentText = (lines: readonly string[]) =>
  lines.length ? lines.join("\n") + "\n" : "";

/** Number of trace lines the document holds. */
export const documentLines = (doc: Text) => doc.lines - 1;

const lineStart = (doc: Text, index: number) => doc.line(index + 1).from;
const joined = (lines: readonly string[]) => lines.map((line) => line + "\n").join("");

/** Changes that apply one file change (its hunks) to the document before it. */
export function forwardChanges(doc: Text, hunks: readonly Hunk[]): ChangeSet {
  const specs: ChangeSpec[] = hunks.map((hunk) => ({
    from: lineStart(doc, hunk.at),
    to: lineStart(doc, hunk.at + hunk.remove),
    insert: joined(hunk.insert),
  }));
  return ChangeSet.of(specs, doc.length);
}

/** Changes that undo one file change, given the document after it. */
export function backwardChanges(doc: Text, hunks: readonly Hunk[]): ChangeSet {
  let shift = 0;
  const specs: ChangeSpec[] = hunks.map((hunk) => {
    const at = hunk.at + shift;
    shift += hunk.insert.length - hunk.remove;
    return {
      from: lineStart(doc, at),
      to: lineStart(doc, at + hunk.insert.length),
      insert: joined(hunk.removed),
    };
  });
  return ChangeSet.of(specs, doc.length);
}

/** Composed changes from version `from` to version `to`, or null when a full replace is cheaper. */
export function changesBetween(
  doc: Text,
  changes: ReadonlyArray<{ hunks: readonly Hunk[] }>,
  from: number,
  to: number,
  limit = 160,
): ChangeSet | null {
  if (from === to) return ChangeSet.empty(doc.length);
  if (Math.abs(to - from) > limit) return null;
  let text = doc;
  let total: ChangeSet | null = null;
  if (to > from)
    for (let version = from; version < to; version++) {
      const step = forwardChanges(text, changes[version]?.hunks ?? []);
      text = step.apply(text);
      total = total ? total.compose(step) : step;
    }
  else
    for (let version = from; version > to; version--) {
      const step = backwardChanges(text, changes[version - 1]?.hunks ?? []);
      text = step.apply(text);
      total = total ? total.compose(step) : step;
    }
  return total;
}
