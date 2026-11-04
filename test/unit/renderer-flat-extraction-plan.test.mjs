import assert from "node:assert/strict";
import test from "node:test";
import { prepareFlatExtractionPlan } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-plan.mjs";
import { extractCurrentFile } from "../../src/suites/explicit-edit-multi-agent/extraction/edit.mjs";

function fixture() {
  const source = "namespace frond {\nint owned();\n}\nint untouched();\n";
  const start = source.indexOf("int owned();");
  const task = {
    id: "extract-001",
    file: "owned.h",
    kind: "header",
    preamble: "#pragma once\n",
    replacement: '#include "owned.h"\n',
    using: [],
    fragments: [{ start, end: start + "int owned();".length }],
  };
  const selected = [...source.matchAll(/[^\n]*\n/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    text: m[0],
  }));
  return { source, plan: { initial: { "main.cpp": source }, tasks: [task] }, selected };
}

test("flat profile projects ownership and builds a new task without mutating the old plan", () => {
  const { plan, selected } = fixture();
  const flat = prepareFlatExtractionPlan(plan, selected);
  assert.equal(plan.initial["main.cpp"].includes("namespace frond"), true);
  assert.equal(flat.initial["main.cpp"].includes("namespace frond"), false);
  assert.equal(flat.tasks[0].fragments.length, 1);
  assert.match(flat.expected["main.cpp"], /#include "owned.h"/);
  assert.match(flat.expected["owned.h"], /int owned\(\);/);
  const result = extractCurrentFile(flat.initial, flat.tasks[0]);
  assert.match(result["owned.h"], /int owned\(\);/);
  assert.match(result["main.cpp"], /int untouched\(\);/);
});

test("flat profile refuses altered projection lines and split ownership", () => {
  const { plan, selected } = fixture();
  assert.throws(() => prepareFlatExtractionPlan(plan, [{ ...selected[0], text: "changed\n" }]));
  plan.tasks[0].fragments[0].end -= 2;
  assert.throws(() => prepareFlatExtractionPlan(plan, selected), /ownership/);
});
