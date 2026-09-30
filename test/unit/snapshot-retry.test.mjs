import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadSnapshotWithRetry } from "../../scripts/snapshot-retry.mjs";

const params = () => ({
  repo: { type: "dataset", name: "owner/dataset" },
  revision: "a".repeat(40),
  cacheDir: "cache",
});
const socketError = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });

test("snapshot retries resume the same pinned cache after a transport or stream failure", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "snapshot-retry-"));
  try {
    const options = { ...params(), cacheDir };
    let calls = 0;
    const waits = [];
    const hub = {
      async snapshotDownload(received) {
        assert.equal(received, options);
        calls++;
        if (calls === 1) {
          await writeFile(path.join(cacheDir, "completed-blob"), "verified bytes");
          throw socketError();
        }
        assert.equal(
          await readFile(path.join(cacheDir, "completed-blob"), "utf8"),
          "verified bytes",
        );
        return "snapshot";
      },
    };
    assert.equal(
      await downloadSnapshotWithRetry(hub, options, {
        wait: async (ms) => {
          waits.push(ms);
        },
      }),
      "snapshot",
    );
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1000]);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("snapshot retries are bounded and retain the final transport error", async () => {
  const error = socketError();
  let calls = 0;
  const hub = {
    async snapshotDownload() {
      calls++;
      throw error;
    },
  };
  await assert.rejects(
    downloadSnapshotWithRetry(hub, params(), { wait: async () => {} }),
    (caught) => caught === error,
  );
  assert.equal(calls, 3);
});

test("authorization, validation and cancellation errors are not retried", async () => {
  for (const error of [
    Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
    new Error("Invalid source"),
    Object.assign(new Error("Cancelled"), { name: "AbortError" }),
  ]) {
    let calls = 0;
    const hub = {
      async snapshotDownload() {
        calls++;
        throw error;
      },
    };
    await assert.rejects(downloadSnapshotWithRetry(hub, params()), (caught) => caught === error);
    assert.equal(calls, 1);
  }
});

test("snapshot retry requires a pinned revision before making a request", async () => {
  let calls = 0;
  const hub = {
    async snapshotDownload() {
      calls++;
    },
  };
  await assert.rejects(
    downloadSnapshotWithRetry(hub, { ...params(), revision: "main" }),
    /pinned/u,
  );
  assert.equal(calls, 0);
});
