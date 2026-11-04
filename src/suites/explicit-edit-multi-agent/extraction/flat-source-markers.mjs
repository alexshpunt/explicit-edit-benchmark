import assert from "node:assert/strict";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

// Execution-only markers; do not mutate the original plan used for grading.
export function markSources(plan, tree) {
  const original = tree["main.cpp"];
  assert.equal(typeof original, "string");
  const fragments = plan.tasks.flatMap((t) => t.fragments).toSorted((a, b) => a.start - b.start);
  const markers = new Map();
  let previous = 0,
    source = "";
  for (const [i, f] of fragments.entries()) {
    assert.ok(f.start >= previous && f.end > f.start, `Overlapping source unit: ${f.id}`);
    assert.equal(original.slice(f.start, f.end), f.text, `Stale source unit: ${f.id}`);
    const marker = `/* EES${String(i).padStart(5, "0")} */`;
    assert.ok(
      Object.values(tree).every((text) => !text.includes(marker)) && !markers.has(f.id),
      "Source marker collision",
    );
    source += original.slice(previous, f.start) + marker + f.text;
    previous = f.end;
    markers.set(f.id, marker);
  }
  source += original.slice(previous);
  return { tree: { ...tree, "main.cpp": source }, sourceMarkers: markers };
}
export function removeSourceMarkers(source, markers) {
  const issued = new Set(markers.values());
  let result = "",
    cursor = 0;
  for (const token of cppTokens(source)) {
    if (!issued.has(token.text)) continue;
    result += source.slice(cursor, token.start);
    cursor = token.end;
  }
  return result + source.slice(cursor);
}
