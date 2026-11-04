import assert from "node:assert/strict";
import test from "node:test";
import {
  scaffoldFlatPlan,
  cleanupFlatScaffold,
} from "../../src/suites/explicit-edit-multi-agent/extraction/flat-scaffold.mjs";

function fixture() {
  const source = "int first();\nint second();\nint third();\n";
  const fragment = (id, text) => {
    const start = source.indexOf(text);
    return { id, start, end: start + text.length, text };
  };
  return {
    initial: { "main.cpp": source },
    tasks: [
      {
        id: "a",
        file: "a.h",
        preamble: "#pragma once\n",
        replacement: '#include "a.h"\n',
        destination: "#pragma once\n\nint first();\nint third();\n",
        fragments: [fragment("a-1", "int first();"), fragment("a-2", "int third();")],
      },
      {
        id: "b",
        file: "b.cpp",
        preamble: '#include "a.h"\n',
        replacement: "",
        destination: '#include "a.h"\nint second();\n',
        fragments: [fragment("b-1", "int second();")],
      },
    ],
  };
}

test("precreates destinations and source includes, preserving slot order and source ownership", () => {
  const plan = fixture();
  const { plan: transformed, tree, markers } = scaffoldFlatPlan(plan);
  assert.equal(tree["main.cpp"], '#include "a.h"\n' + plan.initial["main.cpp"]);
  assert.equal(transformed.tasks[0].preinsertedReplacement, true);
  for (const task of transformed.tasks)
    for (const fragment of task.fragments) {
      assert.equal(tree["main.cpp"].slice(fragment.start, fragment.end), fragment.text);
      const marker = markers.get(fragment.id);
      assert.equal(tree[task.file].split(marker).length, 2);
      assert.ok(!marker.includes(fragment.text));
    }
  for (const task of transformed.tasks) {
    let file = tree[task.file];
    for (const fragment of task.fragments)
      file = file.replace(markers.get(fragment.id), fragment.text);
    assert.equal(file, task.destination);
  }
  assert.equal(plan.initial["main.cpp"].startsWith("int first"), true);
});

test("cleanup removes only issued complete marker lines from destination files", () => {
  const { tree, markers } = scaffoldFlatPlan(fixture());
  const marker = markers.get("a-1");
  const changed = {
    ...tree,
    "a.h": tree["a.h"] + "// unrelated comment\n" + marker.trim() + " trailing\n",
  };
  const cleaned = cleanupFlatScaffold(changed, markers);
  assert.ok(!cleaned["a.h"].includes("\n" + marker));
  assert.ok(!cleaned["a.h"].includes("\n" + markers.get("a-2")));
  assert.ok(cleaned["a.h"].includes("// unrelated comment\n"));
  assert.ok(cleaned["a.h"].includes(marker.trim() + " trailing\n"));
  assert.equal(cleaned["main.cpp"], tree["main.cpp"]);
});

test("rejects overlapping ownership, altered ranges and unsupported destination layouts", () => {
  const overlapping = fixture();
  overlapping.tasks[1].fragments[0] = { ...overlapping.tasks[0].fragments[0], id: "b-1" };
  assert.throws(() => scaffoldFlatPlan(overlapping));
  const altered = fixture();
  altered.tasks[0].fragments[0].text = "int altered();";
  assert.throws(() => scaffoldFlatPlan(altered));
  const absent = fixture();
  absent.tasks[0].destination = "#pragma once\nint other();\n";
  assert.throws(() => scaffoldFlatPlan(absent));
  const duplicate = fixture();
  duplicate.tasks[1].file = "a.h";
  assert.throws(() => scaffoldFlatPlan(duplicate));
});
