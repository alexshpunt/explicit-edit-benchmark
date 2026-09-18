import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  pinCallerTemplate,
  pinPiAgentIdeWorkflow,
} from "../../scripts/release-official-workflow.mjs";

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

test("one release updates every Pi Agent IDE workflow pin", () => {
  const workflow = `uses: owner/repo/.github/workflows/official-run.yml@${old}\npolicy_sha: ${old}\nuses: owner/repo/.github/workflows/official-submit.yml@${old}\nsigner_sha: ${old}\npolicy_sha: ${old}\n`;
  assert.equal(
    pinPiAgentIdeWorkflow(workflow, current, policy),
    `uses: owner/repo/.github/workflows/official-run.yml@${current}\npolicy_sha: ${policy}\nuses: owner/repo/.github/workflows/official-submit.yml@${current}\nsigner_sha: ${current}\npolicy_sha: ${policy}\n`,
  );
});

test("release pinning fails when the caller template layout drifts", () => {
  assert.throws(() => pinCallerTemplate(`signer_sha: ${old}\n`, current, policy), /pin layout/);
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
