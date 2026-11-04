import assert from "node:assert/strict";

/** Partition whole, source-ordered flat-plan units using the actual rendered assignment size.
 * The caller renders only public information; fragment data in the result remains private.
 * A single unit may exceed the size goal, but is never split to make it fit.
 */
export async function partitionFlatTask(task, { render, maxBytes = 2048, maxEdits = 10 } = {}) {
  assert.equal(typeof task?.id, "string");
  assert.equal(typeof task.file, "string");
  assert.ok(Array.isArray(task.fragments) && task.fragments.length > 0);
  assert.equal(typeof render, "function");
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0);
  assert.ok(Number.isSafeInteger(maxEdits) && maxEdits > 0 && maxEdits <= 10);
  const ids = new Set();
  let end = 0;
  for (const fragment of task.fragments) {
    assert.equal(typeof fragment.id, "string");
    assert.ok(fragment.id.length > 0 && !ids.has(fragment.id));
    ids.add(fragment.id);
    assert.ok(Number.isSafeInteger(fragment.start) && Number.isSafeInteger(fragment.end));
    assert.ok(fragment.start >= end && fragment.end > fragment.start);
    end = fragment.end;
  }

  const batches = [];
  let current = [];
  let rendered;
  async function attempt(fragments) {
    const prompt = await render({ task, fragments: [...fragments], index: batches.length });
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.length > 0);
    return { prompt, bytes: Buffer.byteLength(prompt, "utf8") };
  }
  function flush() {
    if (!current.length) return;
    batches.push({
      id: `${task.id}-batch-${batches.length + 1}`,
      taskId: task.id,
      file: task.file,
      index: batches.length,
      fragments: current,
      ...rendered,
      oversized: rendered.bytes > maxBytes,
    });
    current = [];
    rendered = undefined;
  }
  for (const fragment of task.fragments) {
    if (current.length === maxEdits) flush();
    let next = [...current, fragment];
    let candidate = await attempt(next);
    if (current.length && candidate.bytes > maxBytes) {
      flush();
      next = [fragment];
      candidate = await attempt(next);
    }
    current = next;
    rendered = candidate;
  }
  flush();
  return batches;
}
