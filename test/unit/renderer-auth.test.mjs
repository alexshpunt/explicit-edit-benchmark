import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { prepareAuth } from "../../scripts/multi-agent/experiments/prepare-auth.mjs";

test("run authentication contains only the selected OAuth slot, stays private and cannot overwrite existing credentials", async () => {
  const root = await mkdtemp(path.resolve(".tmp/renderer-auth-"));
  try {
    const source = path.join(root, "source.json");
    const target = path.join(root, "run", "auth.json");
    const selected = {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 123,
    };
    const all = { "openai-codex": selected, other: { type: "api_key", key: "fixture-other" } };
    await writeFile(source, JSON.stringify(all));
    const receipt = await prepareAuth(source, target, "openai-codex");
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { "openai-codex": selected });
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), all);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
    assert.match(receipt.sourceSha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(receipt).includes("fixture"));
    await assert.rejects(prepareAuth(source, target, "openai-codex"), { code: "EEXIST" });
    await assert.rejects(prepareAuth(source, path.join(root, "other.json"), "other"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
