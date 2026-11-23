import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Text } from "@codemirror/state";
import { packTrace } from "../../src/replay/trace/store.ts";
import { TRACE_FORMAT } from "../../src/replay/trace/types.ts";
import {
  changesBetween,
  documentLines,
  documentText,
} from "../../src/replay/viewer/src/doc-sync.ts";
import { buildModel, splitLines } from "../../src/replay/viewer/src/model.ts";

/** A small trace with an emptied file and a refill, like a truncate-then-write. */
function syntheticTrace() {
  const initial = "a\nb\nc\nd\n";
  const cause = { confidence: "exact", agent: "a1", call: "c1" };
  return {
    header: {
      format: TRACE_FORMAT,
      scenario: { title: "t", task: "t", scope: ["f"] },
      run: { harness: "h", harnessLabel: "H", source: "test", startedAt: "", durationMs: 100 },
      agents: [{ id: "a1", label: "A", harness: "h", startMs: 0, endMs: 100, status: "done" }],
      files: [{ id: "f", path: "f", language: "text", initial: { blob: "x" } }],
    },
    blobs: { x: initial },
    events: [
      {
        kind: "call.start",
        t: 1,
        seq: 1,
        agent: "a1",
        call: "c1",
        tool: "bash",
        category: "shell",
        args: {},
        mutating: true,
      },
      {
        kind: "file.change",
        t: 10,
        seq: 2,
        file: "f",
        version: 1,
        lines: 4,
        sha256: "",
        hunks: [
          { at: 1, remove: 1, removed: ["b"], insert: ["B", "B2"], cause },
          { at: 3, remove: 1, removed: ["d"], insert: [], cause },
        ],
      },
      {
        kind: "file.change",
        t: 20,
        seq: 3,
        file: "f",
        version: 2,
        lines: 0,
        sha256: "",
        hunks: [{ at: 0, remove: 4, removed: ["a", "B", "B2", "c"], insert: [], cause }],
      },
      {
        kind: "file.change",
        t: 30,
        seq: 4,
        file: "f",
        version: 3,
        lines: 3,
        sha256: "",
        hunks: [{ at: 0, remove: 0, removed: [], insert: ["x", "y", "z"], cause }],
      },
      {
        kind: "call.end",
        t: 40,
        seq: 5,
        agent: "a1",
        call: "c1",
        ok: true,
        output: "",
        outputBytes: 0,
      },
    ],
  };
}

function checkFile(trace) {
  const model = buildModel(trace);
  for (const file of model.files) {
    const versions = file.versions;
    // Replaying every change from the initial text must give each version's lines.
    let text = splitLines(trace.blobs[file.info.initial.blob] ?? "");
    for (let version = 1; version <= versions; version++) {
      const next = [];
      let position = 0;
      for (const hunk of file.changes[version - 1].hunks) {
        next.push(...text.slice(position, hunk.at), ...hunk.insert);
        assert.deepEqual(text.slice(hunk.at, hunk.at + hunk.remove), hunk.removed);
        position = hunk.at + hunk.remove;
      }
      next.push(...text.slice(position));
      text = next;
      assert.deepEqual(file.state(version).lines, text, `version ${version}`);
      assert.equal(file.state(version).marks.length, text.length);
    }
    // The editor document follows forward, backward and jumping moves exactly.
    const steps = [
      0,
      ...Array.from({ length: versions }, (_, index) => index + 1),
      versions - 1,
      0,
    ];
    for (let jump = 0; jump < Math.min(30, versions); jump++)
      steps.push((jump * 37) % (versions + 1));
    let doc = Text.of(documentText(file.state(0).lines).split("\n"));
    let shown = 0;
    for (const target of steps) {
      const changes = changesBetween(doc, file.changes, shown, target, Infinity);
      assert.ok(changes, `changes to version ${target}`);
      doc = changes.apply(doc);
      shown = target;
      const lines = file.state(target).lines;
      assert.equal(documentLines(doc), lines.length, `lines at version ${target}`);
      assert.equal(doc.toString(), documentText(lines), `text at version ${target}`);
    }
  }
  return model;
}

test("an emptied and refilled file replays forward and backward", () => {
  const model = checkFile(syntheticTrace());
  const file = model.files[0];
  assert.equal(file.state(2).lines.length, 0);
  assert.deepEqual(file.state(3).lines, ["x", "y", "z"]);
  assert.equal(file.state(3).marks[0]?.call?.id, "c1");
});

// Recorded traces stay private; point REPLAY_TEST_TRACES at a folder of trace directories
// to check that each replays exactly.
const tracesRoot = process.env.REPLAY_TEST_TRACES;
const traces = tracesRoot
  ? readdirSync(tracesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(tracesRoot, entry.name))
  : [];
for (const directory of traces) {
  test(`recorded trace ${path.basename(directory)} replays exactly`, async () => {
    const model = checkFile(await packTrace(directory));
    // Nested calls never get a lane of their own.
    for (const lane of model.laneCalls) for (const call of lane) assert.equal(call.parent, null);
    // Agents sharing a lane never overlap in time.
    for (const a of model.agents)
      for (const b of model.agents)
        if (a !== b && a.lane === b.lane)
          assert.ok(a.info.endMs <= b.info.startMs || b.info.endMs <= a.info.startMs);
  });
}
