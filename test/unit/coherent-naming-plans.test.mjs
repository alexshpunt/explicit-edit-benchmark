import assert from "node:assert/strict";
import test from "node:test";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { applyScopedNamePlan } from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

function plan(id, file, source, old, replacement) {
  return {
    id,
    edits: [...source.matchAll(new RegExp(`\\b${old}\\b`, "g"))].map((match) => ({
      file,
      start: match.index,
      old,
      new: replacement,
    })),
  };
}

function apply(tree, plans) {
  const applied = [];
  for (const current of plans) {
    tree = applyScopedNamePlan(tree, current, applied);
    applied.push(current);
  }
  return tree;
}

test("private group plans use its starting tree, not earlier module offsets or earlier edits in the group", () => {
  const source = "int tiny = 1;\nint oldParameter = tiny;\nint nextName = oldParameter;\n";
  const snapshot = {
    "a.cpp": source,
    "b.cpp": "int tiny = 2;\n",
  };
  const earlier = [
    plan("previous-module", "a.cpp", source, "tiny", "longer_global"),
    plan("other-file", "b.cpp", snapshot["b.cpp"], "tiny", "unrelated_longer_name"),
  ];
  const group = [
    plan("first", "a.cpp", source, "oldParameter", "x"),
    plan("second", "a.cpp", source, "nextName", "restored"),
  ];
  const original = structuredClone({ earlier, group });
  const current = apply(snapshot, earlier);
  const sealed = coherentNamingPlans(current, group, earlier);
  assert.equal(sealed.version, "renderer-coherent-naming-plans-v1");
  assert.equal(sealed.before, treeIdentity(current));
  assert.deepEqual(
    sealed.plans.map((item) => item.id),
    ["first", "second"],
  );
  assert.equal(
    sealed.plans[1].edits[0].start,
    current["a.cpp"].indexOf("nextName"),
    "the second plan must still use the group-start offset",
  );
  assert.deepEqual(apply(current, sealed.plans), {
    "a.cpp": "int longer_global = 1;\nint x = longer_global;\nint restored = x;\n",
    "b.cpp": current["b.cpp"],
  });
  assert.deepEqual({ earlier, group }, original);
});

test("previous shrinking edits and multiple uses rebase without altering literals or other files", () => {
  const source =
    'int previousLongName = 7;\nint chosen = previousLongName;\nconst char* text = "chosen";\n';
  const snapshot = { "a.cpp": source, "b.cpp": "int chosen = 9;\n" };
  const earlier = [plan("previous", "a.cpp", source, "previousLongName", "p")];
  const current = apply(snapshot, earlier);
  const group = [
    {
      id: "current",
      edits: [
        {
          file: "a.cpp",
          start: source.indexOf("chosen"),
          old: "chosen",
          new: "value",
        },
      ],
    },
  ];
  const sealed = coherentNamingPlans(current, group, earlier);
  assert.deepEqual(apply(current, sealed.plans), {
    "a.cpp": 'int p = 7;\nint value = p;\nconst char* text = "chosen";\n',
    "b.cpp": snapshot["b.cpp"],
  });
});

test("a mismatched current source cannot seal stale binding origins", () => {
  const tree = { "a.cpp": "int changed = 1;\n" };
  assert.throws(
    () =>
      coherentNamingPlans(
        tree,
        [
          {
            id: "stale",
            edits: [
              {
                file: "a.cpp",
                start: 4,
                old: "original",
                new: "restored",
              },
            ],
          },
        ],
        [],
      ),
    /Private naming plan does not match group source/,
  );
});
