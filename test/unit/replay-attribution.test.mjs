import assert from "node:assert/strict";
import test from "node:test";
import { mayMutate, observedRanges } from "../../src/replay/adapters/common.ts";
import { Attributor } from "../../src/replay/attribution.ts";
import { isPartialWrite } from "../../src/replay/mixed-probe.ts";
import { applyHunks, lineHunks } from "../../src/replay/trace/diff.ts";

test("line hunks round-trip and stay ordered against the old version", () => {
  const before = ["a", "b", "c", "d", "e", "f"];
  const after = ["a", "B", "c", "e", "x", "y", "f"];
  const hunks = lineHunks(before, after);
  assert.deepEqual(applyHunks(before, hunks), after);
  for (let i = 1; i < hunks.length; i++)
    assert.ok(hunks[i].at >= hunks[i - 1].at + hunks[i - 1].remove);
  for (const hunk of hunks)
    assert.deepEqual(hunk.removed, before.slice(hunk.at, hunk.at + hunk.remove));
  assert.deepEqual(lineHunks(before, before), []);
  assert.deepEqual(applyHunks(before, lineHunks(before, [])), []);
  assert.deepEqual(applyHunks([], lineHunks([], after)), after);
});

test("a bounded diff falls back to one middle hunk", () => {
  const before = Array.from({ length: 200 }, (_, i) => `old ${i}`);
  const after = Array.from({ length: 200 }, (_, i) => `new ${i}`);
  const hunks = lineHunks(["head", ...before, "tail"], ["head", ...after, "tail"], 10);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].at, 1);
  assert.equal(hunks[0].remove, 200);
});

test("attribution: exact, matched, ambiguous and external", () => {
  const attributor = new Attributor([
    {
      agent: "a",
      call: "a:1",
      start: 100,
      end: 200,
      args: { path: "main.cpp", query: "tVec4i", text: "tTVec4i" },
    },
    {
      agent: "b",
      call: "b:1",
      start: 150,
      end: 400,
      args: { path: "main.cpp", text: "void moved_block() {}" },
    },
    { agent: "c", call: "c:1", start: 1000, end: 1100, args: { command: "python3 edit.py" } },
  ]);
  assert.deepEqual(attributor.attribute(120, { removed: ["x"], insert: ["y"] }), {
    confidence: "exact",
    agent: "a",
    call: "a:1",
  });
  const rename = attributor.attribute(180, { removed: ["tVec4i v;"], insert: ["tTVec4i v;"] });
  assert.equal(rename.confidence, "matched");
  assert.equal(rename.call, "a:1");
  const move = attributor.attribute(180, { removed: [], insert: ["void moved_block() {}"] });
  assert.equal(move.confidence, "matched");
  assert.equal(move.agent, "b");
  const unknown = attributor.attribute(180, { removed: ["zzz"], insert: ["qqq"] });
  assert.equal(unknown.confidence, "ambiguous");
  assert.equal(unknown.candidates?.length, 2);
  assert.deepEqual(attributor.attribute(800, { removed: [], insert: ["x"] }), {
    confidence: "external",
  });
  // Recorder latency: a write seen shortly after the result still belongs to the call.
  assert.equal(attributor.attribute(1250, { removed: [], insert: ["x"] }).agent, "c");
});

test("a background write goes to the earlier call whose text it carries", () => {
  const lifetimes = new Map([
    ["a", { start: 0, end: 5000 }],
    ["b", { start: 0, end: 5000 }],
  ]);
  const attributor = new Attributor(
    [
      // a starts a background script and returns; it writes at 3000 while b polls a log.
      {
        agent: "a",
        call: "a:1",
        start: 100,
        end: 200,
        args: { command: "python3 rename.py oldName newNameFn &" },
      },
      {
        agent: "b",
        call: "b:1",
        start: 2900,
        end: 3100,
        args: { command: "sed -i s/x/y/ other.txt" },
      },
    ],
    { lifetimes },
  );
  const rename = { removed: ["int oldName;"], insert: ["int newNameFn;"] };
  const late = attributor.attribute(3000, rename);
  assert.equal(late.confidence, "matched");
  assert.equal(late.agent, "a");
  // Without any running call, the same write is still found.
  assert.equal(attributor.attribute(4000, rename).agent, "a");
  // A write nobody's text names stays with the running call, or external when none runs.
  assert.equal(
    attributor.attribute(3000, { removed: ["q"], insert: ["zzz_unrelated"] }).agent,
    "b",
  );
  assert.equal(
    attributor.attribute(4000, { removed: ["q"], insert: ["zzz_unrelated"] }).confidence,
    "external",
  );
});

const context = { agent: "s1", files: [{ id: "main.cpp", path: "main.cpp" }] };

test("Oh My Pi reads name their ranges in the path and number lines under a hash header", () => {
  assert.deepEqual(observedRanges(context, "read", { path: "main.cpp:2787,2823-2842" }, "x"), [
    {
      file: "main.cpp",
      ranges: [
        [2787, 2787],
        [2823, 2842],
      ],
    },
  ]);
  const grep =
    "[main.cpp#1D5F]\n*7070:struct tVec4i {\n...\n*7092:auto v = tVec4i{};\n7093:};\n[other.h#AB12]\n5:x";
  assert.deepEqual(observedRanges(context, "grep", { pattern: "tVec4i" }, grep), [
    {
      file: "main.cpp",
      ranges: [
        [7070, 7070],
        [7092, 7093],
      ],
    },
  ]);
});

test("Oh My Pi eval scripts count as writing when they edit, write or shell out", () => {
  assert.equal(mayMutate("script", { code: "await tool.edit(patch)" }), true);
  assert.equal(mayMutate("script", { code: "await Bun.write('main.cpp', s)" }), true);
  assert.equal(mayMutate("script", { code: "await sh`sed -i s/a/b/ main.cpp`" }), true);
  assert.equal(
    mayMutate("script", { code: "print(await tool.read({path:'main.cpp:1-5'}))" }),
    false,
  );
});

test("a truncated file read mid-write is a partial write of the version after it", () => {
  const full = { t: 1000, text: "a\nb\nc\n" };
  assert.equal(isPartialWrite({ t: 990, text: "" }, full), true);
  assert.equal(isPartialWrite({ t: 990, text: "a\nb" }, full), true);
  assert.equal(
    isPartialWrite({ t: 500, text: "" }, full),
    false,
    "too long before the next version",
  );
  assert.equal(isPartialWrite({ t: 990, text: "a\nX" }, full), false, "not a prefix");
  assert.equal(isPartialWrite({ t: 990, text: "a\nb\nc\n" }, full), false, "same content");
  assert.equal(isPartialWrite({ t: 990, text: "" }, undefined), false, "last version");
});
