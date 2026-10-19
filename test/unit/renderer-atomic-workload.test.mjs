import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  scopedNamingPlan,
  scopedNamingSession,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { atomicWorkload } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-workload.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";

function fixtureCertification(operation, bindingGroups) {
  bindingGroups = bindingGroups.map((group) => ({ bindingCount: 1, ...group }));
  return {
    ...operation,
    bindingGroups,
    bindingCertification: {
      version: "renderer-atomic-bindings-v1",
      sha256: createHash("sha256").update(JSON.stringify(bindingGroups)).digest("hex"),
    },
  };
}

// Controlled certificates isolate graph/coverage validation. Real compiler
// certification and selector replay are exercised in the binding-session tests.
function namingTask(operations, id = "task-001") {
  return {
    id,
    phase: "names",
    subsystem: "math.cpp",
    operations: operations.map((operation) => {
      const groups = operation.mapping.map((mapping) => {
        const selectors = operation.selectors
          .filter(
            (selector) =>
              operation.category !== "functions-types" ||
              selector.scope.split("::").at(-1) === mapping.from,
          )
          .map((selector) =>
            operation.category === "locals-parameters" && selector.kind === "function"
              ? {
                  kind: "variable",
                  scope: `${selector.scope}::${mapping.from}`,
                  owner: {
                    scope: selector.scope,
                    signature: selector.signature,
                    definition: selector.definition,
                  },
                }
              : selector,
          );
        return { mapping, selectors };
      });
      return fixtureCertification(operation, groups);
    }),
  };
}
function locals(scope, mapping) {
  return {
    id: scope,
    phase: "names",
    category: "locals-parameters",
    selectors: [{ kind: "function", scope, signature: "int (int)", definition: true }],
    mapping,
  };
}

test("same-spelling parameters in separate certified operations retain independent function owners", () => {
  for (const scopes of [
    ["frond::first", "frond::second"],
    ["frond::overload", "frond::overload"],
  ]) {
    const operations = scopes.map((scope, index) => {
      const operation = locals(scope, [{ from: "a", to: `value_${index}` }]);
      operation.selectors[0].signature = index ? "int (double)" : "int (int)";
      return operation;
    });
    const { nodes } = atomicWorkload([namingTask(operations)]);
    assert.equal(nodes.length, 2);
    assert.ok(nodes.every((node) => node.dependencies.length === 0));
  }
});

test("separately certified prototype and definition parameters stay independently ready", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-prototype-parameters-"));
  const tree = {
    "main.cpp": `namespace frond {
template<typename T> T sample(const T& p1_param);
template<typename T> T sample(const T& p1_param) { return p1_param; }
}
int main() { return frond::sample(1); }
`,
  };
  await mkdir(path.join(root, "analysis"));
  const session = await scopedNamingSession(tree, path.join(root, "analysis"));
  try {
    const certifications = [];
    for (const definition of [false, true]) {
      certifications.push(
        await session.atomicPlans({
          id: definition ? "definition-parameter" : "prototype-parameter",
          phase: "names",
          category: "locals-parameters",
          mapping: [{ from: "p1_param", to: "p1" }],
          selectors: [
            { kind: "function", scope: "frond::sample", signature: "T (const T &)", definition },
          ],
        }),
      );
    }
    session.close();
    const task = {
      id: "task-001",
      phase: "names",
      operations: certifications.map((item) => item.operation),
    };
    const { nodes } = atomicWorkload([task]);
    assert.equal(nodes.length, 2);
    assert.ok(nodes.every((node) => node.dependencies.length === 0));
    for (const [orderIndex, order] of [
      [0, 1],
      [1, 0],
    ].entries()) {
      let current = tree;
      for (const index of order) {
        const directory = path.join(root, `runtime-${orderIndex}-${index}`);
        await mkdir(directory);
        const [plan] = await scopedNamingPlan(current, [nodes[index].operations[0]], directory);
        current = applyScopedNamePlan(current, plan);
        execFileSync("clang++", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
          input: current["main.cpp"],
        });
      }
      assert.doesNotMatch(current["main.cpp"], /p1_param/);
      assert.match(current["main.cpp"], /return p1;/);
    }
    for (const definition of [undefined, false, true]) {
      const indistinguishable = structuredClone(task);
      for (const operation of indistinguishable.operations) {
        for (const group of operation.bindingGroups)
          for (const selector of group.selectors) {
            if (definition === undefined) delete selector.owner.definition;
            else selector.owner.definition = definition;
          }
        operation.bindingCertification.sha256 = createHash("sha256")
          .update(JSON.stringify(operation.bindingGroups))
          .digest("hex");
      }
      assert.throws(() => atomicWorkload([indistinguishable]), /cycle/);
    }
  } finally {
    session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a local spelling cannot invalidate a global selector, but its type rename still waits for the old signature", () => {
  const parameter = locals("frond::consume", [{ from: "Old", to: "value" }]);
  parameter.selectors[0].signature = "int (frond::Old)";
  const type = {
    id: "type",
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "Old", to: "Restored" }],
    selectors: [{ kind: "type", scope: "frond::Old" }],
  };
  const { nodes } = atomicWorkload([namingTask([type, parameter])]);
  const writer = nodes.find((node) => node.operations[0].category === "functions-types");
  const reader = nodes.find((node) => node.operations[0].category === "locals-parameters");
  assert.deepEqual(writer.dependencies, [reader.id]);
  assert.deepEqual(reader.dependencies, []);
});

