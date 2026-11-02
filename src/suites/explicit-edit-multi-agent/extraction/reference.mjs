import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { referenceChannel } from "../reference/concurrent-channel.mjs";

/** Stage editing code only: no plan, original tree or private grading contract. */
export async function prepareExtractionReference(directory) {
  await mkdir(directory, { mode: 0o700 });
  for (const [source, target] of [
    ["extraction/reference-worker.mjs", "reference/module-extraction-worker.mjs"],
    ["extraction/edit.mjs", "extraction/edit.mjs"],
    ["reference/ordinary-edit.mjs", "reference/ordinary-edit.mjs"],
    ["reference/concurrent-commit.mjs", "reference/concurrent-commit.mjs"],
    ["cpp/cpp-tokens.mjs", "cpp/cpp-tokens.mjs"],
    ["cpp/cpp-structure.mjs", "cpp/cpp-structure.mjs"],
  ]) {
    const destination = path.join(directory, target);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(fileURLToPath(new URL("../" + source, import.meta.url)), destination);
  }
}

/** An explicit scripted reference, never a model observation. */
export function extractionReference(workspace, tools, { signal } = {}) {
  const channel = referenceChannel(workspace, tools, "module-extraction-worker.mjs", { signal });
  const sessionId = randomUUID();
  let messages = 0;
  return {
    ready: channel.ready,
    get closed() {
      return channel.closed;
    },
    async assertIdle() {
      await channel.assertIdle();
      return { sessionId, messageCount: messages };
    },
    execute(task) {
      messages++;
      // Everything here is derivable from the one public module assignment.
      return channel.deliver({
        id: task.id,
        file: task.file,
        guard: task.guard,
        kind: task.kind,
        fragments: task.fragments.map(
          ({ id, text, scope, kind, prefix, suffix, beforeFragment, afterFragment }) => ({
            id,
            text,
            scope,
            kind,
            prefix,
            suffix,
            beforeFragment,
            afterFragment,
          }),
        ),
        preamble: task.preamble,
        using: task.using,
        postamble: task.postamble,
        destination: task.destination,
        replacement: task.replacement,
      });
    },
    terminate: channel.close,
  };
}
