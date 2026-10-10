import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { treeIdentity } from "../generation/generator.mjs";

/** Read candidate C++ source only, not concurrent locks or tool scratch data. */
export async function readSharedSource(workspace) {
  const tree = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(workspace, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        !relative &&
        entry.isDirectory() &&
        /^(?:\.renderer-edit-lock|\.renderer-planner-\d+)$/.test(entry.name)
      ) {
        try {
          if ((await readdir(path.join(workspace, name))).length)
            throw Error(`Nonempty reference control directory: ${name}`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        continue;
      }
      if (entry.isDirectory()) await visit(name);
      else if (!entry.isFile()) throw Error(`Nonregular candidate entry: ${name}`);
      else if (/\.(?:cpp|h)$/.test(name)) {
        const bytes = await readFile(path.join(workspace, name));
        const text = bytes.toString("utf8");
        if (!Buffer.from(text).equals(bytes)) throw Error(`Invalid source UTF-8: ${name}`);
        tree[name] = text;
      }
    }
  }
  await visit("");
  return tree;
}

async function locked(workspace, signal, action) {
  const lock = path.join(workspace, ".renderer-edit-lock");
  let owned = false;
  try {
    while (!owned) {
      signal?.throwIfAborted();
      try {
        await mkdir(lock);
        owned = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await delay(10, undefined, { signal });
      }
    }
    signal?.throwIfAborted();
    return await action();
  } finally {
    if (owned) await rm(lock, { recursive: true });
  }
}

/** Reference workers take a consistent read snapshot, then release the lock while
 * planning. Live tools are not required to use this lock or this editing method.
 */
export function readSharedSnapshot(workspace, { signal } = {}) {
  return locked(workspace, signal, () => readSharedSource(workspace));
}

/** Compare and commit a reference source transaction under a shared short lock.
 * Stale snapshots return false without writing. Readers using readSharedSnapshot
 * cannot see a half-published multi-file move. Failed edits are never rolled back.
 * All agent work and compiler planning still happen against the shared project,
 * outside this lock. Only current selected changes are published, never answers.
 */
export async function commitSnapshot(workspace, before, after, { signal } = {}) {
  const changed = Object.keys(after).filter((file) => after[file] !== before[file]);
  const removed = Object.keys(before).filter((file) => !(file in after));
  if (!changed.length && !removed.length) throw Error("Empty concurrent reference transaction");
  for (const file of [...changed, ...removed])
    if (
      !/^[A-Za-z0-9_./-]+\.(?:cpp|h)$/.test(file) ||
      file.startsWith("/") ||
      file.split("/").includes("..")
    )
      throw Error("Unsafe concurrent source path");
  return locked(workspace, signal, async () => {
    if (treeIdentity(await readSharedSource(workspace)) !== treeIdentity(before)) return false;
    const staged = [];
    try {
      for (const file of changed) {
        const temporary = path.join(workspace, `.renderer-write-${randomUUID()}`);
        await writeFile(temporary, after[file], { flag: "wx" });
        staged.push({ file, temporary });
      }
      signal?.throwIfAborted();
      for (const item of staged) {
        await mkdir(path.dirname(path.join(workspace, item.file)), { recursive: true });
        await rename(item.temporary, path.join(workspace, item.file));
      }
      for (const file of removed) await unlink(path.join(workspace, file));
      return true;
    } finally {
      await Promise.all(staged.map((item) => rm(item.temporary, { force: true })));
    }
  });
}
