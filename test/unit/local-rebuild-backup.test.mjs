import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preserveDatasetSnapshot } from "../../scripts/official-acceptance.mjs";

test("local rebuild backups are complete and never replace an earlier copy", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dataset-backup-test-"));
  const snapshot = path.join(temporary, "snapshot");
  const backups = path.join(temporary, "backups");
  const now = new Date("2026-09-29T12:34:56.789Z");
  await mkdir(snapshot);
  await writeFile(path.join(snapshot, "dataset-index.json"), "first snapshot\n");

  try {
    const first = await preserveDatasetSnapshot(snapshot, backups, "abcdef1234567890", now);
    await writeFile(path.join(snapshot, "dataset-index.json"), "second snapshot\n");
    const second = await preserveDatasetSnapshot(snapshot, backups, "abcdef1234567890", now);

    assert.equal(path.basename(first), "2026-09-29T12-34-56-789Z-abcdef123456");
    assert.equal(path.basename(second), "2026-09-29T12-34-56-789Z-abcdef123456-2");
    assert.equal(
      await readFile(path.join(first, "dataset-index.json"), "utf8"),
      "first snapshot\n",
    );
    assert.equal(
      await readFile(path.join(second, "dataset-index.json"), "utf8"),
      "second snapshot\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
