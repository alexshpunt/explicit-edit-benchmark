import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const request = (from, to) => ({
  id: from,
  operations: [
    {
      id: from,
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from, to }],
      selectors: [
        {
          kind: "variable",
          scope: `api::refine::${from}`,
          owner: { scope: "api::refine", signature: "int (int, int)", definition: false },
        },
      ],
    },
  ],
});

async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/prototype-reference-"));
  const planner = currentNamingPlanner(root);
  t.after(async () => {
    planner.close();
    await rm(root, { recursive: true, force: true });
  });
  return planner;
}

const input = {
  "api.h": "#pragma once\nnamespace api { int refine(int first, int second); }\n",
  "main.cpp": '#include "api.h"\nint waiting_for_move() { return moved_helper(); }\n',
  "part.cpp": "int moved_helper() { return 1; }\n",
};

await test("a current header prototype parameter can be renamed during unrelated implementation movement", async (t) => {
  const planner = await fixture(t);
  const before = structuredClone(input);
  const first = await planner.plan(before, request("first", "left"));
  assert.deepEqual(first.after, { ...input, "api.h": input["api.h"].replace("first", "left") });
  assert.deepEqual(before, input);
  planner.acknowledge(before, first.after);
  const second = await planner.plan(first.after, request("second", "right"));
  assert.deepEqual(second.after, {
    ...input,
    "api.h": input["api.h"].replace("first", "left").replace("second", "right"),
  });
  planner.acknowledge(first.after, second.after);
});

await test("prototype reference analysis does not ignore errors in the selected current header", async (t) => {
  const planner = await fixture(t);
  const before = { ...input, "api.h": input["api.h"] + "MissingType broken;\n" };
  await assert.rejects(planner.plan(before, request("first", "left")), /Compiler AST failed:/);
  assert.equal(before["api.h"], input["api.h"] + "MissingType broken;\n");
});

await test("a prototype outside headers still uses the actual implementation view", async (t) => {
  const planner = await fixture(t);
  const before = {
    "other.h": "#pragma once\nstruct Item {};\n",
    "main.cpp": "namespace api { int refine(int first, int second); }\n",
  };
  const result = await planner.plan(before, request("first", "left"));
  assert.deepEqual(result.after, {
    ...before,
    "main.cpp": before["main.cpp"].replace("first", "left"),
  });
});

await test("parameters defined outside headers still require valid implementation analysis", async (t) => {
  const planner = await fixture(t);
  const task = request("first", "left");
  task.operations[0].selectors[0].owner.definition = true;
  const before = {
    ...input,
    "main.cpp":
      input["main.cpp"] +
      "namespace api { int refine(int first, int second) { return first + second; } }\n",
  };
  await assert.rejects(planner.plan(before, task), /Compiler AST failed:/);
});

await test("header-defined template locals also remain editable during implementation movement", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "api.h":
      "#pragma once\nnamespace api { template<typename T> int refine(int first, int second) { auto local = first + second; return local; } }\n",
  };
  const task = request("local", "result");
  task.operations[0].selectors[0].owner.definition = true;
  const result = await planner.plan(before, task);
  assert.deepEqual(result.after, {
    ...before,
    "api.h": before["api.h"].replaceAll("local", "result"),
  });
});

await test("a local binding outside headers retains the legal separate-translation-unit fallback", async (t) => {
  const planner = await fixture(t);
  const before = {
    "api.h": input["api.h"],
    "a.cpp":
      '#include "api.h"\nstatic int helper(int x) { return x; }\nnamespace api { int refine(int first, int second) { return helper(first) + second; } }\n',
    "b.cpp":
      '#include "api.h"\nstatic int helper(int x) { return x + 1; }\nint other() { return helper(1); }\n',
  };
  const task = request("first", "left");
  const owner = task.operations[0].selectors[0].owner;
  task.operations[0].selectors = [
    {
      kind: "function",
      scope: owner.scope,
      signature: owner.signature,
      definition: true,
    },
  ];
  const result = await planner.plan(before, task);
  assert.deepEqual(result.after, {
    ...before,
    "a.cpp": before["a.cpp"].replaceAll("first", "left"),
  });
  assert.equal(result.statistics.fallbacks, 1);
  planner.acknowledge(before, result.after);
});

