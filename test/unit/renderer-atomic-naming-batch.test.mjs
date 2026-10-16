import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareAtomicNamingBatch,
  applyAtomicNamingBatch,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import { applyScopedNamePlan } from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";

function binding(tree, id, from, to) {
  return {
    id,
    plan: {
      edits: Object.entries(tree).flatMap(([file, source]) =>
        cppTokens(source)
          .filter((token) => token.text === from)
          .map((token) => ({ file, start: token.start, old: from, new: to })),
      ),
    },
  };
}
function expected(tree, bindings, ids) {
  let result = tree;
  const applied = [];
  for (const item of bindings.filter((item) => ids.includes(item.id))) {
    result = applyScopedNamePlan(result, item.plan, applied);
    applied.push(item.plan);
  }
  return result;
}
function aligned(result, selected) {
  const contract = prepareCoherentContract(result.tree);
  for (const owner of result.owners) {
    assert.ok(
      contract.obligations.some(
        (record) =>
          record.file === owner.file &&
          record.scope === owner.scope &&
          record.kind === owner.kind &&
          JSON.stringify(record.conditions) === JSON.stringify(owner.conditions) &&
          JSON.stringify(record.tokens) === JSON.stringify(owner.tokens),
      ),
    );
    for (const site of owner.sites)
      assert.equal(owner.tokens[site.index], selected.includes(site.nodeId) ? site.to : site.from);
  }
}

await test("group-start plans for independent parameters in one owner apply A-only, B-only and A+B without owner chains", () => {
  const tree = {
    "main.cpp":
      "namespace frond { int sum(int left, int right) { return left + right; } int peer() { return 8; } }",
  };
  const plans = [binding(tree, "A", "left", "firstLongName"), binding(tree, "B", "right", "r")];
  const batch = JSON.parse(JSON.stringify(prepareAtomicNamingBatch(tree, plans)));
  const original = JSON.stringify({ tree, plans, batch });
  assert.equal(batch.owners.length, 1);
  for (const ids of [[], ["A"], ["B"], ["A", "B"], ["B", "A"]]) {
    const result = applyAtomicNamingBatch(tree, batch, ids);
    assert.deepEqual(result.tree, expected(tree, plans, ids));
    assert.deepEqual([...new Set(result.owners[0].sites.map((site) => site.nodeId))].sort(), [
      "A",
      "B",
    ]);
    aligned(result, ids);
  }
  assert.deepEqual(
    applyAtomicNamingBatch(tree, batch, ["A", "B"]),
    applyAtomicNamingBatch(tree, batch, ["B", "A"]),
  );
  assert.equal(JSON.stringify({ tree, plans, batch }), original);
});

await test("cross-file field declarations and uses share slots aligned with full class and function records", () => {
  const tree = {
    "pair.h":
      "#ifndef PAIR_H\n#define PAIR_H\nnamespace frond { struct Pair { int left; int right; }; }\n#endif\n",
    "main.cpp":
      '#include "pair.h"\nnamespace frond { int use(Pair pair) { return pair.left + pair.right; } }\n',
  };
  const plans = [binding(tree, "A", "left", "expandedLeft"), binding(tree, "B", "right", "r")];
  const batch = prepareAtomicNamingBatch(tree, plans);
  assert.equal(batch.owners.length, 2);
  for (const ids of [["A"], ["B"], ["A", "B"]]) {
    const result = applyAtomicNamingBatch(tree, batch, ids);
    assert.deepEqual(result.tree, expected(tree, plans, ids));
    aligned(result, ids);
  }
});

