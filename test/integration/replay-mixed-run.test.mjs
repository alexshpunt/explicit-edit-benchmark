import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replayMixedRun } from "../../src/replay/cli.ts";
import { readTrace } from "../../src/replay/trace/store.ts";

// Stands in for mixed-run without model calls: one agent replaces a line of main.cpp
// while its tool call runs, then the controller writes the run report.
const FAKE_RUN = `
const fs = require("node:fs");
const path = require("node:path");
const run = process.argv[1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = path.join(run, "mixed", "session-1-events.jsonl");
const emit = (event) => fs.appendFileSync(events, JSON.stringify(event) + "\\n");
(async () => {
  fs.mkdirSync(path.join(run, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(run, "mixed"), { recursive: true });
  fs.writeFileSync(path.join(run, "workspace", "main.cpp"), "int a;\\nint oldName;\\n");
  await sleep(150);
  const started = new Date().toISOString();
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Rename oldName to newName." }], timestamp: Date.now() } });
  await sleep(150);
  const args = { path: "main.cpp", text: "newName" };
  emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "replace", args });
  await sleep(150);
  fs.writeFileSync(path.join(run, "workspace", "main.cpp"), "int a;\\nint newName;\\n");
  await sleep(150);
  emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "replace", result: { content: [{ type: "text", text: "Applied." }] }, isError: false });
  await sleep(150);
  emit({ type: "agent_settled", aborted: false });
  const ended = new Date().toISOString();
  const deliveries = [{ phase: "mixed", id: "rename-unique-oldName", file: null, units: null, session: 1, status: "settled", started, ended }];
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify({ identity: { harness: "baseline-agent" }, deliveries }));
})();
`;

test("a recorded mixed run becomes a trace and a self-contained page", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replay-mixed-run-"));
  try {
    const run = path.join(root, "run");
    const out = path.join(root, "replay");
    const code = await replayMixedRun(out, run, [process.execPath, "-e", FAKE_RUN, run]);
    assert.equal(code, 0);
    const { header, events } = await readTrace(path.join(out, "trace"));
    assert.equal(header.run.harnessLabel, "Pi, Bash only");
    const changes = events.filter((event) => event.kind === "file.change");
    assert.equal(changes.length, 1);
    assert.deepEqual(
      changes[0].hunks.map((hunk) => [hunk.removed, hunk.insert, hunk.cause.call]),
      [[["int oldName;"], ["int newName;"], "s1:c1"]],
    );
    const page = await readFile(path.join(out, "replay.html"), "utf8");
    assert.match(
      page,
      /<script id="agent-replay-trace" type="application\/gzip\+base64">\S+<\/script>/,
    );
    assert.doesNotMatch(page, /<script[^>]+src=|<link[^>]+href=/, "the page loads nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
