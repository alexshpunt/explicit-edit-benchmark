import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pinCallerTemplate } from "../../scripts/release-official-workflow.mjs";

const old = "a".repeat(40);
const current = "b".repeat(40);
const policy = "c".repeat(40);

test("one derived workflow SHA updates both caller pins", () => {
  const template = `uses: owner/repo/.github/workflows/official-run.yml@${old}\npolicy_sha: ${old}\nsigner_sha: ${old}\nuses: owner/repo/.github/workflows/official-submit.yml@${old}\npolicy_sha: ${old}\n`;
  assert.equal(
    pinCallerTemplate(template, current, policy),
    `uses: owner/repo/.github/workflows/official-run.yml@${current}\npolicy_sha: ${policy}\nsigner_sha: ${current}\nuses: owner/repo/.github/workflows/official-submit.yml@${policy}\npolicy_sha: ${policy}\n`,
  );
});

test("release preparation gives both suites one pinned caller with suite-derived concurrency", async () => {
  const { prepareCallerTemplate } = await import("../../scripts/release-official-workflow.mjs");
  const legacy = `"on":
  workflow_dispatch:
    inputs:
      task:
        description: Optional task id; empty runs all 226 canonical tasks
        required: false
        default: ""
        type: string
      concurrency:
        description: Concurrency for a full canonical run
        required: false
        default: "10"
        type: string
jobs:
  run:
    uses: owner/repo/.github/workflows/official-run.yml@${old}
    with:
      task: \${{ inputs.task }}
      concurrency: \${{ inputs.concurrency }}
      policy_sha: ${old}
  submit:
    uses: owner/repo/.github/workflows/official-submit.yml@${old}
    with:
      signer_sha: ${old}
      policy_sha: ${old}
`;
  const result = prepareCallerTemplate(legacy, current, policy);
  assert.match(result, /options: \[explicit-edit, explicit-edit-multi-agent\]/);
  assert.match(result, /suite: \$\{\{ inputs\.suite \}\}/);
  assert.match(
    result,
    /concurrency:\n        description: [^\n]+\n        required: false\n        default: ""/,
  );
  assert.equal(prepareCallerTemplate(result, current, policy), result);
  assert.throws(
    () =>
      prepareCallerTemplate(legacy.replace("      task:\n", "      unknown:\n"), current, policy),
    /caller.*layout/i,
  );
});
test("submit-only recovery upgrades legacy pins and keeps the original signer selectable", async () => {
  const { prepareResubmitTemplate } = await import("../../scripts/release-official-workflow.mjs");
  const legacy = await readFile("test/fixtures/official-resubmit.yml", "utf8");
  const result = prepareResubmitTemplate(legacy, current, policy);
  assert.ok(result.includes(`official-submit.yml@${policy}`));
  assert.ok(result.includes(`      policy_sha: ${policy}\n`));
  assert.ok(result.includes(`        default: "${current}"\n`));
  assert.ok(result.includes("      signer_sha: ${{ inputs.signer_sha }}\n"));
  assert.ok(!result.includes(`      signer_sha: ${current}\n`));
  assert.equal(prepareResubmitTemplate(result, current, policy), result);
  const next = prepareResubmitTemplate(result, old, current);
  assert.ok(next.includes(`        default: "${old}"\n`));
  assert.ok(next.includes(`official-submit.yml@${current}`));
  assert.ok(next.includes(`      policy_sha: ${current}\n`));
  assert.ok(next.includes("      signer_sha: ${{ inputs.signer_sha }}\n"));
  for (const malformed of [
    legacy.replace("      producer_attempt:\n", "      unknown_attempt:\n"),
    legacy.replace(/      signer_sha: [0-9a-f]{40}/u, "      signer_sha: ${{ inputs.other }}"),
    result.replace("      signer_sha: ${{ inputs.signer_sha }}", `      signer_sha: ${old}`),
    result + `      policy_sha: ${policy}\n`,
    result.replace(`      policy_sha: ${policy}`, "      policy_sha: ${{ inputs.policy_sha }}"),
    result.replace(`official-submit.yml@${policy}`, "official-submit.yml@main"),
  ])
    assert.throws(() => prepareResubmitTemplate(malformed, current, policy), /recovery.*layout/i);
  assert.throws(() => prepareResubmitTemplate(legacy, "main", policy), /full.*SHAs/);
});
test("release pinning fails when the caller template layout drifts", () => {
  assert.throws(() => pinCallerTemplate(`signer_sha: ${old}\n`, current, policy), /pin layout/);
});

