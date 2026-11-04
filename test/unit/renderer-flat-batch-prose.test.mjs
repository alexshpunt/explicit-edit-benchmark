import assert from "node:assert/strict";
import test from "node:test";
import { prepareFlatBatchProse } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-batch-prose.mjs";

function fixture() {
  const a = "int same() { return 1; }\n";
  const b = "int same() { return 2; }\n";
  const c = "int unique() { return 3; }\n";
  const source = a + b + c;
  const fragments = [a, b, c].map((text, i) => ({
    id: `f${i}`,
    start: source.indexOf(text),
    end: source.indexOf(text) + text.length,
    text,
    scope: "",
    kind: "function-definition",
  }));
  return {
    initial: { "main.cpp": source },
    tasks: [
      {
        id: "t",
        file: "test.h",
        kind: "header",
        preamble: "#pragma once\n",
        using: [],
        replacement: '#include "test.h"\n',
        fragments,
      },
    ],
  };
}

test("a batch exposes its own entities and revalidates ambiguous source context", async () => {
  const plan = fixture();
  const prepared = await prepareFlatBatchProse(
    plan,
    new Map([["t", { preamble: [{ kind: "pragma-once" }] }]]),
  );
  const task = plan.tasks[0];
  const first = prepared.render(task, [task.fragments[0]]);
  const last = prepared.render(task, [task.fragments[2]]);
  assert.ok(first.prompt.includes("same()"));
  assert.ok(!first.prompt.includes("unique()"));
  assert.ok(first.prompt.includes('#include "test.h"'));
  assert.ok(last.prompt.includes("unique()"));
  assert.ok(!last.prompt.includes("same()"));
  assert.ok(!last.prompt.includes('#include "test.h"'));
  assert.doesNotThrow(() => prepared.validate(plan.initial["main.cpp"], first));
  assert.throws(() =>
    prepared.validate(plan.initial["main.cpp"].replace("return 1", "return 4"), first),
  );
});

test("a later ambiguous occurrence fails closed after its context is removed", async () => {
  const first = "int same() { return 1; }\n";
  const source = first + first;
  const fragments = [0, first.length].map((start, index) => ({
    id: `f${index}`,
    start,
    end: start + first.length,
    text: first,
    scope: "",
    kind: "function-definition",
  }));
  const task = {
    id: "t",
    file: "test.h",
    kind: "header",
    preamble: "#pragma once\n",
    using: [],
    replacement: '#include "test.h"\n',
    fragments,
  };
  const plan = { initial: { "main.cpp": source }, tasks: [task] };
  const prepared = await prepareFlatBatchProse(
    plan,
    new Map([["t", { preamble: [{ kind: "pragma-once" }] }]]),
  );
  const batch = prepared.render(task, [fragments[1]]);
  assert.doesNotThrow(() => prepared.validate(source, batch));
  assert.throws(() => prepared.validate(first, batch));
});
test("an ambiguous batch can be revalidated after an earlier owned fragment moves", async () => {
  const first = "int same() { return 1; }\n";
  const source = first + first + "int tail;\n";
  const fragments = [0, first.length].map((start, index) => ({
    id: `f${index}`,
    start,
    end: start + first.length,
    text: first,
    scope: "",
    kind: "function-definition",
  }));
  const task = {
    id: "t",
    file: "test.h",
    kind: "implementation",
    preamble: "",
    using: [],
    replacement: "",
    fragments,
  };
  const plan = { initial: { "main.cpp": source }, tasks: [task] };
  const prepared = await prepareFlatBatchProse(plan, new Map([["t", { preamble: [] }]]));
  const currentSource = source.slice(first.length);
  const completed = new Set(["f0"]);
  const projection = { source: currentSource, edits: [{ start: 0, end: first.length, text: "" }] };
  const batch = prepared.render(task, [fragments[1]], { currentSource, completed, projection });
  assert.doesNotThrow(() => prepared.validate(currentSource, batch));
  assert.ok(batch.prompt.includes("same()"));
});
test("invalid vendor contract is rejected before a batch can be delivered", async () => {
  const plan = fixture();
  plan.tasks[0].kind = "vendor-header";
  await assert.rejects(prepareFlatBatchProse(plan, new Map([["t", { flatVendor: {} }]])));
});
