import test from "node:test";
import assert from "node:assert/strict";
import { publicSymbolAssignments } from "../../src/suites/explicit-edit-multi-agent/extraction/public-assignments.mjs";

test("repeated owned declarations retain counts and copied using declarations are separate", async () => {
  const make = (text) => ({ text, scope: "sample", kind: "declaration" });
  const task = {
    id: "file-1",
    file: "a.h",
    kind: "header",
    fragments: [make("int same(int n);"), make("int same(int n);"), make("int alpha();")],
    using: [{ scope: "sample", text: "using std::vector;" }],
  };
  const specs = (await publicSymbolAssignments({ tasks: [task] })).get(task.id);
  assert.deepEqual(
    specs.find((x) => x.signature === "int same(int n)"),
    { scope: "sample", kind: "function-declaration", signature: "int same(int n)", occurrences: 2 },
  );
  assert.deepEqual(
    specs.find((x) => x.signature === "using std::vector;"),
    { scope: "sample", kind: "using", signature: "using std::vector;", action: "copy" },
  );
  const reordered = { ...task, fragments: [...task.fragments].reverse() };
  assert.deepEqual((await publicSymbolAssignments({ tasks: [reordered] })).get(task.id), specs);
});

test("indistinguishable definitions assigned to different files are rejected", async () => {
  const task = (id, text) => ({
    id,
    file: `${id}.cpp`,
    kind: "implementation",
    fragments: [{ text, scope: "demo", kind: "declaration" }],
  });
  await assert.rejects(
    publicSymbolAssignments({
      tasks: [
        task("a", "int same(int x) { return x + 1; }"),
        task("b", "int same(int x) { return x + 2; }"),
      ],
    }),
  );
});
