import assert from "node:assert/strict";
import test from "node:test";
import {
  markSources,
  removeSourceMarkers,
} from "../../src/suites/explicit-edit-multi-agent/extraction/flat-source-markers.mjs";

test("source markers identify complete fragments without changing their code", () => {
  const source = "head\n#define X 1\nint f() { return X; }\n";
  const fragments = ["#define X 1\n", "int f() { return X; }\n"].map((text, i) => ({
    id: `x${i}`,
    start: source.indexOf(text),
    end: source.indexOf(text) + text.length,
    text,
  }));
  const marked = markSources({ tasks: [{ fragments }] }, { "main.cpp": source });
  for (const fragment of fragments)
    assert.ok(
      marked.tree["main.cpp"].includes(marked.sourceMarkers.get(fragment.id) + fragment.text),
    );
  assert.equal(removeSourceMarkers(marked.tree["main.cpp"], marked.sourceMarkers), source);
  assert.throws(() =>
    markSources({ tasks: [{ fragments: [fragments[0], fragments[0]] }] }, { "main.cpp": source }),
  );
});

test("cleanup removes issued comments but preserves matching string contents and unrelated comments", () => {
  const marker = "/* EES00000 */";
  const source = `${marker}int x;\nconst char *s = "${marker}";\n/* another marker */\n`;
  assert.equal(
    removeSourceMarkers(source, new Map([["x", marker]])),
    `int x;\nconst char *s = "${marker}";\n/* another marker */\n`,
  );
});
