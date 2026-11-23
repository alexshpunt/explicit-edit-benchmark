import { diffArrays } from "diff";

export interface LineHunk {
  at: number;
  remove: number;
  removed: string[];
  insert: string[];
}

/**
 * Line hunks that turn `before` into `after`, in increasing `at` order against `before`.
 * Common ends are cut first; a middle too different for a bounded diff becomes one hunk.
 */
export function lineHunks(before: string[], after: string[], maxEditLength = 20_000): LineHunk[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  if (start === endBefore && start === endAfter) return [];
  const oldMiddle = before.slice(start, endBefore);
  const newMiddle = after.slice(start, endAfter);
  if (oldMiddle.length === 0 || newMiddle.length === 0)
    return [{ at: start, remove: oldMiddle.length, removed: oldMiddle, insert: newMiddle }];
  const changes = diffArrays(oldMiddle, newMiddle, { maxEditLength });
  if (!changes)
    return [{ at: start, remove: oldMiddle.length, removed: oldMiddle, insert: newMiddle }];
  const hunks: LineHunk[] = [];
  let index = start;
  let open: LineHunk | undefined;
  for (const change of changes) {
    const lines = change.value;
    if (!change.added && !change.removed) {
      open = undefined;
      index += lines.length;
      continue;
    }
    if (!open) {
      open = { at: index, remove: 0, removed: [], insert: [] };
      hunks.push(open);
    }
    if (change.removed) {
      open.remove += lines.length;
      open.removed.push(...lines);
      index += lines.length;
    } else open.insert.push(...lines);
  }
  return hunks;
}

export function applyHunks(
  lines: string[],
  hunks: Array<{ at: number; remove: number; insert: string[] }>,
) {
  const out: string[] = [];
  let index = 0;
  // Loops, not spreads: a file can have more lines than a call can take arguments.
  for (const hunk of hunks) {
    for (const line of lines.slice(index, hunk.at)) out.push(line);
    index = Math.max(index, hunk.at);
    for (const line of hunk.insert) out.push(line);
    index += hunk.remove;
  }
  for (const line of lines.slice(index)) out.push(line);
  return out;
}
