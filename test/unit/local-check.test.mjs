import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the local check retains code validation without hosted GitHub pin verification", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(scripts.check.split(/\s*&&\s*/u), [
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run test:integration",
  ]);
  assert.equal(scripts["check:pins"], "node scripts/check-workflow-pins.mjs");
});