test("a parameter used in a trailing return signature still waits for sibling selector consumers", () => {
  const operation = locals("frond::deduce", [
    { from: "a", to: "left" },
    { from: "b", to: "right" },
  ]);
  operation.selectors[0].signature = "auto (int, int) -> decltype(a)";
  const { nodes } = atomicWorkload([namingTask([operation])]);
  const parameter = (from) => nodes.find((node) => node.operations[0].mapping[0].from === from);
  assert.deepEqual(parameter("a").dependencies, [parameter("b").id]);
  assert.deepEqual(parameter("b").dependencies, []);
});

test("distinct prototype and definition owners still retain parameter-name signature reads", () => {
  const writer = locals("frond::deduce", [{ from: "a", to: "left" }]);
  const reader = locals("frond::deduce", [{ from: "b", to: "right" }]);
  writer.selectors[0].signature = "auto (int, int) -> decltype(a)";
  reader.selectors[0].signature = writer.selectors[0].signature;
  reader.selectors[0].definition = false;
  const { nodes } = atomicWorkload([namingTask([writer, reader])]);
  assert.deepEqual(nodes[0].dependencies, [nodes[1].id]);
  assert.deepEqual(nodes[1].dependencies, []);
});

test("an extern binding rename waits for another owner's signature consumer", () => {
  const writer = locals("frond::writer", [{ from: "a", to: "restored" }]);
  const reader = locals("frond::reader", [{ from: "b", to: "value" }]);
  reader.selectors[0].signature = "auto (int) -> decltype(a)";
  const { nodes } = atomicWorkload([namingTask([writer, reader])]);
  assert.deepEqual(nodes[0].dependencies, [nodes[1].id]);
  assert.deepEqual(nodes[1].dependencies, []);
});