await test("unrelated implementation writes do not discard an unchanged current-header compiler view", async (t) => {
  const planner = await fixture(t);
  const first = await planner.plan(input, request("first", "left"));
  planner.acknowledge(input, first.after);
  const moved = {
    ...first.after,
    "main.cpp": input["main.cpp"] + "int another_unfinished_move() { return later_helper(); }\n",
  };
  const second = await planner.plan(moved, request("second", "right"));
  assert.equal(second.statistics.snapshotAttempts, 1);
  assert.equal(second.statistics.cacheHits, 1);
  assert.equal(second.after["main.cpp"], moved["main.cpp"]);
  planner.acknowledge(moved, second.after);
  const changed = {
    ...second.after,
    "api.h": second.after["api.h"].replace("int left", "long left"),
  };
  const task = request("right", "last");
  task.operations[0].selectors[0].owner.signature = "int (long, int)";
  const last = await planner.plan(changed, task);
  assert.equal(last.statistics.snapshotAttempts, 2);
  assert.ok(last.after["api.h"].includes("int last"));
});

await test("a header view cannot hide implementation input behind a project include", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "api.h": '#include "dependency.cpp"\n' + input["api.h"],
    "dependency.cpp": "using Dependency = int;\n",
  };
  await assert.rejects(planner.plan(before, request("first", "left")), /Compiler AST failed:/);
});

await test("a rejected header CAS reuses its current plan without restoring stale implementation bytes", async (t) => {
  const planner = await fixture(t);
  const task = request("first", "left");
  const first = await planner.plan(input, task);
  const peer = {
    ...input,
    "main.cpp": input["main.cpp"] + "int peer_change = 1;\n",
    "new.cpp": "int newly_moved() { return 2; }\n",
  };
  const retry = await planner.plan(peer, task);
  assert.equal(retry.statistics.snapshotAttempts, 1);
  assert.equal(retry.statistics.pendingHits, 1);
  assert.deepEqual(retry.after, { ...peer, "api.h": first.after["api.h"] });
  assert.throws(() => planner.acknowledge(input, first.after), /pending/);
  planner.acknowledge(peer, retry.after);
  const next = await planner.plan(retry.after, request("second", "right"));
  assert.equal(next.statistics.snapshotAttempts, 1);
  assert.equal(next.statistics.cacheHits, 1);
  assert.equal(next.after["new.cpp"], peer["new.cpp"]);
});

await test("a rejected header CAS still discards its plan after any header input changes", async (t) => {
  const planner = await fixture(t);
  const task = request("first", "left");
  await planner.plan(input, task);
  const peer = { ...input, "api.h": input["api.h"] + "int marker = 7;\n" };
  const retry = await planner.plan(peer, task);
  assert.equal(retry.statistics.snapshotAttempts, 2);
  assert.equal(retry.statistics.pendingHits, 0);
  assert.equal(retry.after["api.h"], peer["api.h"].replace("first", "left"));
  planner.acknowledge(peer, retry.after);
});

const semanticRequest = {
  id: "semantic-header",
  operations: [
    {
      id: "semantic-header",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "refine", to: "combine" }],
      selectors: [{ kind: "function", scope: "api::refine", signature: "int (int, int)" }],
    },
  ],
};

await test("a header-only semantic binding remains editable during unrelated implementation movement", async (t) => {
  const planner = await fixture(t);
  const result = await planner.plan(input, semanticRequest);
  assert.deepEqual(result.after, {
    ...input,
    "api.h": input["api.h"].replace("refine", "combine"),
  });
  planner.acknowledge(input, result.after);
});

await test("a semantic header rename still updates actual implementation uses", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "main.cpp": '#include "api.h"\nint entry() { return api::refine(1, 2); }\n',
  };
  const result = await planner.plan(before, semanticRequest);
  assert.deepEqual(result.after, {
    ...before,
    "api.h": before["api.h"].replace("refine", "combine"),
    "main.cpp": before["main.cpp"].replace("refine", "combine"),
  });
});

await test("header-only analysis cannot hide implementation references or token-pasted spellings", async (t) => {
  for (const source of [
    input["main.cpp"] + "int use() { return api::refine(1, 2); }\n",
    input["main.cpp"] +
      "#define JOIN(a, b) a##b\nint use() { return api::JOIN(re, fine)(1, 2); }\n",
  ]) {
    const planner = await fixture(t);
    await assert.rejects(
      planner.plan({ ...input, "main.cpp": source }, semanticRequest),
      /Compiler AST failed:/,
    );
  }
});

