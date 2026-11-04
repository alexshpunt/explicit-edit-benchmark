import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Verify the context excerpts actually shown to the agent, without guessing. */
export function assertFlatHintContexts(source, task, hints) {
  function unique(context) {
    assert.ok(context.length > 0, "Empty live hint context");
    const first = source.indexOf(context);
    assert.ok(
      first >= 0 && first === source.lastIndexOf(context),
      "Live hint context is missing or ambiguous",
    );
  }
  for (const fragment of task.fragments) {
    if (!fragment.isolatedAnchor) continue;
    const { context, offset } = fragment.isolatedAnchor;
    unique(context);
    assert.equal(
      context.slice(offset, offset + fragment.text.length),
      fragment.text,
      "Live target context changed",
    );
  }
  for (const hint of hints) {
    const contexts = [...hint.matchAll(/^(`{3,})\n([\s\S]*?)^\1$/gm)];
    assert.ok(contexts.length, "Unsupported live hint format");
    for (const match of contexts) {
      let context = match[2];
      if (!source.includes(context) && context.endsWith("\n")) context = context.slice(0, -1);
      unique(context);
    }
  }
}

/** Check the current source without coordinating participant edits. */
export async function revalidateFlatHints(workspace, task, hints, { signal } = {}) {
  if (!hints.length && !task.fragments.some((fragment) => fragment.isolatedAnchor)) return;
  const source = await readFile(path.join(workspace, "main.cpp"), { encoding: "utf8", signal });
  assertFlatHintContexts(source, task, hints);
}
