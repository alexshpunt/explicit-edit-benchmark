import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");

test("usage corrections are owner-only manual jobs serialized with Dataset acceptance", async () => {
  const source = await workflow("correct-huggingface-usage.yml");
  assert.match(source, /workflow_dispatch:/u);
  assert.doesNotMatch(source, /schedule:|pull_request:/u);
  assert.match(source, /github.actor == github.repository_owner/u);
  assert.match(source, /github.ref == 'refs\/heads\/main'/u);
  assert.match(source, /group: huggingface-dataset-alexshpunt-explicit-edit-benchmark/u);
  assert.match(source, /default: true/u);
  assert.match(source, /EXPECTED_DATASET_REVISION:/u);
});

test("Dataset rebuilds retain the previous public snapshot for 30 days", async () => {
  const source = await workflow("auto-accept-official.yml");

  assert.match(source, /BACKUP_DIRECTORY:/u);
  assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(source, /retention-days: 30/u);
});

test("README sync opens a new pull request after the previous one was merged", async () => {
  const source = await workflow("sync-community-readme.yml");

  assert.match(source, /gh pr list .*--state open/u);
  assert.doesNotMatch(source, /gh pr view "\$branch"/u);
});
