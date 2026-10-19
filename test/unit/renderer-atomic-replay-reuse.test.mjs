import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareAtomicNamingBatch,
  applyAtomicNamingBatch,
  createAtomicNamingReplay,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";

function fixture() {
  const tree = {
    "main.cpp": `#ifdef FEATURE
namespace frond { int sum(int left, int right) { const char* text = "left"; return left + right; } }
#else
namespace frond { int idle() { return 19; } }
#endif
`,
  };
  const batch = prepareAtomicNamingBatch(
    tree,
    [
      ["A", "left", "longLeft"],
      ["B", "right", "r"],
    ].map(([id, from, to]) => ({
      id,
      plan: {
        edits: cppTokens(tree["main.cpp"])
          .filter((token) => token.text === from)
          .map((token) => ({ file: "main.cpp", start: token.start, old: from, new: to })),
      },
    })),
  );
  return { tree, batch };
}

await test("reusing a trusted group baseline keeps every binding selection independent", () => {
  const { tree, batch } = fixture();
  const replay = createAtomicNamingReplay(batch);
  for (const selection of [["A"], ["B"], [], ["A", "B"], ["B", "A"]])
    assert.deepEqual(replay(tree, selection), applyAtomicNamingBatch(tree, batch, selection));
  assert.ok(replay(tree, ["A"]).tree["main.cpp"].includes("return longLeft + right"));
  assert.ok(replay(tree, ["B"]).tree["main.cpp"].includes("return left + r"));
});

await test("clearing trusted replay still reconstructs independent and relocated selections", () => {
  const { tree, batch } = fixture();
  const replay = createAtomicNamingReplay(batch);
  const first = replay(tree, ["A"]);
  replay.clear();
  replay.clear();
  assert.deepEqual(replay(tree, ["A"]), first);
  const moved = { "module.cpp": tree["main.cpp"] };
  replay.clear();
  assert.deepEqual(replay(moved, ["B"]), applyAtomicNamingBatch(moved, batch, ["B"]));
});

await test("mutating the same source object cannot reuse stale protected tokens or offsets", () => {
  const { tree, batch } = fixture();
  const replay = createAtomicNamingReplay(batch);
  replay(tree, ["A"]);
  const original = tree["main.cpp"];
  tree["main.cpp"] = original.replace('"left"', '"changed"');
  assert.throws(() => replay(tree, ["B"]), /missing.*owner/i);
  tree["main.cpp"] = `\n\n${original}`;
  assert.deepEqual(replay(tree, ["B"]), applyAtomicNamingBatch(tree, batch, ["B"]));
  assert.ok(replay(tree, ["B"]).tree["main.cpp"].startsWith("\n\n"));
});

await test("reused baselines rebuild inactive branches and current macro contexts", () => {
  const { tree, batch } = fixture();
  const replay = createAtomicNamingReplay(batch);
  const original = tree["main.cpp"];
  replay(tree, ["A"]);
  tree["main.cpp"] = original.replace("return 19", "return 91");
  const changed = replay(tree, ["B"]);
  assert.ok(changed.tree["main.cpp"].includes("return 91"));
  assert.deepEqual(changed, applyAtomicNamingBatch(tree, batch, ["B"]));
  tree["main.cpp"] = original.replace("FEATURE", "ALTERNATE");
  const context = replay(tree, ["A"]);
  assert.deepEqual(context, applyAtomicNamingBatch(tree, batch, ["A"]));
  assert.notDeepEqual(context.owners[0].conditions, changed.owners[0].conditions);
});

