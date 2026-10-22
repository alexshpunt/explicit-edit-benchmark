import assert from "node:assert/strict";
import test from "node:test";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";
import {
  prepareAtomicGate,
  projectAtomicGate,
  evaluateAtomicGate,
  checkAtomicInputs,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-gate.mjs";

const before = {
  "main.cpp": `namespace frond {
int selected(int old) { const char* text = "old"; return old + (text[0] == 'o'); }
int peer(int old) { return old + 1; }
}
`,
};
const after = {
  "main.cpp": before["main.cpp"]
    .replace("selected(int old)", "selected(int value)")
    .replace("return old + (", "return value + ("),
};

await test("rebased header output requires only files in the current trusted frontier", () => {
  const initial = {
    "main.cpp":
      "#ifndef FIRST_H\n#define FIRST_H\nnamespace frond { using std::array; int first(); }\n#endif\n#ifndef SECOND_H\n#define SECOND_H\nnamespace frond { using std::array; int second(); }\n#endif\n",
  };
  const operations = ["FIRST", "SECOND"].map((name) => ({
    phase: "structure",
    action: "header",
    guard: name + "_H",
    file: name.toLowerCase() + ".h",
    includes: [],
  }));
  const first = applyCoherentStructure(initial, operations[0]);
  const both = applyCoherentStructure(first, operations[1]);
  const template = prepareAtomicGate(first, both, { writesOnly: true });
  assert.ok(template.requiredFiles.after.includes("first.h"));
  const reverse = applyCoherentStructure(initial, operations[1]);
  const gate = projectAtomicGate(reverse, template);
  assert.equal(evaluateAtomicGate(reverse, gate).status, "pass");
  assert.ok(!gate.requiredFiles.after.includes("first.h"));
  assert.ok(gate.requiredFiles.after.includes("second.h"));
  assert.notEqual(evaluateAtomicGate(initial, gate).status, "pass");
});

await test("a retained move reserves unverified peer rename sites but preserves physical and protected requirements", () => {
  const initial = {
    "main.cpp":
      "namespace frond { int selected(int old) { return old + 7; } int peer() { return 2; } }",
  };
  const moved = {
    "main.cpp": "namespace frond { int peer() { return 2; } }",
    "module.cpp": "namespace frond { int selected(int old) { return old + 7; } }",
  };
  const expected = { ...moved, "module.cpp": moved["module.cpp"].replaceAll("old", "value") };
  const template = prepareAtomicGate(initial, moved);
  // The controller retains consumed families when a peer changes a declarator.
  for (const record of prepareCoherentContract(expected).obligations)
    if (record.kind === "owner" && record.file === "module.cpp")
      template.resources.push(JSON.stringify([record.kind, record.scope, record.selector]));
  const gate = projectAtomicGate(expected, template);
  const records = prepareCoherentContract(expected)
    .obligations.filter((record) => record.kind === "owner" && record.file === "module.cpp")
    .map((record) => ({
      ...record,
      masks: record.tokens.flatMap((token, index) =>
        token === "value" ? [{ index, role: "peer", from: "old", to: "value" }] : [],
      ),
    }));
  const actual = {
    ...expected,
    "module.cpp": expected["module.cpp"].replace("return value", "return old"),
  };
  assert.notEqual(evaluateAtomicGate(actual, gate).status, "pass");
  assert.equal(evaluateAtomicGate(actual, gate, { bindingRecords: records }).status, "pass");
  const renameRecords = records.map((record) => ({
    ...record,
    masks: record.masks.map((mask) => ({ ...mask, role: "current" })),
  }));
  assert.equal(evaluateAtomicBindingGate(actual, { records: renameRecords }).status, "fail");
  for (const corrupted of [
    { ...actual, "module.cpp": actual["module.cpp"].replace("+ 7", "+ 9") },
    { "main.cpp": actual["main.cpp"], "wrong.cpp": actual["module.cpp"] },
    { ...actual, "main.cpp": initial["main.cpp"] },
    { ...actual, "main.cpp": initial["main.cpp"].replace("+ 7", "+ 8") },
  ]) {
    assert.notEqual(
      evaluateAtomicGate(corrupted, gate, { bindingRecords: records }).status,
      "pass",
    );
    assert.equal(
      evaluateAtomicGate(corrupted, gate, { bindingRecords: records, activeWrites: true }).status,
      "pending",
    );
  }
  assert.throws(
    () =>
      evaluateAtomicGate(actual, gate, {
        bindingRecords: records.map((record) => ({ ...record, file: "wrong.cpp" })),
      }),
    /delegated|expected/i,
  );
  assert.throws(
    () =>
      evaluateAtomicGate(actual, gate, {
        bindingRecords: records.map((record) => ({ ...record, masks: [] })),
      }),
    /mask/i,
  );
});

await test("binding delegation cannot hide another moved owner or change the trusted output record", () => {
  const initial = { "main.cpp": "int selected(int old) { return old; } int plain() { return 9; }" };
  const expected = {
    "main.cpp": "",
    "module.cpp": "int selected(int value) { return value; } int plain() { return 9; }",
  };
  const gate = prepareAtomicGate(initial, expected);
  const record = gate.add.find(
    (item) => item.kind === "owner" && item.selector.includes("selected"),
  );
  const delegated = {
    ...record,
    masks: record.tokens.flatMap((token, index) =>
      token === "value" ? [{ index, role: "peer", from: "old", to: "value" }] : [],
    ),
  };
  const actual = {
    ...expected,
    "module.cpp": expected["module.cpp"].replace("return value", "return old"),
  };
  assert.equal(evaluateAtomicGate(actual, gate, { bindingRecords: [delegated] }).status, "pass");
  assert.equal(
    evaluateAtomicGate(
      { ...actual, "module.cpp": actual["module.cpp"].replace("return 9", "return 8") },
      gate,
      { bindingRecords: [delegated] },
    ).status,
    "fail",
  );
  for (const changed of [
    { ...delegated, count: 2 },
    { ...delegated, tokens: delegated.tokens.map((token) => (token === "int" ? "float" : token)) },
    { ...delegated, id: "invented" },
  ])
    assert.throws(
      () => evaluateAtomicGate(actual, gate, { bindingRecords: [changed] }),
      /delegated|expected/i,
    );
});

await test("structural delegation forwards complete trusted families without inventing duplicate translation-unit definitions", () => {
  const local = "static int pick(int a) { return a + 7; }";
  const initial = { "first.cpp": local, "second.cpp": local };
  const moved = { "first.cpp": "", "second.cpp": local, "module.cpp": local };
  const expected = { ...moved, "module.cpp": local.replaceAll(/\ba\b/g, "left") };
  const familyRecords = prepareCoherentContract(expected).obligations;
  const record = familyRecords.find((item) => item.kind === "owner" && item.file === "module.cpp");
  const template = prepareAtomicGate(initial, moved);
  template.resources.push(JSON.stringify([record.kind, record.scope, record.selector]));
  const gate = projectAtomicGate(expected, template);
  const bindingRecords = [
    {
      ...record,
      masks: record.tokens.flatMap((token, index) =>
        token === "left" ? [{ index, role: "peer", from: "a", to: "left" }] : [],
      ),
    },
  ];
  const actual = {
    ...expected,
    "module.cpp": expected["module.cpp"].replace("return left", "return a"),
  };
  assert.equal(evaluateAtomicGate(actual, gate, { bindingRecords }).status, "unobservable");
  assert.equal(evaluateAtomicGate(actual, gate, { bindingRecords, familyRecords }).status, "pass");
  for (const copy of [local, local.replace("+ 7", "+ 8")])
    assert.notEqual(
      evaluateAtomicGate({ ...actual, "extra.cpp": copy }, gate, { bindingRecords, familyRecords })
        .status,
      "pass",
    );
});

await test("one bound rename is checked without imposing unrelated peer endpoints", () => {
  const gate = JSON.parse(JSON.stringify(prepareAtomicGate(before, after)));
  assert.equal(checkAtomicInputs(before, gate).status, "pass");
  assert.equal(evaluateAtomicGate(before, gate).status, "fail");
  assert.equal(evaluateAtomicGate(after, gate).status, "pass");
  const peerEdited = {
    ...after,
    "main.cpp": after["main.cpp"].replace(
      "peer(int old) { return old + 1; }",
      "peer(int next) { return next + 2; }",
    ),
    "peer.cpp": "int unrelated() { return 3; }\n",
  };
  assert.equal(evaluateAtomicGate(peerEdited, gate, { activeWrites: true }).status, "pass");
  assert.equal(
    checkAtomicInputs({ ...before, "unrelated.h": "struct Extra {};" }, gate).status,
    "pass",
  );
});

await test("missing bound uses, changed literals and the wrong owner cannot satisfy a rename", () => {
  const gate = prepareAtomicGate(before, after);
  const cases = [
    { "main.cpp": after["main.cpp"].replace("return value + (", "return old + (") },
    { "main.cpp": after["main.cpp"].replace('"old"', '"changed"') },
    {
      "main.cpp": before["main.cpp"].replace(
        "peer(int old) { return old + 1; }",
        "peer(int value) { return value + 1; }",
      ),
    },
  ];
  for (const tree of cases) {
    const result = evaluateAtomicGate(tree, gate);
    assert.equal(result.status, "fail");
    assert.ok(result.obligations.some((item) => item.status === "fail"));
  }
});

await test("field renames require both their record and every changed use", () => {
  const initial = {
    "main.cpp":
      "struct First { int old; }; struct Other { int old; }; int use(First x, Other y) { return x.old + y.old; }",
  };
  const expected = {
    "main.cpp": initial["main.cpp"]
      .replace("First { int old; }", "First { int value; }")
      .replace("x.old", "x.value"),
  };
  const gate = prepareAtomicGate(initial, expected);
  assert.equal(evaluateAtomicGate(expected, gate).status, "pass");
  assert.equal(
    evaluateAtomicGate({ "main.cpp": expected["main.cpp"].replace("x.value", "x.old") }, gate)
      .status,
    "fail",
  );
  assert.equal(
    evaluateAtomicGate(
      {
        "main.cpp": initial["main.cpp"]
          .replace("Other { int old; }", "Other { int value; }")
          .replace("y.old", "y.value"),
      },
      gate,
    ).status,
    "fail",
  );
});

await test("a move requires one physical definition and rejects even a changed retained copy", () => {
  const initial = {
    "main.cpp": "namespace frond { int selected() { return 1; } int peer() { return 2; } }",
  };
  const expected = {
    "main.cpp": "namespace frond { int peer() { return 2; } }",
    "module.cpp": "namespace frond { int selected() { return 1; } }",
  };
  const gate = prepareAtomicGate(initial, expected);
  assert.equal(checkAtomicInputs(initial, gate).status, "pass");
  assert.equal(checkAtomicInputs(expected, gate).status, "fail");
  assert.equal(evaluateAtomicGate(expected, gate).status, "pass");
  for (const source of [initial["main.cpp"], initial["main.cpp"].replace("return 1", "return 9")])
    assert.equal(evaluateAtomicGate({ ...expected, "main.cpp": source }, gate).status, "fail");
  assert.equal(evaluateAtomicGate({ ...expected, "module.cpp": "" }, gate).status, "fail");
  assert.equal(evaluateAtomicGate({ "main.cpp": expected["main.cpp"] }, gate).status, "fail");
});

await test("unmodified declarations in the affected owner family remain valid input and output requirements", () => {
  const initial = { ...before, "api.h": "namespace frond { int selected(int old); }" };
  const expected = { ...after, "api.h": initial["api.h"] };
  const gate = prepareAtomicGate(initial, expected);
  assert.equal(evaluateAtomicGate(expected, gate).status, "pass");
  assert.equal(
    evaluateAtomicGate(
      { ...expected, "api.h": "namespace frond { int selected(int wrong); }" },
      gate,
    ).status,
    "fail",
  );
});

await test("inactive branches and their conditional and macro context are preserved", () => {
  const initial = {
    "main.cpp":
      "#define STEP 1\nnamespace frond {\n#ifdef FEATURE\nint selected(int old) { return old + STEP; }\n#else\nint selected(int old) { return old + 2; }\n#endif\n}\n",
  };
  const expected = { "main.cpp": initial["main.cpp"].replaceAll("old", "value") };
  const gate = prepareAtomicGate(initial, expected);
  assert.equal(evaluateAtomicGate(expected, gate).status, "pass");
  for (const text of [
    expected["main.cpp"].replace("return value + 2", "return old + 2"),
    expected["main.cpp"].replace("#ifdef FEATURE", "#ifdef OTHER"),
    expected["main.cpp"].replace("#define STEP 1", "#define STEP 9"),
    expected["main.cpp"].replace("namespace frond", "namespace wrong"),
  ])
    assert.equal(evaluateAtomicGate({ "main.cpp": text }, gate).status, "fail");
});

await test("uncertain peer observations defer a gate and a drained mismatch fails", () => {
  const gate = prepareAtomicGate(before, after);
  const malformed = { ...after, "peer.cpp": "namespace peer {" };
  assert.equal(evaluateAtomicGate(malformed, gate, { activeWrites: true }).status, "pending");
  assert.equal(evaluateAtomicGate(malformed, gate).status, "fail");
  assert.equal(checkAtomicInputs(malformed, gate, { activeWrites: true }).status, "pending");
  assert.equal(checkAtomicInputs(malformed, gate).status, "fail");
  assert.equal(evaluateAtomicGate(before, gate, { activeWrites: true }).status, "pending");
  assert.equal(evaluateAtomicGate(after, gate, { activeWrites: true }).status, "pass");
});

await test("successor input checks detect overwritten predecessors before dispatch", () => {
  const next = { "main.cpp": after["main.cpp"].replace("(text[0] == 'o')", "(text[0] == 'p')") };
  const successor = prepareAtomicGate(after, next);
  assert.equal(checkAtomicInputs(after, successor).status, "pass");
  assert.equal(checkAtomicInputs(before, successor).status, "fail");
  assert.equal(checkAtomicInputs(before, successor, { activeWrites: true }).status, "pending");
});

await test("standard import alternatives keep the full grader's bounded context exception", () => {
  const initial = {
    "main.cpp": "namespace frond { using std::size_t; int selected() { return 1; } }",
  };
  const expected = {
    "main.cpp": "",
    "module.cpp": "namespace frond { using std::size_t; int selected() { return 1; } }",
  };
  const gate = prepareAtomicGate(initial, expected);
  const alternative = {
    ...expected,
    "module.cpp": expected["module.cpp"].replace("using std::size_t; ", ""),
  };
  assert.equal(evaluateAtomicGate(alternative, gate).status, "pass");
  const broadInitial = {
    "main.cpp": initial["main.cpp"].replace("using std::size_t", "using namespace elsewhere"),
  };
  const broadExpected = {
    ...expected,
    "module.cpp": expected["module.cpp"].replace("using std::size_t", "using namespace elsewhere"),
  };
  const broad = prepareAtomicGate(broadInitial, broadExpected);
  assert.equal(
    evaluateAtomicGate(
      {
        ...broadExpected,
        "module.cpp": broadExpected["module.cpp"].replace("using namespace elsewhere; ", ""),
      },
      broad,
    ).status,
    "fail",
  );
});

await test("extra declarations and colliding rename output cannot hide inside a valid endpoint", () => {
  const gate = prepareAtomicGate(before, after);
  assert.equal(
    evaluateAtomicGate({ ...after, "duplicate.cpp": after["main.cpp"] }, gate).status,
    "fail",
  );
  const collision = {
    "main.cpp": after["main.cpp"].replace("const char* text", "int value = 9; const char* text"),
  };
  assert.equal(evaluateAtomicGate(collision, gate).status, "fail");
});
await test("files emptied by an atomic edit remain required unless trusted preparation deletes them", () => {
  const initial = { "main.cpp": "int selected() { return 1; }" };
  const empty = { "main.cpp": "" };
  const gate = prepareAtomicGate(initial, empty);
  assert.equal(evaluateAtomicGate(empty, gate).status, "pass");
  assert.equal(evaluateAtomicGate({}, gate).status, "fail");
  const deletion = prepareAtomicGate(initial, {});
  assert.equal(evaluateAtomicGate({}, deletion).status, "pass");
  assert.equal(evaluateAtomicGate(empty, deletion).status, "fail");
});
await test("no-effect and malformed private preparation cannot manufacture a passing gate", () => {
  assert.throws(() => prepareAtomicGate(before, before), /no structural effect/i);
  assert.throws(() => prepareAtomicGate(before, { "main.cpp": "namespace frond {" }));
});

await test("a structural write projection does not claim a peer's context-only owner change", () => {
  const initial = {
    "main.cpp":
      "#ifndef FIRST_H\n#define FIRST_H\nnamespace frond { struct First { int value; }; }\n#endif\n#ifdef FIRST_H\nint residual(int old) { return old; }\n#endif\n",
  };
  const after = applyCoherentStructure(initial, {
    action: "header",
    file: "first.h",
    guard: "FIRST_H",
    includes: [],
  });
  const peerPartial = { ...after, "main.cpp": after["main.cpp"].replace("int old", "int value") };
  assert.equal(evaluateAtomicGate(peerPartial, prepareAtomicGate(initial, after)).status, "fail");
  const projected = prepareAtomicGate(initial, after, { writesOnly: true });
  assert.equal(evaluateAtomicGate(peerPartial, projected).status, "pass");
  assert.equal(
    evaluateAtomicGate(
      { ...peerPartial, "first.h": after["first.h"].replace("int value", "float value") },
      projected,
    ).status,
    "fail",
  );
  assert.equal(
    evaluateAtomicGate(
      { ...peerPartial, "first.h": after["first.h"].replace("#ifndef FIRST_H", "#ifdef FIRST_H") },
      projected,
    ).status,
    "fail",
  );
});