await test("batch slots relocate with their trusted owner while guard and macro context is rebuilt", () => {
  const tree = {
    "main.cpp": `#ifndef HEADER_H
#define HEADER_H
namespace frond { struct Header { int value; }; }
#endif
#ifdef HEADER_H
namespace frond { int sum(int left, int right) { return left + right; } }
#endif
`,
  };
  const plans = [binding(tree, "A", "left", "firstLongName"), binding(tree, "B", "right", "r")];
  const batch = prepareAtomicNamingBatch(tree, plans);
  const header = { action: "header", file: "header.h", guard: "HEADER_H", includes: [] };
  const frontier = applyCoherentStructure(tree, header);
  for (const ids of [["A"], ["B"], ["A", "B"]]) {
    const result = applyAtomicNamingBatch(frontier, batch, new Set(ids));
    assert.deepEqual(result.tree, applyCoherentStructure(expected(tree, plans, ids), header));
    aligned(result, ids);
  }
  const relocated = {
    "module.cpp":
      "#define EXTRA 1\nnamespace frond { int sum(int left, int right) { return left + right; } }\n",
    "header.h": frontier["header.h"],
  };
  const result = applyAtomicNamingBatch(relocated, batch, ["A", "B"]);
  assert.equal(result.owners[0].file, "module.cpp");
  assert.equal(
    result.tree["module.cpp"],
    relocated["module.cpp"].replaceAll("left", "firstLongName").replaceAll("right", "r"),
  );
  aligned(result, ["A", "B"]);
});

await test("group baselines include prior naming groups and do not accept partial application of their own batch", () => {
  const initial = {
    "main.cpp": "int sum(int left, int right, int earlier) { return left + right + earlier; }",
  };
  const prior = binding(initial, "prior", "earlier", "acceptedEarlier");
  const tree = applyScopedNamePlan(initial, prior.plan);
  const plans = [binding(tree, "A", "left", "longLeft"), binding(tree, "B", "right", "r")];
  const batch = prepareAtomicNamingBatch(tree, plans);
  assert.deepEqual(
    applyAtomicNamingBatch(tree, batch, ["A", "B"]).tree,
    expected(tree, plans, ["A", "B"]),
  );
  assert.throws(() => applyAtomicNamingBatch(initial, batch, ["A"]), /missing|baseline/i);
  const first = applyAtomicNamingBatch(tree, batch, ["A"]);
  assert.throws(() => applyAtomicNamingBatch(first.tree, batch, ["B"]), /missing|baseline/i);
  assert.throws(
    () =>
      applyAtomicNamingBatch(
        { "main.cpp": tree["main.cpp"].replaceAll("acceptedEarlier", "changed") },
        batch,
        ["A"],
      ),
    /missing|baseline/i,
  );
});

await test("returned inactive-branch slots preserve the unselected branch and protected literals with grader token indexing", () => {
  const tree = {
    "main.cpp": `#ifdef FEATURE
namespace frond { int sum(int left, int right) { const char* text = "left"; return left + right + 1e+5; } }
#else
namespace frond { int idle() { return 99; } }
#endif
`,
  };
  const plans = [binding(tree, "A", "left", "longLeft"), binding(tree, "B", "right", "r")];
  const batch = prepareAtomicNamingBatch(tree, plans);
  assert.equal(batch.owners[0].opaque, false);
  const result = applyAtomicNamingBatch(tree, batch, ["A"]);
  assert.deepEqual(result.tree, expected(tree, plans, ["A"]));
  assert.ok(result.tree["main.cpp"].includes('"left"'));
  assert.ok(result.tree["main.cpp"].includes("idle() { return 99; }"));
  aligned(result, ["A"]);
});

await test("an opaque conditional exposes coupled ownership but retains independent non-overlapping binding slots", () => {
  const tree = {
    "main.cpp": `#ifndef COUPLED_H
#define COUPLED_H
#ifdef MODE
int sum(int left,
#else
int sum(double left,
#endif
int right) { return left + right; }
#endif
int peer() { return 3; }
`,
  };
  const plans = [binding(tree, "A", "left", "longLeft"), binding(tree, "B", "right", "r")];
  const batch = prepareAtomicNamingBatch(tree, plans);
  assert.equal(batch.owners.length, 1);
  assert.equal(batch.owners[0].opaque, true);
  assert.equal(batch.owners[0].kind, "conditional");
  for (const ids of [["A"], ["B"], ["A", "B"]]) {
    const result = applyAtomicNamingBatch(tree, batch, ids);
    assert.deepEqual(result.tree, expected(tree, plans, ids));
    aligned(result, ids);
  }
});