await test("cached opaque owners cannot hide a changed inactive declaration", () => {
  const tree = {
    "main.cpp": `#ifndef COUPLED_H
#define COUPLED_H
#ifdef MODE
int sum(int value,
#else
int sum(double value,
#endif
int other) { return value + other; }
#endif
`,
  };
  const batch = prepareAtomicNamingBatch(tree, [
    {
      id: "value",
      plan: {
        edits: cppTokens(tree["main.cpp"])
          .filter((token) => token.text === "value")
          .map((token) => ({ file: "main.cpp", start: token.start, old: "value", new: "renamed" })),
      },
    },
  ]);
  assert.equal(batch.owners[0].opaque, true);
  const replay = createAtomicNamingReplay(batch);
  replay(tree, ["value"]);
  tree["main.cpp"] = tree["main.cpp"].replace("double value", "float value");
  assert.throws(() => replay(tree, ["value"]), /missing.*owner/i);
});
await test("file relocation and additional physical copies invalidate the previous owner inventory", () => {
  const { tree, batch } = fixture();
  const replay = createAtomicNamingReplay(batch);
  const source = tree["main.cpp"];
  replay(tree, ["A"]);
  delete tree["main.cpp"];
  tree["module.cpp"] = source;
  const moved = replay(tree, ["B"]);
  assert.equal(moved.owners[0].file, "module.cpp");
  assert.deepEqual(Object.keys(moved.tree), ["module.cpp"]);
  tree["copy.cpp"] = source;
  assert.throws(() => replay(tree, ["A"]), /ambiguous.*owner/i);
  delete tree["copy.cpp"];
  assert.deepEqual(replay(tree, ["A"]), applyAtomicNamingBatch(tree, batch, ["A"]));
});

await test("changing peer files preserves current context and complete owner inventories", () => {
  const { tree, batch } = fixture();
  tree["peer.cpp"] = "// retained\nint peer(int);\nint peer(int);\n";
  const replay = createAtomicNamingReplay(batch);
  replay(tree, ["A"]);
  tree["peer.cpp"] = "#if OTHER\nint peer(double);\n#else\nint peer(int);\n#endif\n";
  assert.deepEqual(replay(tree, ["B"]), applyAtomicNamingBatch(tree, batch, ["B"]));
  tree["peer.cpp"] = "int malformed(";
  assert.throws(() => replay(tree, ["A"]));
  tree["peer.cpp"] = "int recovered;\n";
  assert.deepEqual(replay(tree, ["A"]), applyAtomicNamingBatch(tree, batch, ["A"]));
  const reordered = Object.fromEntries(Object.entries(tree).reverse());
  assert.deepEqual(replay(reordered, ["B"]), applyAtomicNamingBatch(reordered, batch, ["B"]));
  delete tree["peer.cpp"];
  assert.deepEqual(replay(tree, ["A", "B"]), applyAtomicNamingBatch(tree, batch, ["A", "B"]));
  replay.clear();
  assert.deepEqual(replay(tree, ["B"]), applyAtomicNamingBatch(tree, batch, ["B"]));
});

await test("a warm baseline still validates selections and every private batch field", () => {
  const { tree, batch } = fixture();
  const replay = createAtomicNamingReplay(batch);
  replay(tree, ["A"]);
  assert.throws(() => replay(tree, ["unknown"]), /unknown.*binding/i);
  assert.throws(() => replay(tree), /selection/i);
  const tokens = batch.owners[0].tokens;
  batch.owners[0].tokens = [...tokens, "unexpected"];
  assert.throws(() => replay(tree, ["B"]), /fingerprint/i);
  batch.owners[0].tokens = tokens;
  const site = batch.owners[0].sites[0];
  const index = site.index;
  site.index = tokens.length;
  assert.throws(() => replay(tree, ["B"]), /slot/i);
  site.index = index;
  batch.version = "unsupported";
  assert.throws(() => replay(tree, ["B"]), /unsupported/i);
});

await test("mutating a returned frontier cannot poison the private reusable baseline", () => {
  const { tree, batch } = fixture();
  const replay = createAtomicNamingReplay(batch);
  const result = replay(tree, ["A"]);
  result.tree["main.cpp"] = "corrupt";
  result.owners[0].tokens[0] = "corrupt";
  result.owners[0].conditions[0][0] = "corrupt";
  result.owners[0].sites[0].to = "corrupt";
  result.owners[0].sites.push({ nodeId: "unknown", index: 0, from: "int", to: "corrupt" });
  assert.deepEqual(replay(tree, ["A"]), applyAtomicNamingBatch(tree, batch, ["A"]));
  assert.deepEqual(replay(tree, ["B"]), applyAtomicNamingBatch(tree, batch, ["B"]));
});
