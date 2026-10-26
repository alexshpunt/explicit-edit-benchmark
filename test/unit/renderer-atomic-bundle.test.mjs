import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assembleAtomicBundle,
  atomicCheckpoints,
} from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-bundle.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { barrierRepairNodes } from "../../src/suites/explicit-edit-multi-agent/grading/repair-diagnostics.mjs";

function fixture() {
  const initial = {
    "main.cpp":
      "#ifndef SUM_H\n#define SUM_H\nnamespace math { int sum(int a, int b) { return a + b + 1; } }\n#endif\n",
  };
  const structural = {
    id: "task-001",
    phase: "structure",
    goal: "Extract the math header",
    operations: [
      { phase: "structure", action: "header", file: "sum.h", guard: "SUM_H", includes: [] },
    ],
  };
  const moved = structural.operations.reduce(applyCoherentStructure, initial);
  const mappings = [
    { from: "a", to: "left" },
    { from: "b", to: "right" },
  ];
  const groups = mappings.map((mapping) => ({
    bindingCount: 1,
    mapping,
    selectors: [
      {
        kind: "variable",
        scope: `math::sum::${mapping.from}`,
        owner: { scope: "math::sum", signature: "int (int, int)" },
      },
    ],
  }));
  const original = {
    id: "sum-parameters",
    phase: "names",
    category: "locals-parameters",
    mapping: mappings,
    selectors: groups.flatMap((group) => group.selectors),
  };
  const operation = {
    ...original,
    bindingGroups: groups,
    bindingCertification: {
      version: "renderer-atomic-bindings-v1",
      sha256: createHash("sha256").update(JSON.stringify(groups)).digest("hex"),
    },
  };
  const atoms = groups.map((group, bindingGroup) => ({
    bindingGroup,
    operation: { ...original, mapping: [group.mapping], selectors: group.selectors },
    plan: {
      id: original.id,
      edits: [...moved["sum.h"].matchAll(new RegExp(`\\b${group.mapping.from}\\b`, "g"))].map(
        (match) => ({
          file: "sum.h",
          start: match.index,
          old: group.mapping.from,
          new: group.mapping.to,
        }),
      ),
    },
  }));
  const plan = { id: original.id, edits: atoms.flatMap((atom) => atom.plan.edits) };
  const record = coherentNamingPlans(moved, [plan], [], [{ operation, atoms, plan }]);
  const names = {
    id: "task-002",
    phase: "names",
    goal: "Restore parameter names",
    operations: [original],
  };
  const final = {
    ...moved,
    "sum.h": moved["sum.h"].replaceAll(/\ba\b/g, "left").replaceAll(/\bb\b/g, "right"),
  };
  return {
    initial,
    tasks: [structural, names],
    namingPlans: new Map([[names.id, record]]),
    contracts: new Map([
      [structural.id, prepareCoherentContract(moved)],
      [names.id, prepareCoherentContract(final)],
    ]),
    final,
  };
}

function assemble(value) {
  return assembleAtomicBundle(value.initial, value.tasks, {
    namingPlans: value.namingPlans,
    contracts: value.contracts,
  });
}

test("trusted assembly preserves coarse input, physical binding coverage and independent same-owner edits", () => {
  const value = fixture();
  const before = structuredClone(value);
  const result = assemble(value);
  assert.deepEqual(value, before);
  assert.deepEqual(result.tree, value.final);
  assert.equal(result.workload.summary.groups, 2);
  assert.equal(result.workload.summary.atomicEdits, 3);
  assert.equal(result.workload.summary.renameMappings, 2);
  assert.equal(result.workload.summary.namingBindings, 2);
  const nodes = result.workload.nodes.filter((node) => node.taskId === "task-002");
  assert.deepEqual(
    nodes.map((node) => node.dependencies),
    [[], []],
  );
  assert.deepEqual(
    nodes.map((node) => node.sourceOperations),
    [[0], [0]],
  );
  assert.deepEqual(
    nodes.map((node) => node.bindingGroup),
    [0, 1],
  );
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].taskId, "task-002");
  assert.deepEqual(
    result.batches[0].batch.ids,
    nodes.map((node) => node.id),
  );
  for (const node of nodes) {
    assert.equal(node.operations.length, 1);
    assert.equal(node.operations[0].mapping.length, 1);
    for (const key of ["bindingGroups", "bindingCertification", "plan", "edits", "tokens"])
      assert.ok(!Object.hasOwn(node.operations[0], key));
  }
  const encoded = JSON.stringify(result);
  assert.deepEqual(JSON.parse(encoded).workload, result.workload);
});