test("official releases publish one mutable workflow reference", async () => {
  const workflow = await readFile(
    path.join(import.meta.dirname, "../../.github/workflows/release-official-workflow.yml"),
    "utf8",
  );
  assert.match(workflow, /RUNNER_SHA:refs\/heads\/official/);
});

test("reviewed team evidence authorizes only the unchanged full suite and leaves original policy intact", async (t) => {
  const { prepareReleasePolicy } = await import("../../scripts/release-official-workflow.mjs");
  const { cp, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "official-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [
    "fixtures/explicit-edit-multi-agent",
    "src/suites/explicit-edit-multi-agent",
    "policies/official-runs",
  ])
    await cp(path.resolve(relative), path.join(root, relative), { recursive: true });
  const original = JSON.parse(await readFile("policies/official-runs/v1.json", "utf8"));
  delete original.suites; // Exercise the original-suite policy before team activation.
  const approved = await prepareReleasePolicy(original, current, root);
  assert.deepEqual(approved.runner, original.runner);
  assert.deepEqual(approved.runPolicy, original.runPolicy);
  assert.deepEqual(approved.fullRunPolicy, original.fullRunPolicy);
  assert.deepEqual(approved.normalizedSchemas, [1, 2]);
  assert.equal(original.suites, undefined);
  const team = approved.suites["explicit-edit-multi-agent"];
  assert.equal(team.runner.tasks.length, 71);
  assert.deepEqual(team.runPolicy, {
    partialRuns: true,
    oracleRecoveries: 3,
    retryFailures: 0,
    concurrency: 15,
    timeoutMs: null,
  });
  assert.deepEqual(approved.workflows.at(-1), {
    sha: current,
    runnerSha: current,
    status: "active",
  });
  const revoked = structuredClone(original);
  revoked.workflows.push({ sha: current, runnerSha: current, status: "revoked" });
  await assert.rejects(prepareReleasePolicy(revoked, current, root), /reactivate/);
  const evidenceFile = path.join(root, "policies/official-runs/multi-agent-v1.json");
  const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
  const failed = structuredClone(evidence);
  failed.reference.acceptedTasks = 70;
  await writeFile(evidenceFile, JSON.stringify(failed));
  await assert.rejects(prepareReleasePolicy(original, current, root), /70 !== 71/);
  await writeFile(evidenceFile, JSON.stringify(evidence));
  await writeFile(
    path.join(root, "fixtures/explicit-edit-multi-agent/main.cpp"),
    "changed fixture",
  );
  await assert.rejects(prepareReleasePolicy(original, current, root), /Fixture changed/);
  await cp(
    path.resolve("fixtures/explicit-edit-multi-agent/main.cpp"),
    path.join(root, "fixtures/explicit-edit-multi-agent/main.cpp"),
  );
  await writeFile(
    path.join(root, "src/suites/explicit-edit-multi-agent/prepare.mjs"),
    "changed suite",
  );
  await assert.rejects(prepareReleasePolicy(original, current, root), /Suite changed/);
});
test("ordinary users cannot invoke the maintainer release command", () => {
  const result = spawnSync(process.execPath, ["scripts/release-official-workflow.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, OFFICIAL_RELEASE_AUTOMATION: "0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only through the maintainer release workflow/);
});
