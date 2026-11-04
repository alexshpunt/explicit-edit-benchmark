import assert from "node:assert/strict";
import test from "node:test";
import {
  currentBatchAnchors,
  projectedSource,
} from "../../src/suites/explicit-edit-multi-agent/extraction/flat-batch-live.mjs";

test("preinserted replacement is not inserted a second time", () => {
  const initial = '#include "x.h"\nint a;\n';
  const start = initial.indexOf("int a;");
  const task = {
    preinsertedReplacement: true,
    replacement: '#include "x.h"\n',
    fragments: [{ id: "a", start, end: start + 6 }],
  };
  const projection = projectedSource(
    { initial: { "main.cpp": initial }, tasks: [task] },
    new Set(["a"]),
  );
  assert.equal(projection.source, '#include "x.h"\n\n');
});
test("updated context follows completed removals and rejects altered or duplicate context", () => {
  const initial = "start\nint a;\nint b;\nint b;\nend\n";
  const fa = {
    id: "a",
    start: initial.indexOf("int a;"),
    end: initial.indexOf("int a;") + 6,
    text: "int a;",
  };
  const fb = {
    id: "b",
    start: initial.indexOf("int b;"),
    end: initial.indexOf("int b;") + 6,
    text: "int b;",
    isolatedAnchor: { context: initial, offset: initial.indexOf("int b;") },
  };
  const task = { fragments: [fa, fb], replacement: '#include "x.h"\n' };
  const current = initial.replace("int a;", '#include "x.h"\n');
  const [anchored] = currentBatchAnchors(
    initial,
    current,
    task,
    { fragments: [fb] },
    new Set(["a"]),
    { source: current, edits: [{ start: fa.start, end: fa.end, text: task.replacement }] },
  );
  assert.equal(anchored.isolatedAnchor.context, current);
  assert.equal(
    anchored.isolatedAnchor.context.slice(
      anchored.isolatedAnchor.offset,
      anchored.isolatedAnchor.offset + 6,
    ),
    "int b;",
  );
  assert.throws(() =>
    currentBatchAnchors(
      initial,
      current.replace("start", "changed"),
      task,
      { fragments: [fb] },
      new Set(["a"]),
    ),
  );
  assert.throws(() =>
    currentBatchAnchors(initial, current + current, task, { fragments: [fb] }, new Set(["a"])),
  );
});

test("reidentification uses a unique live context only when the complete projection matches", () => {
  const initial = "A\nint x;\nB\nint x;\n";
  const removed = { id: "removed", start: 0, end: 2, text: "A\n" };
  const target = {
    id: "target",
    start: 2,
    end: 8,
    text: "int x;",
    isolatedAnchor: { context: "A\nint x;\n", offset: 2 },
  };
  const other = { id: "other", replacement: "", fragments: [removed, target] };
  const live = initial.slice(2);
  const projection = projectedSource(
    { initial: { "main.cpp": initial }, tasks: [other] },
    new Set(["removed"]),
  );
  const [rebuilt] = currentBatchAnchors(
    initial,
    live,
    other,
    { fragments: [target] },
    new Set(["removed"]),
    projection,
  );
  assert.equal(
    live.indexOf(rebuilt.isolatedAnchor.context),
    live.lastIndexOf(rebuilt.isolatedAnchor.context),
  );
  assert.equal(
    rebuilt.isolatedAnchor.context.slice(
      rebuilt.isolatedAnchor.offset,
      rebuilt.isolatedAnchor.offset + target.text.length,
    ),
    target.text,
  );
  assert.throws(() =>
    currentBatchAnchors(
      initial,
      live + "changed",
      other,
      { fragments: [target] },
      new Set(["removed"]),
      projection,
    ),
  );
});