test("atomic intervals retain original drained barriers and never expose future parent work", () => {
  const value = fixture();
  const bundle = assemble(value);
  const schedule = value.tasks.map((task, index) => ({
    id: `round-${index}`,
    assignments: [{ agent: index, task: task.id }],
  }));
  const contracts = new Map(
    schedule.map((round, index) => [round.id, value.contracts.get(value.tasks[index].id)]),
  );
  const result = atomicCheckpoints(
    value.initial,
    bundle.workload,
    bundle.batches,
    schedule,
    contracts,
  );
  assert.deepEqual(result.tree, value.final);
  const first = result.rounds.get("round-0");
  assert.ok(first.nodes.every((node) => node.taskId === "task-001"));
  assert.equal(Object.hasOwn(first, "checkpoint"), false);
  assert.equal(first.expectedTree["sum.h"].includes("left"), false);
  assert.ok(
    [...first.repairScopes.keys()].every((id) => first.nodes.some((node) => node.id === id)),
  );
  assert.equal(result.rounds.get("round-1").expectedTree["sum.h"], value.final["sum.h"]);
  assert.equal(result.rounds.get("round-1").nodes.length, 2);
  assert.throws(
    () =>
      atomicCheckpoints(
        value.initial,
        bundle.workload,
        bundle.batches,
        schedule.slice(0, 1),
        contracts,
      ),
    /coverage/i,
  );
  assert.throws(
    () =>
      atomicCheckpoints(
        value.initial,
        bundle.workload,
        bundle.batches,
        [...schedule, schedule[0]],
        contracts,
      ),
    /Repeated/,
  );
  assert.throws(
    () => atomicCheckpoints(value.initial, bundle.workload, bundle.batches, schedule, new Map()),
    /contract/i,
  );
});
test("uncertified, stale and changed coarse operations fail before a bundle is returned", () => {
  const mutations = [
    (value) => value.namingPlans.clear(),
    (value) => {
      value.namingPlans.get("task-002").version = "renderer-coherent-naming-plans-v1";
    },
    (value) => {
      value.namingPlans.get("task-002").before = treeIdentity(value.initial);
    },
    (value) => {
      value.tasks[1].operations[0].selectors[0].scope = "other::sum::a";
    },
    (value) => {
      value.namingPlans.get("task-002").bindings[0].operation.bindingCertification.sha256 =
        "0".repeat(64);
    },
    (value) => {
      value.namingPlans.get("task-002").bindings.pop();
    },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assemble(value), /plan|record|source|operation|certif|binding/i);
  }
});

test("binding indexes, physical coverage and actual old tokens remain bound to the compiler union", () => {
  const mutations = [
    (record) => {
      record.bindings[0].atoms[1].bindingGroup = 0;
    },
    (record) => {
      record.bindings[0].atoms[0].plan.edits.pop();
    },
    (record) => {
      record.bindings[0].atoms[0].operation.mapping[0].to = "wrong";
    },
    (record) => {
      record.bindings[0].atoms[0].plan.edits[0].start = 0;
      record.plans[0].edits[0].start = 0;
    },
    (record) => {
      record.bindings[0].atoms[0].plan.edits.push(record.bindings[0].atoms[0].plan.edits[0]);
    },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value.namingPlans.get("task-002"));
    assert.throws(() => assemble(value), /plan|source|union|overlap|binding/i);
  }
});

