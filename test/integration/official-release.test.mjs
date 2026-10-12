import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tempDirectory } from "../helpers/temp.mjs";
import { releaseOfficialWorkflow } from "../../scripts/release-official-workflow.mjs";
import { loadOfficialPolicy } from "../../scripts/official-policy.mjs";
import { seedTeamReleaseEvidence } from "../helpers/team-release-evidence.mjs";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function repository(root) {
  await mkdir(root, { recursive: true });
  git(root, "init", "--initial-branch=release/test");
  git(root, "config", "user.name", "Release test");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "commit.gpgSign", "false");
  await writeFile(path.join(root, ".gitignore"), "node_modules\n");
}

async function fixture(t) {
  const root = await tempDirectory("official-release-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const benchmark = path.join(root, "benchmark");
  await repository(benchmark);
  for (const relative of [
    "fixtures/explicit-edit-multi-agent",
    "src/suites/explicit-edit-multi-agent",
    "policies/official-runs",
    ".github/workflows/official-run.yml",
    "package.json",
  ]) {
    await mkdir(path.dirname(path.join(benchmark, relative)), { recursive: true });
    await cp(path.resolve(relative), path.join(benchmark, relative), { recursive: true });
  }
  // This is controlled transaction evidence, not a fresh renderer reference proof.
  await seedTeamReleaseEvidence(benchmark);
  await symlink(path.resolve("node_modules"), path.join(benchmark, "node_modules"), "dir");
  git(benchmark, "add", ".");
  git(benchmark, "commit", "-m", "Seed tested benchmark");
  const callers = [path.join(root, "template"), path.join(root, "caller")];
  for (const caller of callers) {
    await repository(caller);
    await mkdir(path.join(caller, ".github/workflows"), { recursive: true });
    await cp(
      "test/fixtures/official-caller.yml",
      path.join(caller, ".github/workflows/official-run.yml"),
    );
    await cp(
      "test/fixtures/official-resubmit.yml",
      path.join(caller, ".github/workflows/resubmit.yml"),
    );
    git(caller, "add", ".");
    git(caller, "commit", "-m", "Seed public caller");
  }
  const keys = [
    "OFFICIAL_RELEASE_AUTOMATION",
    "GITHUB_ACTIONS",
    "GITHUB_REPOSITORY",
    "GITHUB_EVENT_NAME",
  ];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    OFFICIAL_RELEASE_AUTOMATION: "1",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "alexshpunt/explicit-edit-benchmark",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  });
  t.after(() => {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  });
  return { benchmark, callers };
}

await test("the local release transaction validates controlled evidence and upgrades both pinned callers", async (t) => {
  const { benchmark, callers } = await fixture(t);
  const runner = git(benchmark, "rev-parse", "HEAD");
  const result = await releaseOfficialWorkflow({
    root: benchmark,
    templateDirectory: callers[0],
    callerDirectories: [callers[1]],
  });
  assert.equal(result.workflowSha, runner);
  assert.equal(result.policySha, git(benchmark, "rev-parse", "HEAD"));
  assert.notEqual(result.policySha, runner);
  const policy = await loadOfficialPolicy(path.join(benchmark, "policies/official-runs/v1.json"));
  assert.equal(policy.suites["explicit-edit-multi-agent"].runner.tasks.length, 71);
  assert.deepEqual(policy.workflows.at(-1), { sha: runner, runnerSha: runner, status: "active" });
  for (const [index, caller] of callers.entries()) {
    const workflow = await readFile(
      path.join(caller, ".github/workflows/official-run.yml"),
      "utf8",
    );
    assert.ok(workflow.includes(`official-run.yml@${runner}`));
    assert.ok(workflow.includes(`official-submit.yml@${result.policySha}`));
    assert.ok(workflow.includes(`signer_sha: ${runner}`));
    assert.equal(workflow.split(`policy_sha: ${result.policySha}`).length - 1, 2);
    assert.ok(workflow.includes("suite: ${{ inputs.suite }}"));
    assert.ok(workflow.includes("options: [explicit-edit, explicit-edit-multi-agent]"));
    const recovery = await readFile(path.join(caller, ".github/workflows/resubmit.yml"), "utf8");
    assert.ok(recovery.includes(`official-submit.yml@${result.policySha}`));
    assert.ok(recovery.includes(`      policy_sha: ${result.policySha}\n`));
    assert.ok(recovery.includes(`        default: "${runner}"\n`));
    assert.ok(recovery.includes("      signer_sha: ${{ inputs.signer_sha }}\n"));
    assert.ok(!recovery.includes(`      signer_sha: ${runner}\n`));
    assert.deepEqual(
      git(caller, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n"),
      [".github/workflows/official-run.yml", ".github/workflows/resubmit.yml"],
    );
    assert.equal(
      index === 0 ? result.templateSha : result.callerShas[0],
      git(caller, "rev-parse", "HEAD"),
    );
    assert.equal(git(caller, "status", "--porcelain"), "");
  }
  assert.equal(git(benchmark, "status", "--porcelain"), "");
});

await test("a malformed recovery workflow in the second caller fails before any release mutation", async (t) => {
  const { benchmark, callers } = await fixture(t);
  await writeFile(path.join(callers[1], ".github/workflows/resubmit.yml"), "invalid recovery\n");
  git(callers[1], "add", ".");
  git(callers[1], "commit", "-m", "Malformed recovery fixture");
  const roots = [benchmark, ...callers];
  const heads = roots.map((root) => git(root, "rev-parse", "HEAD"));
  await assert.rejects(
    releaseOfficialWorkflow({
      root: benchmark,
      templateDirectory: callers[0],
      callerDirectories: [callers[1]],
    }),
    /recovery.*layout/,
  );
  for (const [index, root] of roots.entries()) {
    assert.equal(git(root, "rev-parse", "HEAD"), heads[index]);
    assert.equal(git(root, "status", "--porcelain"), "");
  }
});

await test("a malformed second caller fails before any release checkout is modified", async (t) => {
  const { benchmark, callers } = await fixture(t);
  await writeFile(path.join(callers[1], ".github/workflows/official-run.yml"), "invalid caller\n");
  git(callers[1], "add", ".");
  git(callers[1], "commit", "-m", "Malformed fixture");
  const roots = [benchmark, ...callers];
  const heads = roots.map((root) => git(root, "rev-parse", "HEAD"));
  await assert.rejects(
    releaseOfficialWorkflow({
      root: benchmark,
      templateDirectory: callers[0],
      callerDirectories: [callers[1]],
    }),
    /pin layout/,
  );
  for (const [index, root] of roots.entries()) {
    assert.equal(git(root, "rev-parse", "HEAD"), heads[index]);
    assert.equal(git(root, "status", "--porcelain"), "");
  }
});
