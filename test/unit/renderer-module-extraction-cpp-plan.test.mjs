import assert from "node:assert/strict";
import test from "node:test";
import { implementationTasks } from "../../src/suites/explicit-edit-multi-agent/extraction/cpp-plan.mjs";
import { cppStructure } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-structure.mjs";
import { includeDirectives } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

function fixture() {
  const entries = [
    [
      "frond_a.cpp",
      "#include <vector>\n#ifdef FROND_EXTERNAL\n#include <not_installed.h>\n#endif\n",
    ],
    ["frond_b.cpp", "#include <string>\n"],
    ["frond_a.cpp", "namespace frond {\n"],
    ["frond_b.cpp", "using std::string;\n"],
    ["frond_a.cpp", "using std::vector;\n"],
    ["frond_b.cpp", "int current_b();\n", "generated-declaration"],
    ["frond_a.cpp", "// preserve this standalone comment 🐛\n"],
    ["frond_a.cpp", "int current_a();\n", "generated-declaration"],
    ["frond_a.cpp", "using CurrentAlias = int;\n"],
    ["frond_a.cpp", "#define CURRENT_CONSTANT 3\n"],
    ["frond_b.cpp", "int current_b() { return 2; }\n"],
    ["frond_a.cpp", ";\n"],
    ["frond_a.cpp", "#if 0\nint inactive_a() { return 99; }\n#endif\n"],
    [
      "frond_a.cpp",
      "int current_a() { vector<CurrentAlias> values{CURRENT_CONSTANT}; return values[0]; }\n",
    ],
    ["frond_a.cpp", "}\n"],
    [
      "frond_a.cpp",
      'static const char* data_a = R"tag(// not a comment\n\n#not_a_directive)tag";\n',
    ],
  ];
  let offset = 0;
  const runs = entries.map(([file, text, role = "source"]) => {
    const start = offset;
    offset += text.length;
    return { file, originalFile: file.replace("frond_", "yocto_"), role, text, start, end: offset };
  });
  const initial = { "main.cpp": runs.map((run) => run.text).join("") };
  const files = ["a", "b"].map((name) => ({
    file: `frond_${name}.cpp`,
    originalFile: `yocto_${name}.cpp`,
    text: `#include "yocto_${name}.h"\n#include <${name === "a" ? "vector" : "string"}>\n${name === "a" ? '#include "yocto_dep.h"\n#ifdef YOCTO_EXTERNAL\n#include <not_installed.h>\n#endif\n' : ""}namespace yocto { int old_${name}() { return 0; } }\n`,
  }));
  const removedIncludes = files.flatMap((file) =>
    includeDirectives(file.text)
      .filter((include) => include.quoted)
      .map((include) => ({
        file: file.file,
        originalFile: file.originalFile,
        originalStart: include.start,
        included: include.file.replace("yocto_", "frond_"),
        text: file.text.slice(include.start, include.end).replace("yocto_", "frond_"),
      })),
  );
  const provenance = {
    initialIdentity: treeIdentity(initial),
    files,
    runs,
    originName: "frond",
    removedIncludes,
    project(file, begin, end) {
      const original = files.find((candidate) => candidate.file === file);
      assert.ok(0 <= begin && begin <= end && end <= original.text.indexOf("namespace"));
      const run = runs.find(
        (candidate) => candidate.file === file && candidate.text.startsWith("#include"),
      );
      const included = includeDirectives(original.text).filter((include) => include.quoted);
      const positions = [];
      for (let position = 0; position < original.text.indexOf("namespace"); position++)
        if (!included.some((include) => include.start <= position && position < include.end))
          positions.push(position);
      assert.equal(positions.length, run.text.length);
      const pieces = [];
      let position = 0;
      while (position < positions.length) {
        if (positions[position] < begin || positions[position] >= end) {
          position++;
          continue;
        }
        const start = position++;
        while (
          position < positions.length &&
          begin <= positions[position] &&
          positions[position] < end
        )
          position++;
        pieces.push({
          start: run.start + start,
          end: run.start + position,
          text: run.text.slice(start, position),
          originalStart: positions[start],
        });
      }
      return pieces;
    },
  };
  return { initial, provenance };
}