test("every coarse endpoint needs its exact cumulative contract", () => {
  const value = fixture();
  value.contracts.delete("task-002");
  assert.throws(() => assemble(value), /contract/i);
  const wrong = fixture();
  wrong.contracts.set(
    "task-002",
    prepareCoherentContract({
      ...wrong.final,
      "sum.h": wrong.final["sum.h"].replace("+ 1", "+ 2"),
    }),
  );
  assert.throws(() => assemble(wrong), /endpoint/i);
  const extra = fixture();
  extra.namingPlans.set("unknown", extra.namingPlans.get("task-002"));
  assert.throws(() => assemble(extra), /unknown|unexpected/i);
});

function structuralInterval(initial, operations) {
  const nodes = operations.map((operation, index) => {
    const taskId = `task-${String(index + 1).padStart(3, "0")}`;
    return {
      id: `${taskId}-edit-00001`,
      taskId,
      dependencies: [],
      operations: [operation],
      prompt: taskId,
    };
  });
  const expected = operations.reduce(applyCoherentStructure, initial);
  const round = {
    id: "round-001",
    assignments: nodes.map((node, agent) => ({ agent, task: node.taskId })),
  };
  const replay = atomicCheckpoints(
    initial,
    { version: "renderer-atomic-workload-v1", nodes },
    [],
    [round],
    new Map([[round.id, prepareCoherentContract(expected)]]),
  );
  assert.deepEqual(replay.tree, expected);
  return replay.rounds.get(round.id);
}

function repairsFor(interval, tree, file, scope, selector, bindings = []) {
  const nodes = barrierRepairNodes({
    category: "structure",
    diagnostics: [{ file, scope, selector }],
    nodes: interval.nodes,
    tree,
    bindings,
  });
  assert.ok(
    nodes.every((node) => !Object.hasOwn(node, "original") && !Object.hasOwn(node, "taskId")),
  );
  assert.ok(nodes.every((node) => !interval.nodes.some((original) => original.id === node.id)));
  assert.ok(
    nodes.every(
      (node) => !interval.nodes.some((original) => node.prompt.includes(original.prompt)),
    ),
  );
  return nodes.flatMap((node) => node.operations);
}

test("a damaged current implementation gets a located inspection, not a replayed satisfied move", () => {
  const initial = {
    "main.cpp":
      '#include "api.h"\nnamespace sample { int first(int value) { return value + 1; } int second(int value) { return value + 2; } }\n',
    "api.h": "#pragma once\nnamespace sample { int first(int); int second(int); }\n",
  };
  const interval = structuralInterval(
    initial,
    ["first", "second"].map((name) => ({
      phase: "structure",
      action: "implementation",
      file: "shared.cpp",
      includes: [{ file: "api.h", quoted: true }],
      targets: [
        { selector: { scope: "sample", declarator: `int${name}(intvalue)`, definition: true } },
      ],
    })),
  );
  for (const [index, name] of ["first", "second"].entries()) {
    const file = "shared.cpp";
    const tree = {
      ...interval.expectedTree,
      [file]: interval.expectedTree[file].replace(
        `return value + ${index + 1};`,
        "return value + 9;",
      ),
    };
    const start = tree[file].indexOf(name + "(");
    assert.ok(start >= 0);
    const prefix = tree[file].slice(0, start);
    const bindings = [
      {
        id: "PRIVATE_CURRENT_ID",
        file,
        offset: Buffer.byteLength(prefix),
        name,
        role: "function",
        scope: `sample::${name}`,
        declaringScope: "sample",
        definition: true,
        owner: { scope: `sample::${name}`, signature: "int (int)", definition: true },
        files: [file],
        line: prefix.split("\n").length,
        column: start - tree[file].lastIndexOf("\n", start - 1),
      },
    ];
    const operations = repairsFor(interval, tree, file, "sample", `int${name}(intvalue)`, bindings);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].action, "inspect");
    assert.equal(operations[0].target.file, file);
    assert.equal(operations[0].target.scope, `sample::${name}`);
    assert.equal(JSON.stringify(operations).includes("PRIVATE_"), false);
    assert.equal(JSON.stringify(operations).includes("return value"), false);
  }
});