test("an escaping local type retains consumers of its inferred return signature", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-inferred-return-"));
  const initial = {
    "main.cpp":
      "namespace frond { auto maker() { struct Old {}; return Old{}; } auto consumer() { return maker(); } }\nint main() { frond::consumer(); }\n",
  };
  const consumerRequest = {
    id: "consumer",
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "consumer", to: "restored_consumer" }],
    selectors: [{ kind: "function", scope: "frond::consumer" }],
  };
  let before, after;
  try {
    await mkdir(path.join(root, "before"));
    before = await scopedNamingSession(initial, path.join(root, "before"));
    const type = await before.atomicPlans({
      id: "type",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "Old", to: "RestoredType" }],
      selectors: [{ kind: "type", scope: "frond::maker::Old" }],
    });
    const consumer = await before.atomicPlans(consumerRequest);
    const renamed = applyScopedNamePlan(initial, type.plan);
    await mkdir(path.join(root, "after"));
    after = await scopedNamingSession(renamed, path.join(root, "after"));
    const refreshed = await after.atomicPlans(consumerRequest);
    const signature = (binding) => binding.operation.bindingGroups[0].selectors[0].owner.signature;
    assert.notEqual(signature(consumer), signature(refreshed));
    assert.match(signature(consumer), /\bOld\b/);
    assert.match(signature(refreshed), /\bRestoredType\b/);
    const { nodes } = atomicWorkload([
      { id: "task-001", phase: "names", operations: [type.operation, consumer.operation] },
    ]);
    assert.deepEqual(nodes[0].dependencies, [nodes[1].id]);
    assert.deepEqual(nodes[1].dependencies, []);
  } finally {
    before?.close();
    after?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("disjoint bindings from one mapping still retain type-dependent signature reads", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-type-function-spelling-"));
  const tree = {
    "main.cpp":
      "namespace frond { auto maker() { struct Old {}; return Old{}; } auto Old() { return maker(); } }\nint main() { frond::Old(); }\n",
  };
  const session = await scopedNamingSession(tree, root);
  try {
    const binding = await session.atomicPlans({
      id: "shared-spelling",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "Old", to: "Restored" }],
      selectors: [
        { kind: "type", scope: "frond::maker::Old" },
        { kind: "function", scope: "frond::Old" },
      ],
    });
    assert.equal(binding.atoms.length, 2);
    const { nodes } = atomicWorkload([
      { id: "task-001", phase: "names", operations: [binding.operation] },
    ]);
    const type = nodes.find((node) => node.operations[0].selectors[0].kind === "type");
    const consumer = nodes.find((node) => node.operations[0].selectors[0].kind === "function");
    assert.match(consumer.operations[0].selectors[0].owner.signature, /\bOld\b/);
    assert.deepEqual(type.dependencies, [consumer.id]);
    assert.deepEqual(consumer.dependencies, []);
  } finally {
    session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("disjoint overload bindings retain function-name reads inside decltype signatures", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-overload-signature-"));
  const tree = {
    "main.cpp":
      "namespace frond { int old() { return 1; } auto old(int value) -> decltype(old()) { return value; } }\nint main() { return frond::old(1) - frond::old(); }\n",
  };
  const session = await scopedNamingSession(tree, root);
  try {
    const binding = await session.atomicPlans({
      id: "overloads",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "old", to: "renamed" }],
      selectors: [{ kind: "function", scope: "frond::old" }],
    });
    assert.equal(binding.atoms.length, 2);
    const { nodes } = atomicWorkload([
      { id: "task-001", phase: "names", operations: [binding.operation] },
    ]);
    const readsName = (node) =>
      node.operations[0].selectors.some((selector) =>
        /\bdecltype\s*\(old\(\)\)/.test(selector.owner.signature),
      );
    const consumer = nodes.find(readsName);
    const producer = nodes.find((node) => !readsName(node));
    assert.ok(
      consumer && producer,
      "Real compiler selectors must expose the dependent written signature",
    );
    assert.deepEqual(producer.dependencies, [consumer.id]);
    assert.deepEqual(consumer.dependencies, []);
  } finally {
    session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("template and unfamiliar function signatures keep their conservative function-name read edges", () => {
  const mapping = { from: "old", to: "renamed" };
  for (const signature of ["Tag<old> (int)", "int (int) noexcept(old())", "int (&())[old()]"]) {
    const selectors = ["int ()", signature].map((signature) => ({
      kind: "function",
      scope: "frond::old",
      owner: { scope: "frond::old", signature },
    }));
    const operation = fixtureCertification(
      {
        id: "overloads",
        phase: "names",
        category: "functions-types",
        mapping: [mapping],
        selectors,
      },
      selectors.map((selector) => ({ mapping, selectors: [selector] })),
    );
    const { nodes } = atomicWorkload([{ id: "task-001", phase: "names", operations: [operation] }]);
    assert.deepEqual(nodes[0].dependencies, [nodes[1].id]);
    assert.deepEqual(nodes[1].dependencies, []);
  }
});

function overloadTask() {
  return namingTask([
    {
      id: "overloads",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "old", to: "renamed" }],
      selectors: ["int (int)", "double (double)", "long (long)"].flatMap((signature) =>
        [false, true].map((definition) => ({
          kind: "function",
          scope: "frond::old",
          owner: { scope: "frond::old", signature, definition },
        })),
      ),
    },
  ]);
}

