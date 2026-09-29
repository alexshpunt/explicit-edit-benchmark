import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceExitCode,
  localRebuildBackupRoot,
  rebuildBackupRoot,
} from "../../scripts/official-acceptance-cli.mjs";

const rejected = { rejected: [{ candidate: 61, code: "invalid-contract" }] };

test("local rebuilds use durable backups outside the repository", () => {
  assert.equal(
    localRebuildBackupRoot({ homeDirectory: "/home/operator", environment: {} }),
    "/home/operator/.local/share/explicit-edit-benchmark/backups",
  );
  assert.equal(
    localRebuildBackupRoot({
      homeDirectory: "/home/operator",
      environment: { DATASET_BACKUP_ROOT: "/mnt/backups" },
    }),
    "/mnt/backups",
  );
});

test("local rebuilds accept an explicit backup root", () => {
  assert.equal(rebuildBackupRoot(["--backup-root", "/mnt/archive"]), "/mnt/archive");
  assert.throws(() => rebuildBackupRoot(["--other"]), /Usage/);
});

test("scheduled acceptance reports candidate rejection without failing the batch", () => {
  assert.equal(acceptanceExitCode("poll", rejected), 0);
});

test("explicit acceptance fails when its requested candidate is rejected", () => {
  assert.equal(acceptanceExitCode("accept", rejected), 1);
  assert.equal(acceptanceExitCode("accept", { rejected: [] }), 0);
});