test("a damaged extracted header is current inspection work and never a repeated extraction or peer repair", () => {
  const initial = {
    "main.cpp":
      "#ifndef A_H\n#define A_H\nnamespace sample { struct A { int value; }; }\n#endif\n#ifndef B_H\n#define B_H\nnamespace sample { struct B { int value; }; }\n#endif\n",
  };
  const interval = structuralInterval(
    initial,
    ["A", "B"].map((name) => ({
      phase: "structure",
      action: "header",
      file: `${name}.h`,
      guard: `${name}_H`,
      includes: [],
    })),
  );
  for (const name of ["A", "B"]) {
    const file = `${name}.h`;
    const tree = {
      ...interval.expectedTree,
      [file]: interval.expectedTree[file].replace("int value;", "int broken;"),
    };
    const operations = repairsFor(interval, tree, file, "sample", `struct${name}`);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].action, "inspect");
    assert.deepEqual(operations[0].files, [file]);
    assert.equal(operations[0].target.file, file);
  }
});

test("a damaged vendor declaration or implementation does not resend the completed header move", () => {
  const declarations = "#ifndef VENDOR_H\n#define VENDOR_H\nint vendor_decl();\n#endif\n";
  const implementation = "#ifdef VENDOR_IMPL\nint vendor_impl() { return 3; }\n#endif\n";
  const initial = {
    "main.cpp":
      declarations +
      implementation +
      "#define VENDOR_IMPL\n" +
      declarations +
      implementation +
      "#ifndef PEER_H\n#define PEER_H\nstruct Peer {};\n#endif\n",
  };
  const file = "support/stb_image/stb_image_resize.h";
  const interval = structuralInterval(initial, [
    {
      phase: "structure",
      action: "vendor-header",
      file,
      guard: "VENDOR_H",
      macro: "VENDOR_IMPL",
      declarationsCopy: 1,
      implementationCopy: 2,
    },
    { phase: "structure", action: "header", file: "peer.h", guard: "PEER_H", includes: [] },
  ]);
  for (const selector of ["intvendor_decl()", "intvendor_impl()"]) {
    const tree = {
      ...interval.expectedTree,
      [file]: interval.expectedTree[file]
        .replace("int vendor_decl();", "float vendor_decl();")
        .replace("return 3;", "return 9;"),
    };
    const operations = repairsFor(interval, tree, file, "", selector);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].action, "inspect");
    assert.equal(operations[0].target.file, file);
    assert.deepEqual(operations[0].files, [file]);
  }
});

test("independent guarded structural moves do not acquire context-only dependencies", () => {
  const initial = {
    "main.cpp":
      "#ifndef A_H\n#define A_H\nstruct A { int n; };\n#endif\n#ifndef B_H\n#define B_H\nstruct B { int n; };\n#endif\n",
  };
  const task = {
    id: "task-001",
    phase: "structure",
    operations: ["A", "B"].map((name) => ({
      phase: "structure",
      action: "header",
      file: `${name}.h`,
      guard: `${name}_H`,
      includes: [],
    })),
  };
  const final = task.operations.reduce(applyCoherentStructure, initial);
  const result = assembleAtomicBundle(initial, [task], {
    namingPlans: new Map(),
    contracts: new Map([[task.id, prepareCoherentContract(final)]]),
  });
  assert.deepEqual(result.tree, final);
  assert.deepEqual(
    result.workload.nodes.map((node) => node.dependencies),
    [[], []],
  );
});
