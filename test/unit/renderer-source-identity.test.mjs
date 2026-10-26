import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { suiteVerifier } from "../../src/suites/explicit-edit-multi-agent/source-identity.mjs";

test("reference proof identity includes the libclang indexer implementation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-source-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = pathToFileURL(directory + path.sep);
  await writeFile(path.join(directory, "runner.mjs"), "export const version = 1;\n");
  await writeFile(path.join(directory, "indexer.py"), "version = 1\n");
  const before = await suiteVerifier(root);
  await writeFile(path.join(directory, "indexer.py"), "version = 2\n");
  assert.notEqual(await suiteVerifier(root), before);
  const changed = await suiteVerifier(root);
  await writeFile(path.join(directory, "private-report.json"), '{"status":"pass"}\n');
  assert.equal(await suiteVerifier(root), changed);
});
