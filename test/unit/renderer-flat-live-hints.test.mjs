import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertFlatHintContexts,
  revalidateFlatHints,
} from "../../src/suites/explicit-edit-multi-agent/extraction/flat-live-hints.mjs";

test("live context checks reject stale and ambiguous hints", () => {
  const task = {
    fragments: [
      { text: "int x;", isolatedAnchor: { context: "before\nint x;\nafter\n", offset: 7 } },
    ],
  };
  const hint = "Under the lock, find context exactly once:\n```\nbefore\nint x;\nafter\n```";
  assert.doesNotThrow(() => assertFlatHintContexts("before\nint x;\nafter\n", task, [hint]));
  assert.throws(() => assertFlatHintContexts("changed", task, [hint]), /context/i);
  assert.throws(
    () => assertFlatHintContexts("before\nint x;\nafter\nbefore\nint x;\nafter\n", task, [hint]),
    /context/i,
  );
});

test("revalidation reads the live workspace under flock", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "flat-hints-"));
  const task = {
    fragments: [{ text: "int x;", isolatedAnchor: { context: "int x;\n", offset: 0 } }],
  };
  try {
    await writeFile(path.join(workspace, "main.cpp"), "int x;\n");
    await revalidateFlatHints(workspace, task, []);
    await writeFile(path.join(workspace, "main.cpp"), "int y;\n");
    await assert.rejects(revalidateFlatHints(workspace, task, []), /context/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