test("a complete implementation assignment preserves current units, prototypes and inactive code without claiming a shared namespace", () => {
  const input = fixture();
  const [task] = implementationTasks({ ...input, files: ["frond_a.cpp"], startIndex: 7 });
  assert.equal(task.id, "extract-008");
  assert.equal(task.file, "frond_a.cpp");
  assert.equal(task.kind, "implementation");
  assert.equal(task.guard, null);
  assert.equal(task.parent, null);
  assert.equal(task.replacement, "");
  assert.deepEqual(task.includes, ["frond_a.h", "frond_dep.h"]);
  assert.deepEqual(task.using, [{ scope: "frond", text: "using std::vector;" }]);
  assert.ok(task.preamble.includes("#ifdef FROND_EXTERNAL\n#include <not_installed.h>\n#endif"));
  assert.deepEqual(
    includeDirectives(task.destination).map(({ file }) => file),
    ["frond_a.h", "vector", "frond_dep.h", "not_installed.h"],
  );
  const text = input.initial["main.cpp"];
  let previous = -1,
    destinationCursor = 0;
  for (const fragment of task.fragments) {
    assert.ok(previous < fragment.start);
    assert.equal(fragment.text, text.slice(fragment.start, fragment.end));
    assert.equal(fragment.id.startsWith(task.id + "-fragment-"), true);
    previous = fragment.end - 1;
    const destinationStart = task.destination.indexOf(fragment.text, destinationCursor);
    assert.ok(destinationStart >= destinationCursor);
    destinationCursor = destinationStart + fragment.text.length;
  }
  const moved = task.fragments.map((fragment) => fragment.text).join("\n");
  assert.ok(
    task.fragments.some(
      (fragment) =>
        fragment.kind === "empty-declaration" &&
        fragment.text === ";" &&
        fragment.scope === "frond",
    ),
  );
  for (const item of [
    "int current_a();",
    "using CurrentAlias = int;",
    "#define CURRENT_CONSTANT 3",
    "// preserve this standalone comment 🐛",
    "#if 0\nint inactive_a() { return 99; }\n#endif",
    'R"tag(// not a comment\n\n#not_a_directive)tag"',
  ])
    assert.ok(moved.includes(item));
  assert.equal(moved.includes("current_b"), false);
  assert.equal(moved.includes("namespace frond"), false);
  assert.equal(task.destination.includes("old_a"), false);
  assert.equal(task.destination.includes("using std::string;"), false);
  assert.ok(
    task.destination.indexOf("using std::vector;") < task.destination.indexOf("int current_a();"),
  );
  const structure = cppStructure(task.destination);
  const body = structure.units.find((unit) =>
    task.destination.slice(unit.start, unit.end).startsWith("int current_a()"),
  );
  assert.equal(body.scope, "frond");
  const residual = task.fragments.reduceRight(
    (value, fragment) => value.slice(0, fragment.start) + value.slice(fragment.end),
    text,
  );
  assert.ok(residual.includes("namespace frond {"));
  assert.ok(residual.includes("using std::vector;"));
  assert.ok(residual.includes("int current_b() { return 2; }"));
  assert.equal(residual.includes("int current_a()"), false);
  assert.doesNotThrow(() => cppStructure(residual));
});

test("file ownership, source identity and direct include scaffolding fail closed when inconsistent", () => {
  const changed = fixture();
  changed.initial["main.cpp"] += "int injected;\n";
  assert.throws(() => implementationTasks({ ...changed, files: ["frond_a.cpp"] }));
  const mixed = fixture(),
    run = mixed.provenance.runs.find((candidate) => candidate.text.startsWith("int current_a()"));
  const split = run.start + run.text.indexOf("return");
  mixed.provenance.runs.splice(
    mixed.provenance.runs.indexOf(run),
    1,
    { ...run, end: split, text: run.text.slice(0, split - run.start) },
    { ...run, file: "frond_b.cpp", start: split, text: run.text.slice(split - run.start) },
  );
  assert.throws(() => implementationTasks({ ...mixed, files: ["frond_a.cpp"] }));
  const missing = fixture();
  missing.provenance.removedIncludes = [];
  assert.throws(() => implementationTasks({ ...missing, files: ["frond_a.cpp"] }));
  const duplicate = fixture();
  assert.throws(() => implementationTasks({ ...duplicate, files: ["frond_a.cpp", "frond_a.cpp"] }));
});
