import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");

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
