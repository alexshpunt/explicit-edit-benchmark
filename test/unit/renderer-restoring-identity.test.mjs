import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { restoringSourceIdentity } from "../../src/suites/explicit-edit-multi-agent/execution/restoring-identity.mjs";

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "restoring-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/suites/explicit-edit-multi-agent"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "src/suites/explicit-edit-multi-agent/fixture.mjs"),
    "export const value = 1;\n",
  );
  await writeFile(path.join(root, "scripts/runner.mjs"), "export const command = 1;\n");
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  const git = (...args) => exec("git", args, { cwd: root });
  const commit = async () => {
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture source",
    );
  };
  await git("init", "--quiet");
  await commit();
  return { root, commit };
}

test("restoring source identity binds execution scripts outside the suite verifier", async (t) => {
  const { root } = await fixture(t);
  const before = await restoringSourceIdentity(root);
  assert.equal(before.sourceClean, true);
  assert.match(before.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(before.runnerSha256, /^[a-f0-9]{64}$/);
  await writeFile(path.join(root, "scripts/runner.mjs"), "export const command = 2;\n");
  const after = await restoringSourceIdentity(root);
  assert.equal(after.verifierSha256, before.verifierSha256);
  assert.notEqual(after.runnerSha256, before.runnerSha256);
  assert.equal(after.sourceCommit, before.sourceCommit);
  assert.equal(after.sourceClean, false);
});

test("a documentation-only commit still changes the exact final source binding", async (t) => {
  const { root, commit } = await fixture(t);
  const before = await restoringSourceIdentity(root);
  await writeFile(path.join(root, "README.md"), "Fixture documentation.\n");
  await commit();
  const after = await restoringSourceIdentity(root);
  assert.equal(after.sourceClean, true);
  assert.equal(after.runnerSha256, before.runnerSha256);
  assert.equal(after.verifierSha256, before.verifierSha256);
  assert.notEqual(after.sourceCommit, before.sourceCommit);
});
