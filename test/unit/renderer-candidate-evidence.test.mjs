import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureCandidate,
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../../src/suites/explicit-edit-multi-agent/execution/candidate-evidence.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderer-evidence-"));
  t.after(() => {
    releaseCandidateWorkspace(path.join(root, "workspace"));
    return rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace, evidence: path.join(root, "evidence") };
}

test("candidate evidence saves exact regular bytes even when C++ source is invalid UTF-8", async (t) => {
  const { workspace, evidence } = await fixture(t);
  const bad = Buffer.from([105, 110, 116, 32, 255, 59]);
  await writeFile(path.join(workspace, "main.cpp"), bad);
  await writeFile(path.join(workspace, "extra.bin"), Buffer.from([255, 0, 1]));
  await mkdir(path.join(workspace, "support"));
  await writeFile(path.join(workspace, "support/valid.h"), "int valid;\n");
  const candidate = await captureCandidate(workspace, evidence);
  assert.deepEqual(await readFile(path.join(candidate.source, "main.cpp")), bad);
  assert.deepEqual(
    await readFile(path.join(candidate.source, "extra.bin")),
    Buffer.from([255, 0, 1]),
  );
  assert.deepEqual(candidate.tree, { "support/valid.h": "int valid;\n" });
  assert.deepEqual(candidate.lexicalTree, {
    "main.cpp": "int \udcff;",
    "support/valid.h": "int valid;\n",
  });
  assert.deepEqual(candidate.files, ["main.cpp", "support/valid.h"]);
  assert.equal(
    candidate.invalid.some((entry) => entry.path === "main.cpp"),
    true,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(evidence, "manifest.json"), "utf8")).entries.length,
    4,
  );
});

test("candidate evidence records directory symlinks without reading outside files", async (t) => {
  const { root, workspace, evidence } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "private.h"), "outside sentinel");
  await symlink(outside, path.join(workspace, "support"));
  await writeFile(path.join(workspace, "main.cpp"), "int main() {}\n");
  const candidate = await captureCandidate(workspace, evidence);
  assert.deepEqual(candidate.files, ["main.cpp"]);
  assert.deepEqual(candidate.manifest.entries.map((entry) => entry.type).sort(), [
    "file",
    "symlink",
  ]);
  assert.equal(
    candidate.manifest.entries.find((entry) => entry.type === "symlink").target,
    outside,
  );
  assert.equal(
    candidate.manifest.entries.some((entry) => entry.path.endsWith("private.h")),
    false,
  );
  assert.equal(await readFile(path.join(outside, "private.h"), "utf8"), "outside sentinel");
});

test("a measured candidate stays untouched and any later bytes invalidate its boundary", async (t) => {
  const { workspace, evidence } = await fixture(t);
  await writeFile(path.join(workspace, "main.cpp"), "int first;\n");
  const before = await stat(workspace);
  const candidate = await captureCandidate(workspace, evidence);
  await assertCandidateUnchanged(workspace, candidate);
  assert.equal((await stat(workspace)).ino, before.ino);
  await writeFile(path.join(workspace, "main.cpp"), "int late;\n");
  await assert.rejects(
    assertCandidateUnchanged(workspace, candidate),
    (error) => error.category === "infrastructure",
  );
  assert.equal(await readFile(path.join(candidate.source, "main.cpp"), "utf8"), "int first;\n");
});

test("candidate evidence rejects workspace links and an output inside the candidate", async (t) => {
  const { root, workspace, evidence } = await fixture(t);
  const alias = path.join(root, "alias");
  await symlink(workspace, alias);
  await assert.rejects(captureCandidate(alias, evidence));
  await assert.rejects(captureCandidate(workspace, path.join(workspace, "capture")));
});

test("candidate evidence preserves non-UTF-8 filenames as raw path bytes", async (t) => {
  const { workspace, evidence } = await fixture(t);
  const relative = Buffer.from([98, 97, 100, 255, 46, 104]);
  const sourcePath = Buffer.concat([Buffer.from(`${workspace}/`), relative]);
  await writeFile(sourcePath, "int intact;\n");
  const candidate = await captureCandidate(workspace, evidence);
  assert.equal(candidate.manifest.entries[0].path, null);
  assert.equal(candidate.manifest.entries[0].pathBytes, relative.toString("base64"));
  assert.equal(
    await readFile(Buffer.concat([Buffer.from(`${candidate.source}/`), relative]), "utf8"),
    "int intact;\n",
  );
  await assertCandidateUnchanged(workspace, candidate);
});

test("rewriting identical bytes still violates the drained write boundary", async (t) => {
  const { workspace, evidence } = await fixture(t);
  await writeFile(path.join(workspace, "main.cpp"), "int same;\n");
  const candidate = await captureCandidate(workspace, evidence);
  await writeFile(path.join(workspace, "main.cpp"), "int same;\n");
  await assert.rejects(
    assertCandidateUnchanged(workspace, candidate),
    (error) => error.category === "infrastructure" && error.cause?.code === "CANDIDATE_WRITE_EVENT",
  );
});
test("read-only captures retain prior boundaries and keep one bounded watch set", async (t) => {
  const { workspace, root, evidence } = await fixture(t);
  await mkdir(path.join(workspace, "support"));
  await writeFile(path.join(workspace, "support/main.cpp"), "int stable;\n");
  const first = await captureCandidate(workspace, evidence);
  const watchCount = async () => {
    let count = 0;
    for (const fd of await readdir("/proc/self/fd")) {
      let target;
      try {
        target = await readlink(`/proc/self/fd/${fd}`);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (target === "anon_inode:inotify")
        count += (await readFile(`/proc/self/fdinfo/${fd}`, "utf8"))
          .split("\n")
          .filter((line) => line.startsWith("inotify ")).length;
    }
    return count;
  };
  const count = await watchCount();
  assert.ok(count >= 2);
  for (let i = 0; i < 25; i++) {
    const current = await captureCandidate(workspace, path.join(root, `capture-${i}`));
    await assertCandidateUnchanged(workspace, first);
    await assertCandidateUnchanged(workspace, current);
    assert.equal(await watchCount(), count);
  }
  releaseCandidateWorkspace(workspace);
  assert.equal(await watchCount(), count - 2);
  await assert.rejects(
    assertCandidateUnchanged(workspace, first),
    (error) =>
      error.category === "infrastructure" && error.cause?.code === "CANDIDATE_JOURNAL_CLOSED",
  );
  const fresh = await captureCandidate(workspace, path.join(root, "fresh"));
  await assertCandidateUnchanged(workspace, fresh);
  await writeFile(path.join(workspace, "support/main.cpp"), "int stable;\n");
  await assert.rejects(
    assertCandidateUnchanged(workspace, fresh),
    (error) => error.category === "infrastructure" && error.cause?.code === "CANDIDATE_WRITE_EVENT",
  );
});
test("candidate evidence refuses to overwrite earlier evidence", async (t) => {
  const { workspace, evidence } = await fixture(t);
  await writeFile(path.join(workspace, "main.cpp"), "int first;\n");
  const first = await captureCandidate(workspace, evidence);
  await writeFile(path.join(workspace, "main.cpp"), "int second;\n");
  await assert.rejects(captureCandidate(workspace, evidence));
  assert.equal(await readFile(path.join(first.source, "main.cpp"), "utf8"), "int first;\n");
});