test("a compiler owner signature selects one overload's declarations, definition and call independently", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-overload-"));
  const tree = {
    "main.cpp": `namespace frond {
int old(int x); double old(double x); long old(long x);
int old(int x) { return x; } double old(double x) { return x; } long old(long x) { return x; }
}
int main() { return frond::old(2) + frond::old(3.0) + frond::old(4L) == 9 ? 0 : 1; }
`,
  };
  try {
    const names = ["int", "double", "long"];
    for (const [index, type] of names.entries()) {
      const operation = overloadTask().operations[0];
      operation.selectors = operation.selectors.filter(
        (selector) => selector.owner.signature === `${type} (${type})`,
      );
      const [plan] = await scopedNamingPlan(tree, [operation], root);
      assert.equal(plan.edits.length, 3);
      const after = applyScopedNamePlan(tree, plan);
      for (const [position, sibling] of names.entries()) {
        const expected = position === index ? "renamed" : "old";
        assert.ok(after["main.cpp"].includes(`${sibling} ${expected}(${sibling} x);`));
        assert.ok(after["main.cpp"].includes(`${sibling} ${expected}(${sibling} x) { return x; }`));
      }
      execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
        input: after["main.cpp"],
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct written signatures can select the same alias-bound function and cannot certify distinct atomic edits", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/atomic-alias-"));
  const tree = {
    "main.cpp": `namespace frond {
using Alias = int;
int old(int x);
int old(Alias x) { return x; }
}
int main() { return frond::old(2); }
`,
  };
  const request = (signature) => ({
    id: signature,
    category: "functions-types",
    mapping: [{ from: "old", to: "renamed" }],
    selectors: [
      { kind: "function", scope: "frond::old", owner: { scope: "frond::old", signature } },
    ],
  });
  try {
    const [declaration] = await scopedNamingPlan(tree, [request("int (int)")], root);
    const [definition] = await scopedNamingPlan(tree, [request("int (Alias)")], root);
    assert.equal(declaration.edits.length, 3);
    assert.deepEqual(declaration.edits, definition.edits);
    const after = applyScopedNamePlan(tree, declaration);
    assert.ok(after["main.cpp"].includes("int renamed(Alias x)"));
    await assert.rejects(
      scopedNamingPlan(after, [request("int (Alias)")], root),
      /Missing current owner\/signature binding/,
    );
    execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
      input: after["main.cpp"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("certified bindings sharing a mapping keep one original requirement but create separate deliveries", () => {
  const operation = overloadTask().operations[0];
  const groups = ["int (int)", "double (double)", "long (long)"].map((signature) => ({
    mapping: operation.mapping[0],
    selectors: operation.selectors.filter((selector) => selector.owner.signature === signature),
  }));
  const task = {
    id: "task-001",
    phase: "names",
    operations: [fixtureCertification(operation, groups)],
  };
  const workload = atomicWorkload([task]);
  assert.equal(workload.nodes.length, 3);
  assert.equal(workload.summary.renameMappings, 1);
  assert.equal(workload.summary.namingBindings, 3);
  assert.deepEqual(
    workload.nodes.map((node) => node.bindingGroup),
    [0, 1, 2],
  );
  assert.deepEqual(
    workload.nodes.map((node) => node.dependencies),
    [[], [], []],
  );
  assert.deepEqual(
    workload.nodes.flatMap((node) => node.operations[0].selectors),
    operation.selectors,
  );
});

test("missing, incomplete, overlapping and uncovered binding certifications fail closed", () => {
  const base = namingTask([
    locals("frond::f", [
      { from: "a", to: "x" },
      { from: "b", to: "y" },
    ]),
  ]);
  const uncertified = structuredClone(base);
  delete uncertified.operations[0].bindingCertification;
  assert.throws(() => atomicWorkload([uncertified]), /compiler-certified/);
  const incomplete = structuredClone(base);
  incomplete.operations[0].bindingGroups.pop();
  assert.throws(() => atomicWorkload([incomplete]), /incomplete/);
  const uncovered = structuredClone(base);
  uncovered.operations[0] = fixtureCertification(
    uncovered.operations[0],
    uncovered.operations[0].bindingGroups.slice(0, 1),
  );
  assert.throws(() => atomicWorkload([uncovered]), /cover the original mappings/);
  const overlapping = structuredClone(base);
  const groups = overlapping.operations[0].bindingGroups;
  groups.push(structuredClone(groups[0]));
  overlapping.operations[0] = fixtureCertification(overlapping.operations[0], groups);
  assert.throws(() => atomicWorkload([overlapping]), /Overlapping/);
  const privateSelector = structuredClone(base);
  privateSelector.operations[0].bindingGroups[0].selectors[0].offset = 100;
  privateSelector.operations[0] = fixtureCertification(
    privateSelector.operations[0],
    privateSelector.operations[0].bindingGroups,
  );
  assert.throws(() => atomicWorkload([privateSelector]), /invalid public selector/);
});
function nodeFor(workload, from) {
  return workload.nodes.find((node) =>
    node.operations.some((op) => op.mapping?.some((m) => m.from === from)),
  );
}

test("each naming delivery carries one mapping and retains every selected owner", () => {
  const task = namingTask([
    locals("frond::first", [
      { from: "param_x", to: "x" },
      { from: "local_result", to: "result" },
    ]),
    locals("frond::second", [{ from: "arg_x", to: "x" }]),
  ]);
  const before = structuredClone(task);
  const workload = atomicWorkload([task]);
  assert.equal(workload.version, "renderer-atomic-workload-v1");
  assert.equal(workload.nodes.length, 3);
  assert.equal(new Set(workload.nodes.map((node) => node.id)).size, 3);
  assert.deepEqual(task, before);
  for (const node of workload.nodes) {
    assert.equal(node.taskId, task.id);
    assert.equal(node.operations.length, 1);
    assert.equal(node.operations[0].mapping.length, 1);
    assert.deepEqual(node.dependencies, []);
    const original = task.operations.find((op) => op.id === node.operations[0].id);
    assert.deepEqual(
      node.operations[0].selectors,
      original.bindingGroups[node.bindingGroup].selectors,
    );
    assert.equal(node.operations[0].bindingGroups, undefined);
    assert.equal(node.operations[0].bindingCertification, undefined);
  }
  assert.deepEqual(
    workload.nodes.flatMap((node) => node.operations[0].mapping),
    task.operations.flatMap((op) => op.mapping),
  );
  assert.deepEqual(atomicWorkload([task]), workload);
});

test("selector consumers finish before the type rename invalidates their current spellings", () => {
  const type = {
    id: "type",
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "OldRecord", to: "Record" }],
    selectors: [{ kind: "type", scope: "frond::OldRecord" }],
  };
  const member = {
    id: "member",
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "old_method", to: "method" }],
    selectors: [
      {
        kind: "function",
        scope: "frond::OldRecord::old_method",
        owner: { scope: "frond::OldRecord::old_method", signature: "OldRecord (int)" },
      },
    ],
  };
  const workload = atomicWorkload([namingTask([type, member])]);
  const parent = nodeFor(workload, "OldRecord"),
    child = nodeFor(workload, "old_method");
  assert.ok(parent.dependencies.includes(child.id));
  assert.deepEqual(child.dependencies, []);
  assert.deepEqual(child.operations[0].selectors, member.selectors);
});

