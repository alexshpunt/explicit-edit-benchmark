import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { importMixedProbe } from "../../src/replay/mixed-probe.ts";
import { startRecorder } from "../../src/replay/record.ts";
import { readTrace, sha256 } from "../../src/replay/trace/store.ts";

const T = Date.parse("2026-11-23T10:00:00.000Z");
const GENERAL = "Work autonomously.\nFollow the rules.\n";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function session(prompt, call, tool, args, output) {
  return [
    { type: "agent_start" },
    {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: GENERAL + prompt }], timestamp: 0 },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: call, name: tool, arguments: args }],
        timestamp: 0,
      },
    },
    { type: "tool_execution_start", toolCallId: call, toolName: tool, args },
    {
      type: "tool_execution_end",
      toolCallId: call,
      toolName: tool,
      result: { content: [{ type: "text", text: output }] },
      isError: false,
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 0 },
    },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled", aborted: false },
  ];
}

test("imports a mixed-probe run with its recording", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replay-mixed-"));
  try {
    const run = path.join(root, "run");
    const recording = path.join(root, "recording");
    await mkdir(path.join(run, "mixed"), { recursive: true });
    await mkdir(path.join(recording, "blobs"), { recursive: true });
    const deliveries = [
      {
        phase: "mixed",
        id: "rename-unique-oldName",
        file: null,
        session: 1,
        units: null,
        status: "settled",
        started: new Date(T).toISOString(),
        ended: new Date(T + 5000).toISOString(),
        receipt: { model: "m", version: "1.6.0", usage: { input: 1, output: 2 } },
      },
      {
        phase: "mixed",
        id: "extract-001-batch-1",
        file: "src/math.h",
        session: 2,
        units: 2,
        status: "settled",
        started: new Date(T + 100).toISOString(),
        ended: new Date(T + 6000).toISOString(),
        receipt: { model: "m", version: "1.6.0" },
      },
    ];
    await writeFile(
      path.join(run, "report.json"),
      JSON.stringify({ identity: { harness: "pi-agent-ide-codemode-no-bash" }, deliveries }),
    );
    const streams = [];
    const sessions = [
      session(
        "Rename oldName to newName.",
        "c1",
        "replace",
        { path: "SEARCH#1:all:match", text: "newName" },
        "Applied 2 replacements.",
      ),
      session(
        "Move two blocks to src/math.h.",
        "c2",
        "read",
        { path: "main.cpp", offset: 2, limit: 2 },
        "int oldName;\nint b;",
      ),
    ];
    // Line arrival times: session 1 calls replace at +1000..+2000, session 2 reads at +1500..+1600.
    const times = [
      [T + 10, T + 20, T + 900, T + 1000, T + 2000, T + 2100, T + 4000, T + 4000],
      [T + 110, T + 120, T + 1400, T + 1500, T + 1600, T + 1700, T + 5000, T + 5000],
    ];
    for (const [index, events] of sessions.entries()) {
      const file = path.join(run, "mixed", `session-${index + 1}-events.jsonl`);
      let size = 0;
      const lines = events.map((event) => JSON.stringify(event) + "\n");
      await writeFile(file, lines.join(""));
      for (const [i, line] of lines.entries()) {
        size += Buffer.byteLength(line);
        streams.push(JSON.stringify({ t: times[index][i], file, size }));
      }
    }
    await writeFile(path.join(recording, "streams.jsonl"), streams.join("\n") + "\n");
    const contents = [
      [T - 500, "int a;\nint oldName;\nint b;\nvoid f() { oldName = 1; }\n"],
      [T + 1800, "int a;\nint newName;\nint b;\nvoid f() { newName = 1; }\n"],
      [T + 7000, "int a;\nint newName;\nint b;\nvoid f() { newName = 1; }\n// cleanup\n"],
    ];
    const versions = [];
    for (const [t, text] of contents) {
      const hash = sha256(text);
      await writeFile(path.join(recording, "blobs", `${hash}.gz`), gzipSync(text));
      versions.push(JSON.stringify({ t, file: "x", sha256: hash, bytes: text.length }));
    }
    await writeFile(path.join(recording, "versions.jsonl"), versions.join("\n") + "\n");

    const out = path.join(root, "trace");
    const summary = await importMixedProbe(run, { recording, out });
    assert.equal(summary.agents, 2);
    // The controller's change after the last agent is not part of the trace.
    assert.equal(summary.changes, 1);
    const { header, events } = await readTrace(out);
    assert.deepEqual(
      header.agents.map((agent) => agent.label),
      ["Rename oldName", "Move 2 blocks to math.h"],
    );
    assert.equal(header.agents[0].task, "Rename oldName to newName.");
    assert.equal(header.run.harnessLabel, "Pi Agent IDE");
    const change = events.find((event) => event.kind === "file.change");
    assert.equal(change?.t, 1800);
    assert.deepEqual(
      change.hunks.map((hunk) => [hunk.at, hunk.cause.confidence, hunk.cause.call]),
      [
        [1, "exact", "s1:c1"],
        [3, "exact", "s1:c1"],
      ],
    );
    const read = events.find((event) => event.kind === "call.start" && event.agent === "s2");
    assert.equal(read?.t, 1500);
    assert.equal(read.mutating, false);
    const observe = events.find((event) => event.kind === "observe");
    assert.deepEqual(observe?.ranges, [[2, 3]]);
    const prompt = events.find((event) => event.kind === "message" && event.role === "user");
    assert.equal(prompt?.text, "Rename oldName to newName.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records in-place writes, atomic renames and stream growth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replay-recorder-"));
  try {
    const workspace = path.join(root, "workspace");
    const logs = path.join(root, "logs");
    const out = path.join(root, "recording");
    const file = path.join(workspace, "main.cpp");
    const recorder = await startRecorder({
      out,
      files: [file],
      streams: [{ directory: logs, pattern: /^session-\d+-events\.jsonl$/ }],
    });
    // The workspace appears after the recorder starts, as in a real run.
    await sleep(30);
    await mkdir(workspace);
    await mkdir(logs);
    await writeFile(file, "a\nb\n");
    await sleep(40);
    await writeFile(file, "a\nB\n");
    await sleep(40);
    await writeFile(path.join(workspace, ".tmp-x"), "a\nB\nc\n");
    await rename(path.join(workspace, ".tmp-x"), file);
    await sleep(40);
    await writeFile(file, "a\nB\nc\n"); // same content: no new version
    await appendFile(path.join(logs, "session-1-events.jsonl"), "{}\n");
    await sleep(80);
    await appendFile(path.join(logs, "session-1-events.jsonl"), "{}\n");
    await appendFile(path.join(logs, "other.txt"), "x");
    const counts = await recorder.stop();

    const versions = (await readFile(path.join(out, "versions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const contents = await Promise.all(
      versions.map(async (version) =>
        gunzipSync(await readFile(path.join(out, "blobs", `${version.sha256}.gz`))).toString(),
      ),
    );
    assert.deepEqual(contents, ["a\nb\n", "a\nB\n", "a\nB\nc\n"]);
    assert.equal(counts.versions, 3);
    assert.ok(versions.every((version, i) => i === 0 || version.t >= versions[i - 1].t));
    const streams = (await readFile(path.join(out, "streams.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      streams.map((stream) => [path.basename(stream.file), stream.size]),
      [
        ["session-1-events.jsonl", 3],
        ["session-1-events.jsonl", 6],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