await test("stale plans, physical overlaps, partial tokens and protected-token or context edits are rejected", () => {
  const tree = {
    "main.cpp":
      '#define FEATURE 1\nint sum(int left, int right) { const char* text = "left"; return left + right; }',
  };
  const a = binding(tree, "A", "left", "longLeft");
  const b = binding(tree, "B", "right", "r");
  const stale = JSON.parse(JSON.stringify(a));
  stale.plan.edits[0].start++;
  assert.throws(() => prepareAtomicNamingBatch(tree, [stale]), /stale|token/i);
  const overlap = JSON.parse(JSON.stringify(a));
  overlap.id = "B";
  assert.throws(() => prepareAtomicNamingBatch(tree, [a, overlap]), /overlap/i);
  const partialOverlap = {
    id: "partial",
    plan: { edits: [{ ...a.plan.edits[0], start: a.plan.edits[0].start + 1, old: "eft" }] },
  };
  assert.throws(() => prepareAtomicNamingBatch(tree, [a, partialOverlap]), /overlap/i);
  const partial = { id: "P", plan: { edits: [{ ...a.plan.edits[0], old: "lef" }] } };
  assert.throws(() => prepareAtomicNamingBatch(tree, [partial]), /token|partial/i);
  const literal = {
    id: "L",
    plan: {
      edits: [
        {
          file: "main.cpp",
          start: tree["main.cpp"].indexOf('"left"') + 1,
          old: "left",
          new: "longLeft",
        },
      ],
    },
  };
  assert.throws(() => prepareAtomicNamingBatch(tree, [literal]), /token|owner/i);
  const macro = binding(tree, "M", "FEATURE", "OTHER");
  assert.throws(() => prepareAtomicNamingBatch(tree, [macro]), /context|owner/i);
  assert.throws(() => prepareAtomicNamingBatch(tree, [a, { ...b, id: "A" }]), /id/i);
  const collateral = JSON.parse(JSON.stringify(a));
  collateral.plan.edits.push(b.plan.edits[0]);
  assert.throws(() => prepareAtomicNamingBatch(tree, [collateral]), /substitution|binding/i);
  const batch = prepareAtomicNamingBatch(tree, [a, b]);
  assert.throws(() => applyAtomicNamingBatch(tree, batch, ["missing"]), /selected|unknown/i);
  assert.throws(() => applyAtomicNamingBatch(tree, batch), /selection|selected/i);
  assert.throws(
    () => applyAtomicNamingBatch({ "main.cpp": "int peer() { return 3; }" }, batch, ["A"]),
    /missing/i,
  );
});

await test("opaque layouts with different grader grouping reject rather than silently becoming whole-file frames", () => {
  const tree = {
    "main.cpp": "#ifdef MODE\nOldType\n#else\nlong\n#endif\nvalue;\nint peer() { return 3; }\n",
  };
  const plan = binding(tree, "type", "OldType", "NamedType");
  assert.throws(() => prepareAtomicNamingBatch(tree, [plan]), /unsupported.*alignment/i);
});
await test("ambiguous same-token owner origins require a trustworthy current hint", () => {
  const source = "namespace frond { int sum(int left, int right) { return left + right; } }";
  const tree = { "a.cpp": source, "b.cpp": source };
  const plans = [binding({ "a.cpp": source }, "A", "left", "longLeft")];
  const batch = prepareAtomicNamingBatch(tree, plans);
  assert.throws(() => applyAtomicNamingBatch(tree, batch, ["A"]), /ambiguous/i);
  const hinted = JSON.parse(JSON.stringify(batch));
  hinted.owners[0].fileHint = "a.cpp";
  const result = applyAtomicNamingBatch(tree, hinted, ["A"]);
  assert.equal(result.tree["b.cpp"], source);
  assert.equal(result.tree["a.cpp"], source.replaceAll("left", "longLeft"));
  aligned(result, ["A"]);
});