test("same-spelling local types in distinct overload owners remain independent", () => {
  const operation = (signature) => ({
    id: signature,
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "enumerate_helper_t", to: "enumerate_helper" }],
    selectors: [
      {
        kind: "type",
        scope: "frond::func_enumerate::enumerate_helper_t",
        owner: { scope: "frond::func_enumerate", signature },
      },
    ],
  });
  const task = namingTask([
    operation("auto (Sequence &, T)"),
    operation("auto (const Sequence &, T)"),
  ]);
  const workload = atomicWorkload([task]);
  assert.equal(workload.nodes.length, 2);
  assert.deepEqual(
    workload.nodes.map((node) => node.dependencies),
    [[], []],
  );
  assert.deepEqual(
    workload.nodes.map((node) => node.operations[0].selectors),
    task.operations.map((op) => op.selectors),
  );
});
test("a destination occupied by another selected binding is freed first, and a rename swap fails closed", () => {
  const task = namingTask([
    locals("frond::f", [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]),
  ]);
  const workload = atomicWorkload([task]);
  assert.deepEqual(nodeFor(workload, "a").dependencies, [nodeFor(workload, "b").id]);
  assert.throws(
    () =>
      atomicWorkload([
        namingTask([
          locals("frond::f", [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ]),
        ]),
      ]),
    /indivisible.*cycle/i,
  );
});

test("function and type deliveries retain only selectors for their own mapping", () => {
  const workload = atomicWorkload([
    namingTask([
      {
        id: "family",
        phase: "names",
        category: "functions-types",
        mapping: [
          { from: "Old", to: "New" },
          { from: "helper_old", to: "helper" },
        ],
        selectors: [
          { kind: "type", scope: "frond::Old" },
          {
            kind: "function",
            scope: "frond::helper_old",
            owner: { scope: "frond::helper_old", signature: "int ()" },
          },
        ],
      },
    ]),
  ]);
  assert.deepEqual(nodeFor(workload, "Old").operations[0].selectors, [
    { kind: "type", scope: "frond::Old" },
  ]);
  assert.deepEqual(nodeFor(workload, "helper_old").operations[0].selectors, [
    {
      kind: "function",
      scope: "frond::helper_old",
      owner: { scope: "frond::helper_old", signature: "int ()" },
    },
  ]);
  assert.deepEqual(nodeFor(workload, "Old").dependencies, []);
  assert.deepEqual(nodeFor(workload, "helper_old").dependencies, []);
});

