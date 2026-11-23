import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitGitWorkspace } from "../../src/suites/explicit-edit-multi-agent/extraction/assembly-run.mjs";

test("a Git workspace holds the start file as its only commit and nothing uncommitted", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "renderer-git-workspace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "main.cpp"), "int main() { return 0; }\n");
  await commitGitWorkspace(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.equal(git("ls-files"), "main.cpp");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("log", "-1", "--format=%s"), "Start");
});