await test("a semantic pending header plan is discarded when a peer adds an implementation use", async (t) => {
  const planner = await fixture(t);
  await planner.plan(input, semanticRequest);
  const peer = {
    ...input,
    "main.cpp": '#include "api.h"\nint use() { return api::refine(1, 2); }\n',
  };
  const retry = await planner.plan(peer, semanticRequest);
  assert.equal(retry.statistics.pendingHits, 0);
  assert.equal(retry.after["main.cpp"], peer["main.cpp"].replace("refine", "combine"));
  planner.acknowledge(peer, retry.after);
});

await test("implementation line splicing cannot hide a semantic use from header-view selection", async (t) => {
  const planner = await fixture(t);
  const source = input["main.cpp"] + "int use() { return api::re\\\nfine(1, 2); }\n";
  await assert.rejects(
    planner.plan({ ...input, "main.cpp": source }, semanticRequest),
    /Compiler AST failed:/,
  );
});

const typeRequest = (from, to, scope = from) => ({
  id: `type-${from}`,
  operations: [
    {
      id: `type-${from}`,
      phase: "names",
      category: "functions-types",
      mapping: [{ from, to }],
      selectors: [{ kind: "type", scope }],
    },
  ],
});

await test("independent header type declarations reuse binding identity but signature consumers reopen analysis", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "api.h":
      "#pragma once\nstruct First { struct Inner {}; };\ninline int consume(First::Inner item) { return 0; }\n",
  };
  const first = await planner.plan(before, typeRequest("First", "Container"));
  planner.acknowledge(before, first.after);
  const inner = await planner.plan(
    first.after,
    typeRequest("Inner", "Element", "Container::Inner"),
  );
  assert.equal(inner.statistics.snapshotAttempts, 1);
  assert.equal(inner.statistics.cacheHits, 1);
  assert.equal(
    inner.after["api.h"],
    before["api.h"].replaceAll("First", "Container").replaceAll("Inner", "Element"),
  );
  planner.acknowledge(first.after, inner.after);
  const parameter = request("item", "value");
  parameter.operations[0].selectors = [
    {
      kind: "variable",
      scope: "consume::item",
      owner: { scope: "consume", signature: "int (Container::Element)", definition: true },
    },
  ];
  const last = await planner.plan(inner.after, parameter);
  assert.equal(last.statistics.snapshotAttempts, 2);
  assert.ok(last.after["api.h"].includes("Container::Element value"));
});

await test("a type request using an earlier destination spelling reopens the current compiler source", async (t) => {
  const planner = await fixture(t);
  const before = { ...input, "api.h": "#pragma once\nstruct First {};\nFirst object;\n" };
  const first = await planner.plan(before, typeRequest("First", "Second"));
  planner.acknowledge(before, first.after);
  const second = await planner.plan(first.after, typeRequest("Second", "Third"));
  assert.equal(second.statistics.snapshotAttempts, 2);
  assert.equal(second.after["api.h"], before["api.h"].replaceAll("First", "Third"));
});

const fieldRequest = {
  id: "header-field",
  operations: [
    {
      id: "header-field",
      phase: "names",
      category: "fields",
      mapping: [{ from: "old_field", to: "value" }],
      selectors: [{ kind: "record", scope: "Item" }],
    },
  ],
};

await test("a header-only field binding remains editable during unrelated implementation movement", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "api.h":
      "#pragma once\nstruct Item { int old_field; };\ninline int get(Item item) { return item.old_field; }\n",
  };
  const result = await planner.plan(before, fieldRequest);
  assert.deepEqual(result.after, {
    ...before,
    "api.h": before["api.h"].replaceAll("old_field", "value"),
  });
});

await test("header field analysis cannot omit actual implementation field uses", async (t) => {
  const planner = await fixture(t);
  const before = {
    ...input,
    "api.h": "#pragma once\nstruct Item { int old_field; };\n",
    "main.cpp": '#include "api.h"\nint get(Item item) { return item.old_field; }\n',
  };
  const result = await planner.plan(before, fieldRequest);
  assert.deepEqual(result.after, {
    ...before,
    "api.h": before["api.h"].replaceAll("old_field", "value"),
    "main.cpp": before["main.cpp"].replaceAll("old_field", "value"),
  });
});