test("a definition move includes its uniquely owned temporary declaration cleanup", () => {
  const move = {
    id: "move",
    phase: "structure",
    action: "implementation",
    file: "math.cpp",
    includes: [{ file: "math.h", quoted: true }],
    targets: [{ selector: { scope: "frond", declarator: "intf(intx)", definition: true } }],
  };
  const cleanup = {
    id: "cleanup",
    phase: "structure",
    action: "remove-generated-declaration",
    file: "math.cpp",
    selector: { scope: "frond", declarator: "intf(intx)", definition: false },
  };
  const task = {
    id: "task-003",
    phase: "structure",
    subsystem: "math.cpp",
    operations: [move, cleanup],
  };
  const workload = atomicWorkload([task]);
  assert.equal(workload.nodes.length, 1);
  assert.deepEqual(workload.nodes[0].operations, [move, cleanup]);
  const tree = {
    "main.cpp": "namespace frond { int f(int x) { return x; } }\n",
    "math.h": "namespace frond { int f(int x); }\n",
    "math.cpp": "namespace frond { int f(int x); }\n",
  };
  const after = workload.nodes[0].operations.reduce(applyCoherentStructure, tree);
  assert.ok(after["math.cpp"].includes("return x;"));
  assert.equal((after["math.cpp"].match(/int f\(int x\)/g) ?? []).length, 1);
  assert.ok(!after["main.cpp"].includes("return x;"));
});

test("placement consumers wait for their selected destination anchor, and final cleanup waits for moves", () => {
  const selector = (name) => ({ scope: "frond", declarator: `int${name}()`, definition: true });
  const move = (id, name) => ({
    id,
    phase: "structure",
    action: "implementation",
    file: "math.cpp",
    includes: [{ file: "math.h", quoted: true }],
    targets: [{ selector: selector(name) }],
  });
  const first = move("first", "first"),
    second = move("second", "second");
  second.targets[0].after = selector("first");
  const cleanup = {
    id: "cleanup",
    phase: "structure",
    action: "cleanup-empty-namespaces",
    includes: [],
  };
  const workload = atomicWorkload([
    {
      id: "task-004",
      phase: "structure",
      subsystem: "math.cpp",
      operations: [first, second, cleanup],
    },
  ]);
  assert.deepEqual(workload.nodes[1].dependencies, [workload.nodes[0].id]);
  assert.deepEqual(workload.nodes[2].dependencies, [workload.nodes[0].id, workload.nodes[1].id]);
});

test("vendor activation follows header extraction without merging two independently selectable edits", () => {
  const header = {
    id: "header",
    phase: "structure",
    action: "vendor-header",
    file: "support/stb_image/stb_image_resize.h",
    guard: "VENDOR_H",
    macro: "VENDOR_IMPLEMENTATION",
    declarationsCopy: 1,
    implementationCopy: 2,
  };
  const activation = {
    id: "activation",
    phase: "structure",
    action: "vendor-implementation",
    file: "support/stb.cpp",
    macro: "VENDOR_IMPLEMENTATION",
  };
  const workload = atomicWorkload([
    {
      id: "task-005",
      phase: "structure",
      subsystem: "image-resize",
      operations: [header, activation],
    },
  ]);
  assert.equal(workload.nodes.length, 2);
  assert.deepEqual(workload.nodes[1].dependencies, [workload.nodes[0].id]);
  assert.deepEqual(
    workload.nodes.flatMap((node) => node.operations),
    [header, activation],
  );
});

test("independent mappings remain sparse across a large task rather than inheriting a serial module chain", () => {
  const task = namingTask(
    Array.from({ length: 3000 }, (_, i) =>
      locals(`frond::f${i}`, [{ from: `old${i}`, to: `new${i}` }]),
    ),
  );
  const workload = atomicWorkload([task]);
  assert.equal(workload.nodes.length, 3000);
  assert.equal(
    workload.nodes.reduce((n, node) => n + node.dependencies.length, 0),
    0,
  );
});
