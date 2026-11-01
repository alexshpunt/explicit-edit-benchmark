import assert from "node:assert/strict";
import test from "node:test";
import { moduleExtractionPrompt } from "../../src/suites/explicit-edit-multi-agent/extraction/prompt.mjs";

test("one module instruction carries every source fragment intact once and all required scaffolding", () => {
  const task = {
    file: "bad.h",
    guard: "BAD_H",
    includes: ["peer.h"],
    parent: "outer.h",
    replacement: "",
    fragments: [
      { id: "first", text: "#ifndef BAD_H\n#define BAD_H\n" },
      { id: "last", text: 'inline const char* bad_name() { return "λ\\n"; }\n#endif\n' },
    ],
  };
  const prompt = moduleExtractionPrompt(task);
  for (const { text } of task.fragments) {
    const offset = prompt.indexOf(text);
    assert.ok(offset >= 0);
    assert.equal(prompt.indexOf(text, offset + text.length), -1);
  }
  for (const identifier of [task.file, task.guard, task.includes[0], task.parent])
    assert.ok(prompt.includes(identifier));
  assert.equal(task.fragments.length, 2);
});

test("implementation assignments carry namespace, import and direct-include scaffolding with each current fragment once", () => {
  const body = "int current_operation() { return 9; }";
  const task = {
    file: "current.cpp",
    kind: "implementation",
    guard: null,
    includes: ["current.h"],
    preamble: '#include "current.h"\n#include <vector>\n',
    using: [{ scope: "frond", text: "using std::vector;" }],
    replacement: "",
    fragments: [{ id: "owned-definition", text: body, scope: "frond" }],
    destination:
      '#include "current.h"\n#include <vector>\nnamespace frond {\nusing std::vector;\n}\nnamespace frond {\n' +
      body +
      "\n}\n",
  };
  const prompt = moduleExtractionPrompt(task);
  for (const value of [task.file, task.preamble, task.using[0].text, "namespace frond", body])
    assert.ok(prompt.includes(value));
  assert.equal(prompt.split(body).length, 2);
  assert.ok(prompt.includes(task.fragments[0].id));
});

test("vendor assignment scaffolding keeps both inactive phases around their own fragment slots", () => {
  const fragments = [
    { id: "active-declaration", text: "int current_vendor(int value);\n", prefix: "", suffix: "" },
    {
      id: "inactive-implementation",
      text: "int old_vendor(int value) { return value; }\n",
      prefix: "#if 0\n",
      suffix: "#endif\n",
    },
    {
      id: "inactive-declaration",
      text: "int old_vendor(int value);\n",
      prefix: "#if 0\n",
      suffix: "#endif\n",
    },
    {
      id: "active-implementation",
      text: "int current_vendor(int value) { return value; }\n",
      prefix: "",
      suffix: "",
    },
  ];
  const task = {
    file: "support/vendor.h",
    kind: "vendor-header",
    guard: "VENDOR_H",
    includes: [],
    preamble: "",
    postamble: "",
    replacement: '#include "support/vendor.h"\n',
    fragments,
    destination: fragments
      .map((fragment) => fragment.prefix + fragment.text + fragment.suffix)
      .join(""),
  };
  const prompt = moduleExtractionPrompt(task);
  for (const fragment of fragments) {
    assert.equal(prompt.split(fragment.text).length, 2);
    assert.ok(prompt.includes(fragment.id));
  }
  assert.equal(prompt.split("#if 0\n").length, 3);
  assert.equal(prompt.split("#endif\n").length, 3);
  for (const value of [task.file, task.replacement]) assert.ok(prompt.includes(value));
});

test("activation assignment places its relative include after the owned macro slot", () => {
  const text = "#define CURRENT_IMPLEMENTATION\n",
    postamble = '#include "vendor/current.h"\n';
  const task = {
    file: "support/activation.cpp",
    kind: "implementation",
    guard: null,
    includes: ["support/vendor/current.h"],
    preamble: "",
    postamble,
    replacement: "",
    fragments: [{ id: "activation-macro", text, scope: "", prefix: "", suffix: "" }],
    destination: text + postamble,
  };
  const prompt = moduleExtractionPrompt(task);
  assert.ok(prompt.includes(postamble));
  assert.equal(prompt.split(text).length, 2);
  assert.ok(prompt.indexOf(task.fragments[0].id) < prompt.indexOf(postamble));
});
