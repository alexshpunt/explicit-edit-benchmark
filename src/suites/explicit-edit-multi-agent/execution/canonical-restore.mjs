import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { readTree, treeIdentity, writeTree } from "../generation/generator.mjs";

/** Replace only a drained participant workspace with its trusted current endpoint.
 * Preserve the root inode: persistent sandbox directory mounts must keep seeing it.
 * Stage and verify before deleting anything, never follow candidate symlinks, and
 * compare the complete restored tree, including otherwise ignored extra files.
 * The caller owns candidate evidence, canonical verification and writer quiescence.
 */
export async function restoreCanonicalSource(workspace, tree, { signal } = {}) {
  signal?.throwIfAborted();
  const root = path.resolve(workspace);
  const before = await lstat(root);
  assert.ok(before.isDirectory() && !before.isSymbolicLink(), "Unsafe restoration workspace");
  const identity = treeIdentity(tree);
  const temporary = await mkdtemp(path.join(path.dirname(root), ".canonical-"));
  try {
    const staged = path.join(temporary, "source");
    await writeTree(staged, tree);
    assert.equal(treeIdentity(await readTree(staged)), identity, "Invalid canonical source bytes");
    signal?.throwIfAborted();
    const current = await lstat(root);
    assert.ok(
      current.isDirectory() && current.dev === before.dev && current.ino === before.ino,
      "Workspace changed before canonical restoration",
    );
    for (const name of await readdir(root))
      await rm(path.join(root, name), { recursive: true, force: true });
    for (const name of await readdir(staged))
      await rename(path.join(staged, name), path.join(root, name));
    assert.equal(treeIdentity(await readTree(root)), identity, "Canonical restoration differs");
    signal?.throwIfAborted();
    return { identity, files: Object.keys(tree).length, restored: true };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
