import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runSnapshotQueue,
  sameText,
} from "../../src/suites/explicit-edit-multi-agent/extraction/snapshot-run.mjs";

// Each task appends its own line; the snapshot of a set lists the finished tasks in order.
const ids = ["move-1", "move-2", "move-3", "move-4"];
const probe = {
  queue: ids.map((id) => ({
    id,
    task: "move",
    prompt: `Several agents are editing main.cpp at the same time. Add ${id}.`,
  })),
  snapshot: (done) => ["start", ...ids.filter((id) => done.has(id))].join("\n") + "\n",
};

function pool(root, wrong = new Set()) {
  const seen = [];
  return {
    seen,
    async createDriver(session) {
      const workspace = path.join(root, `session-${session}`);
      await mkdir(workspace, { recursive: true });
      return { workspace, async terminate() {} };
    },
    async execute(driver, prompt, { entry, expected }) {
      const file = path.join(driver.workspace, "main.cpp");
      const base = await readFile(file, "utf8");
      seen.push({ id: entry.id, base, prompt });
      await writeFile(file, wrong.has(entry.id) ? base : expected);
      return { status: "settled" };
    },
    usage: () => null,
    async cleanup() {},
  };
}

test("copies start from the reference state of finished tasks and are checked exactly", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "snapshot-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const participants = pool(root, new Set(["move-2"]));
  const run = await runSnapshotQueue({ probe, output: root, pool: participants, agents: 1 });
  assert.deepEqual(
    run.rows.map(({ id, passed }) => [id, passed]),
    [
      ["move-1", true],
      ["move-2", false],
      ["move-3", true],
      ["move-4", true],
    ],
  );
  // A failed task still joins the shared state as its reference result.
  assert.equal(participants.seen[2].base, "start\nmove-1\nmove-2\n");
  assert.ok(participants.seen.every(({ prompt }) => !prompt.includes("at the same time")));
  assert.equal(run.agents, 1);
});

test("blank lines and spaces at line ends are not compared", () => {
  assert.ok(sameText("a\n\n  b  \n", "a\n  b\n"));
  assert.ok(!sameText("a\n b\n", "a\nb\n"));
});
