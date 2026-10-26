import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restoreCanonicalSource } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-restore.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-restore-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  await writeTree(workspace, { "main.cpp": "int old_name;\n", "stale.h": "int stale;\n" });
  return { directory, workspace };
}

const canonical = {
  "main.cpp": '#include "support/needed.h"\nint restored;\n',
  "support/needed.h": "#pragma once\n",
};

test("canonical restoration repairs damaged and missing files and removes every extra entry", async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace, "junk"));
  await writeFile(path.join(workspace, "junk/debug.bin"), Buffer.from([255, 0, 17]));
  await writeFile(path.join(workspace, ".publication-lock"), "held");
  const result = await restoreCanonicalSource(workspace, canonical);
  assert.deepEqual(await readTree(workspace), canonical);
  assert.deepEqual((await readdir(workspace)).sort(), ["main.cpp", "support"]);
  assert.equal(result.identity, treeIdentity(canonical));
  assert.equal(result.files, 2);
  assert.equal(result.restored, true);
});

test("restoration preserves the workspace inode and existing directory mounts", async (t) => {
  const { workspace } = await fixture(t);
  const before = await stat(workspace);
  const handle = await open(workspace, "r");
  t.after(() => handle.close());
  await restoreCanonicalSource(workspace, canonical);
  const after = await stat(workspace);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(
    await readFile(`/proc/self/fd/${handle.fd}/main.cpp`, "utf8"),
    canonical["main.cpp"],
  );
});

test("candidate symlinks are removed without following them outside the project", async (t) => {
  const { directory, workspace } = await fixture(t);
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "untouched");
  await symlink(outside, path.join(workspace, "support"));
  await restoreCanonicalSource(workspace, canonical);
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "untouched");
  assert.deepEqual(await readTree(workspace), canonical);
});

test("a workspace symlink cannot redirect controller restoration", async (t) => {
  const { directory, workspace } = await fixture(t);
  const link = path.join(directory, "linked-workspace");
  await symlink(workspace, link);
  await assert.rejects(restoreCanonicalSource(link, canonical));
  assert.equal(await readFile(path.join(workspace, "main.cpp"), "utf8"), "int old_name;\n");
});

test("unsafe or invalid trusted trees fail before changing the measured candidate", async (t) => {
  const { workspace } = await fixture(t);
  for (const tree of [
    { "../escape.cpp": "int escaped;" },
    { "/absolute.cpp": "int escaped;" },
    { "main.cpp": 42 },
    { "a.h": "int a;", "a.h/b.cpp": "int b;" },
  ]) {
    await assert.rejects(restoreCanonicalSource(workspace, tree));
    assert.equal(await readFile(path.join(workspace, "main.cpp"), "utf8"), "int old_name;\n");
  }
});

test("cancellation before restoration leaves the candidate intact", async (t) => {
  const { workspace } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(restoreCanonicalSource(workspace, canonical, { signal: controller.signal }));
  assert.equal(await readFile(path.join(workspace, "main.cpp"), "utf8"), "int old_name;\n");
});

test("a successful round is canonicalized too and staging directories are cleaned", async (t) => {
  const { directory, workspace } = await fixture(t);
  await restoreCanonicalSource(workspace, canonical);
  await restoreCanonicalSource(workspace, canonical);
  assert.deepEqual(await readTree(workspace), canonical);
  assert.deepEqual(await readdir(directory), ["workspace"]);
});
