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
