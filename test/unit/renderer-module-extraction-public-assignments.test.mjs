import test from "node:test";
import assert from "node:assert/strict";
import {
  publicExplicitAssignments,
  publicSymbolAssignments,
} from "../../src/suites/explicit-edit-multi-agent/extraction/public-assignments.mjs";

test("explicit assignments combine public entities and file obligations", async () => {
  const source = "int first;\n";
  const task = {
    id: "file-1",
    file: "a.cpp",
    kind: "implementation",
    preamble: "",
    postamble: "",
    using: [],
    replacement: "",
    destination: source,
    fragments: [
      {
        id: "fragment-1",
        start: 0,
        end: source.length,
        text: source,
        scope: "",
        kind: "declaration",
      },
    ],
  };
  const spec = (
    await publicExplicitAssignments({ initial: { "main.cpp": source }, tasks: [task] })
  ).get(task.id);
  assert.equal(spec.entities[0].signature, "int first");
  assert.deepEqual(spec.contract.preamble, []);
  assert.deepEqual(spec.hints, []);
});

test("explicit assignments include exact anchors for competing copied macro payloads", async () => {
  const preamble = "#define A 1\n#define A 2\n";
  const body = "int first;\n";
  const source = preamble + body;
  const task = {
    id: "file-1",
    file: "a.cpp",
    kind: "implementation",
    preamble,
    postamble: "",
    using: [],
    replacement: "",
    destination: source,
    fragments: [
      {
        id: "fragment-1",
        start: preamble.length,
        end: source.length,
        text: body,
        scope: "",
        kind: "declaration",
      },
    ],
  };
  const assignment = (
    await publicExplicitAssignments({ initial: { "main.cpp": source }, tasks: [task] })
  ).get(task.id);
  assert.match(assignment.hints.join("\n"), /#define A 1/);
  assert.match(assignment.hints.join("\n"), /#define A 2/);
  assert.match(assignment.hints.join("\n"), /snapshot line/);
});

test("explicit assignments disambiguate matching signatures with exact source fragments", async () => {
  const fragments = ["int f(){ return 11; }\n", "int f(){ return 22; }\n"];
  const source = fragments.join("");
  const tasks = fragments.map((body, index) => ({
    id: `file-${index}`,
    file: `f${index}.cpp`,
    kind: "implementation",
    preamble: "",
    postamble: "",
    using: [],
    replacement: "",
    destination: body,
    fragments: [
      {
        id: `fragment-${index}`,
        start: source.indexOf(body),
        end: source.indexOf(body) + body.length,
        text: body,
        scope: "",
        kind: "declaration",
      },
    ],
  }));
  const assignments = await publicExplicitAssignments({ initial: { "main.cpp": source }, tasks });
  for (let index = 0; index < tasks.length; index++) {
    const hint = assignments.get(tasks[index].id).hints.join("\n");
    assert.ok(hint.includes(fragments[index].trim()));
    assert.match(hint, /snapshot line/);
  }
});

test("explicit assignments distinguish identical definitions using unique surrounding context", async () => {
  const body = "int f(){ return 11; }\n";
  const source = body + body;
  const tasks = [0, 1].map((index) => ({
    id: `file-${index}`,
    file: `f${index}.cpp`,
    kind: "implementation",
    preamble: "",
    postamble: "",
    using: [],
    replacement: "",
    destination: body,
    fragments: [
      {
        id: `fragment-${index}`,
        start: index * body.length,
        end: (index + 1) * body.length,
        text: body,
        scope: "",
        kind: "declaration",
      },
    ],
  }));
  const assignments = await publicExplicitAssignments({ initial: { "main.cpp": source }, tasks });
  assert.match(assignments.get(tasks[0].id).hints.join("\n"), /starts 0 JavaScript UTF-16/);
  assert.match(
    assignments.get(tasks[1].id).hints.join("\n"),
    new RegExp(`starts ${body.length} JavaScript UTF-16`),
  );
});

test("explicit assignments retain repeated definitions inside one owned fragment", async () => {
  const body = "#if A\nint f(){ return 1; }\n#else\nint f(){ return 2; }\n#endif\n";
  const task = {
    id: "file-1",
    file: "a.cpp",
    kind: "implementation",
    preamble: "",
    postamble: "",
    using: [],
    replacement: "",
    destination: body,
    fragments: [
      { id: "fragment-1", start: 0, end: body.length, text: body, scope: "", kind: "conditional" },
    ],
  };
  const spec = (
    await publicExplicitAssignments({ initial: { "main.cpp": body }, tasks: [task] })
  ).get(task.id);
  assert.equal(spec.entities[0].occurrences, 2);
  assert.match(spec.hints.join("\n"), /return 1/);
  assert.match(spec.hints.join("\n"), /return 2/);
});

test("explicit assignments anchor repeated macros inside one conditional fragment", async () => {
  const body = "#if A\n#define X 1\n#define X 2\n#endif\n";
  const task = {
    id: "file-1",
    file: "a.cpp",
    kind: "implementation",
    preamble: "",
    postamble: "",
    using: [],
    replacement: "",
    destination: body,
    fragments: [
      { id: "fragment-1", start: 0, end: body.length, text: body, scope: "", kind: "conditional" },
    ],
  };
  const spec = (
    await publicExplicitAssignments({ initial: { "main.cpp": body }, tasks: [task] })
  ).get(task.id);
  assert.equal(spec.entities.find((entity) => entity.signature === "X").occurrences, 2);
  assert.match(spec.hints.join("\n"), /#define X 1/);
  assert.match(spec.hints.join("\n"), /#define X 2/);
});

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

test("new assignments count copied imports as they appear in the destination", async () => {
  const task = {
    id: "file-1",
    file: "a.cpp",
    kind: "implementation",
    fragments: [{ scope: "sample", kind: "declaration", text: "int alpha();" }],
    using: [
      { scope: "sample", text: "using std::vector;" },
      { scope: "sample", text: "using std::vector;" },
    ],
  };
  const specs = (await publicSymbolAssignments({ tasks: [task] }, { deduplicateCopies: true })).get(
    task.id,
  );
  assert.deepEqual(
    specs.find((item) => item.action === "copy"),
    { scope: "sample", kind: "using", signature: "using std::vector;", action: "copy" },
  );
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
