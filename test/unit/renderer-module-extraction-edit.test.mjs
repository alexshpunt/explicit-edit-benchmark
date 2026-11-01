import assert from "node:assert/strict";
import test from "node:test";
import { extractCurrentFile } from "../../src/suites/explicit-edit-multi-agent/extraction/edit.mjs";

test("implementation extraction matches complete current units in their namespace, not stored positions", () => {
  const body = "int current(int value) { return value + 1; }",
    prototype = "int current(int value);";
  const before = {
    "main.cpp": `int peer = 8;\nnamespace other { ${body} }\nnamespace frond {\n${prototype}\n${body}\n}\n`,
  };
  const task = {
    file: "part.cpp",
    kind: "implementation",
    replacement: "",
    destination: `namespace frond {\n${prototype}\n${body}\n}\n`,
    fragments: [
      { text: prototype, scope: "frond", kind: "declaration", start: 99999, end: 99999 },
      { text: body, scope: "frond", kind: "declaration", start: 99999, end: 99999 },
    ],
  };
  const after = extractCurrentFile(before, task);
  assert.equal(after[task.file], task.destination);
  assert.equal(
    after["main.cpp"],
    `int peer = 8;\nnamespace other { ${body} }\nnamespace frond {\n\n\n}\n`,
  );
  assert.equal(before["main.cpp"].includes(prototype), true);
  assert.throws(() => extractCurrentFile(after, task));
});

test("identical peer declarations are rejected rather than selected by a global ordinal", () => {
  const text = "int current();";
  const task = {
    file: "part.cpp",
    kind: "implementation",
    replacement: "",
    destination: text,
    fragments: [{ text, scope: "frond", kind: "declaration" }],
  };
  assert.throws(() =>
    extractCurrentFile({ "main.cpp": `namespace frond { ${text}\n${text}\n}` }, task),
  );
});

test("one vendor assignment removes all of its repeated whole fragments and preserves shared activation", () => {
  const declaration = "#ifndef VENDOR_H\n#define VENDOR_H\nint current();\n#endif\n";
  const implementation = "#ifdef IMPLEMENTATION\nint current() { return 1; }\n#endif\n";
  const before = {
    "main.cpp":
      declaration +
      implementation +
      "#define IMPLEMENTATION\n" +
      declaration +
      implementation +
      "int peer;\n",
  };
  const task = {
    file: "support/vendor.h",
    kind: "vendor-header",
    replacement: '#include "support/vendor.h"\n',
    destination:
      declaration + "#if 0\n" + implementation + declaration + "#endif\n" + implementation,
    fragments: [
      { text: declaration },
      { text: implementation },
      { text: declaration },
      { text: implementation },
    ],
  };
  const after = extractCurrentFile(before, task);
  assert.equal(
    after["main.cpp"],
    '#include "support/vendor.h"\n#define IMPLEMENTATION\nint peer;\n',
  );
  assert.equal(after[task.file], task.destination);
  assert.throws(() => extractCurrentFile({ "main.cpp": before["main.cpp"] + declaration }, task));
});

test("directive fragments retain their complete leading and trailing layout", () => {
  const text = "\n#define IMPLEMENTATION\n";
  const before = { "main.cpp": "int peer;\n" + text + "int other;\n" };
  const task = {
    file: "support/stb.cpp",
    kind: "implementation",
    replacement: "",
    destination: text + '#include "vendor.h"\n',
    fragments: [{ text, scope: "", kind: "directive" }],
  };
  assert.equal(extractCurrentFile(before, task)["main.cpp"], "int peer;\nint other;\n");
});

test("standalone comments and empty declarations do not select punctuation inside protected payloads", () => {
  const comment = "// current comment;  ",
    body = 'const char* current = R"tag(;\n\nkeep this)tag";';
  const before = {
    "main.cpp": `namespace frond {\nusing std::string;\n${comment}\n;\n${body}\n}\n`,
  };
  const task = {
    file: "part.cpp",
    kind: "implementation",
    replacement: "",
    destination: `namespace frond {\n${comment}\n;\n${body}\n}\n`,
    fragments: [
      { text: comment, scope: "frond", kind: "comment" },
      { text: ";", scope: "frond", kind: "empty-declaration" },
      { text: body, scope: "frond", kind: "declaration" },
    ],
  };
  const after = extractCurrentFile(before, task);
  assert.equal(after["main.cpp"], "namespace frond {\nusing std::string;\n\n\n\n}\n");
  assert.equal(after[task.file], task.destination);
});
