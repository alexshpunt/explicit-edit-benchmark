import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";

const source = "namespace frond { int sum(int left, int right) { return left + right + 7; } }\n";
const tree = (value, file = "math.cpp") => ({ [file]: value });

function projected(expected, current = "left", peer = "right") {
  return {
    records: prepareCoherentContract(expected)
      .obligations.filter((record) => record.kind === "owner")
      .map((record) => ({
        ...record,
        masks: record.tokens.flatMap((token, index) =>
          token === current
            ? [{ index, role: "current", from: "a", to: current }]
            : token === peer
              ? [{ index, role: "peer", from: "b", to: peer }]
              : [],
        ),
      })),
  };
}

const check = (actual, gate = projected(tree(source)), options) =>
  evaluateAtomicBindingGate(actual, gate, options);

test("independent renames in one owner do not falsely fail each other", () => {
  const incomplete = source.replace("return left + right", "return left + b");
  assert.equal(check(tree(incomplete)).status, "pass");
  assert.equal(check(tree(incomplete), projected(tree(source), "right", "left")).status, "fail");
  const wrongPeer = source.replaceAll("right", "unrelated");
  assert.equal(check(tree(wrongPeer)).status, "pass");
  assert.equal(check(tree(source.replaceAll("right", "b"))).status, "pass");
});

test("a reserved peer position may have an old baseline in the trusted frontier", () => {
  const baseline = source.replaceAll("right", "b");
  const gate = projected(tree(baseline), "left", "b");
  for (const record of gate.records)
    for (const mask of record.masks)
      if (mask.role === "peer") Object.assign(mask, { from: "b", to: "right" });
  assert.equal(check(tree(baseline), gate).status, "pass");
  assert.equal(check(tree(source), gate).status, "pass");
});
test("an old or wrong current token is an observable failed binding", () => {
  for (const actual of [
    source.replaceAll("left", "a"),
    source.replace("return left", "return mistaken"),
  ]) {
    assert.equal(check(tree(actual)).status, "fail");
    assert.equal(check(tree(actual), undefined, { activeWrites: true }).status, "pending");
  }
  assert.equal(check(tree(source)).status, "pass");
});

test("repair input accepts partial or wrong current identifiers without granting completion", () => {
  const gate = projected(tree(source));
  for (const actual of [
    source.replace("return left", "return a"),
    source.replaceAll("left", "mistaken"),
    source.replaceAll("left", "a"),
  ]) {
    assert.equal(check(tree(actual), gate, { input: true }).status, "pass");
    assert.equal(check(tree(actual), gate).status, "fail");
  }
});

test("input projection still protects verified predecessor tokens and literals", () => {
  const expected = source.replaceAll("right", "predecessor");
  const gate = projected(tree(expected), "left", "no_peer");
  const partial = expected.replace("return left", "return a");
  assert.equal(check(tree(partial), gate, { input: true }).status, "pass");
  for (const actual of [
    partial.replace("+ predecessor", "+ regressed"),
    partial.replace("+ 7", "+ 9"),
  ]) {
    assert.equal(check(tree(actual), gate, { input: true }).status, "unobservable");
    assert.equal(check(tree(actual), gate, { input: true, activeWrites: true }).status, "pending");
  }
});

test("repair input cannot waive missing, duplicated or invalid owner observations", () => {
  const gate = projected(tree(source));
  for (const actual of [
    {},
    tree(source + source),
    { ...tree(source), "main.cpp": source },
    tree(source.replaceAll("left", "?")),
  ])
    assert.equal(check(actual, gate, { input: true }).status, "unobservable");
  for (const records of [
    [],
    gate.records.map((record) => ({ ...record, masks: [] })),
    gate.records.map((record) => ({
      ...record,
      masks: record.masks.map((mask) => ({ ...mask, role: "peer" })),
    })),
  ])
    assert.throws(() => check(tree(source), { records }, { input: true }), /record|current/i);
});
test("protected literal and operator corruption is not attributed to the current atom", () => {
  for (const actual of [
    source.replace("+ 7", "+ 9"),
    source.replace("left + right", "left - right"),
  ]) {
    assert.equal(check(tree(actual)).status, "unobservable");
    assert.equal(check(tree(actual), undefined, { activeWrites: true }).status, "pending");
  }
});

test("invalid peer tokens and incomplete source stay unobservable, not successful", () => {
  for (const actual of [
    source.replaceAll("right", "?"),
    source.replaceAll("right", "return"),
    source.slice(0, -3),
  ]) {
    assert.equal(check(tree(actual)).status, "unobservable");
    assert.equal(check(tree(actual), undefined, { activeWrites: true }).status, "pending");
  }
});

test("an unrelated overload cannot satisfy the selected binding", () => {
  const expected = tree("namespace frond { int pick(int left) { return left; } }\n");
  const gate = projected(expected);
  const wrong = tree("namespace frond { float pick(float left) { return left; } }\n");
  assert.equal(check(wrong, gate).status, "unobservable");
  assert.equal(check({ ...expected, "other.cpp": wrong["math.cpp"] }, gate).status, "pass");
});

test("physical ownership, namespace and exact multiplicity stay mandatory", () => {
  const gate = projected(tree(source));
  assert.equal(check({}, gate).status, "unobservable");
  assert.equal(check(tree(source, "elsewhere.cpp"), gate).status, "unobservable");
  assert.equal(check(tree(source.replace("frond", "elsewhere")), gate).status, "unobservable");
  assert.equal(check(tree(source + source), gate).status, "unobservable");
  assert.equal(check({ ...tree(source), "main.cpp": source }, gate).status, "unobservable");
  assert.equal(
    check({ ...tree(source), "main.cpp": source.replace("+ 7", "+ 8") }, gate).status,
    "unobservable",
  );
});

test("explicit legitimate owner copies pass only with their full expected multiplicity", () => {
  const actual = { "math.cpp": source, "other.cpp": source };
  assert.equal(check(actual, projected(actual)).status, "pass");
  const duplicate = tree(source + source);
  const gate = projected(duplicate);
  assert.equal(gate.records[0].count, 2);
  assert.equal(check(duplicate, gate).status, "pass");
  assert.equal(check(tree(source), gate).status, "unobservable");
});

test("macro and conditional context and inactive variants are physical requirements", () => {
  const expected = tree(
    "#define SCALE 2\nnamespace frond {\n#if ACTIVE\nint scale(int left) { return left * SCALE; }\n#else\nint scale(double left) { return int(left) + 1; }\n#endif\n}\n",
  );
  const gate = projected(expected);
  assert.equal(check(expected, gate).status, "pass");
  for (const actual of [
    expected["math.cpp"].replace("SCALE 2", "SCALE 3"),
    expected["math.cpp"].replace("#if ACTIVE", "#if OTHER"),
    expected["math.cpp"].replace("double left", "double a"),
    expected["math.cpp"].replace("+ 1", "+ 2"),
  ]) {
    const result = check(tree(actual), gate);
    assert.notEqual(result.status, "pass");
    assert.equal(check(tree(actual), gate, { activeWrites: true }).status, "pending");
  }
  const staleInactiveUse = expected["math.cpp"].replace("int(left)", "int(a)");
  assert.equal(check(tree(staleInactiveUse), gate).status, "fail");
});

test("masks can change a declarator without using its stale selector text", () => {
  const expected = tree("namespace frond { int renamed(int x) { return x; } }\n");
  const gate = projected(expected, "renamed", "absent");
  gate.records[0].masks[0].from = "old_name";
  assert.equal(check(expected, gate).status, "pass");
  assert.equal(
    check(tree(expected["math.cpp"].replace("renamed", "old_name")), gate).status,
    "fail",
  );
});

test("a selected file-local binding uses complete trusted family counts across identical translation units", () => {
  const local = "static int pick(int a) { return a + 7; }";
  const expected = {
    "first.cpp": local.replaceAll(/\ba\b/g, "left"),
    "second.cpp": local,
  };
  const all = prepareCoherentContract(expected).obligations;
  const records = projected(expected, "left", "absent").records.filter(
    (record) => record.file === "first.cpp",
  );
  const gate = { records, familyRecords: all };
  assert.equal(check(expected, { records }).status, "unobservable");
  assert.equal(check(expected, gate).status, "pass");
  const incomplete = {
    ...expected,
    "first.cpp": expected["first.cpp"].replace("return left", "return a"),
  };
  assert.equal(check(incomplete, gate).status, "fail");
  const physical = {
    records: records.map((record) => ({
      ...record,
      masks: record.masks.map((mask) => ({ ...mask, role: "peer" })),
    })),
    familyRecords: all,
  };
  assert.equal(check(incomplete, physical, { physicalOnly: true }).status, "pass");
  for (const copied of [local, local.replace("+ 7", "+ 9"), expected["first.cpp"]]) {
    const actual = { ...expected, "extra.cpp": copied };
    assert.equal(check(actual, gate).status, "unobservable");
    assert.equal(check(actual, physical, { physicalOnly: true }).status, "unobservable");
    assert.equal(check(actual, gate, { activeWrites: true }).status, "pending");
  }
  assert.equal(check({ ...expected, "first.cpp": "" }, gate).status, "unobservable");
  for (const references of [
    [],
    all.filter((record) => record.file !== "first.cpp"),
    [...all, all[0]],
    all.map((record) => (record.file === "first.cpp" ? { ...record, count: 2 } : record)),
    all.map((record) =>
      record.file === "first.cpp"
        ? { ...record, tokens: record.tokens.map((token) => (token === "left" ? "a" : token)) }
        : record,
    ),
    all.map((record) => ({ ...record, count: 0 })),
    all.map((record) =>
      record.file === "second.cpp" ? { ...record, selector: "invalid" } : record,
    ),
  ])
    assert.throws(
      () => check(expected, { records, familyRecords: references }),
      /family|reference|count|declarator/i,
    );
});

test("physical-only projections reserve peer sites without pretending a rename completed", () => {
  const gate = projected(tree(source));
  for (const record of gate.records)
    record.masks = record.masks.map((mask) => ({ ...mask, role: "peer" }));
  const actual = tree(source.replace("return left", "return a"));
  const result = check(actual, gate, { physicalOnly: true });
  assert.equal(result.status, "pass");
  assert.deepEqual(
    result.observedIds,
    prepareCoherentContract(actual)
      .obligations.filter((record) => record.kind === "owner")
      .map((record) => record.id),
  );
  assert.throws(() => check(actual, gate), /current/i);
  assert.throws(() => check(actual, gate, { physicalOnly: true, input: true }), /input/i);
  assert.throws(
    () => check(actual, projected(tree(source)), { physicalOnly: true }),
    /peer|current/i,
  );
  assert.throws(
    () =>
      check(
        actual,
        { records: gate.records.map((record) => ({ ...record, masks: [] })) },
        { physicalOnly: true },
      ),
    /mask/i,
  );
  for (const changed of [
    tree(source.replace("+ 7", "+ 9")),
    tree(source, "elsewhere.cpp"),
    { ...actual, "main.cpp": source.replace("+ 7", "+ 8") },
  ]) {
    assert.equal(check(changed, gate, { physicalOnly: true }).status, "unobservable");
    assert.equal(
      check(changed, gate, { physicalOnly: true, activeWrites: true }).status,
      "pending",
    );
  }
});

test("malformed or vacuous private masks fail closed before observation", () => {
  const mutate = [
    (gate) => {
      gate.records = [];
    },
    (gate) => {
      gate.records[0].masks = [];
    },
    (gate) => {
      gate.records[0].masks = gate.records[0].masks.map((mask) => ({ ...mask, role: "peer" }));
    },
    (gate) => {
      gate.records[0].masks[0].index = -1;
    },
    (gate) => {
      gate.records[0].masks[0].index = 0.5;
    },
    (gate) => {
      gate.records[0].masks[0].index = gate.records[0].tokens.length;
    },
    (gate) => {
      gate.records[0].masks.push({ ...gate.records[0].masks[0] });
    },
    (gate) => {
      gate.records[0].masks[0].role = "unknown";
    },
    (gate) => {
      gate.records[0].masks[0].from = "?";
    },
    (gate) => {
      gate.records[0].masks[0].to = "wrong_expected_token";
    },
    (gate) => {
      gate.records[0].count = 0;
    },
    (gate) => {
      gate.records[0].count = 1.5;
    },
    (gate) => {
      gate.records[0].tokens[0] = ["nested"];
    },
    (gate) => {
      gate.records[0].kind = "conditional";
    },
    (gate) => {
      gate.records[0].selector = "not_the_full_declarator";
    },
  ];
  for (const change of mutate) {
    const gate = projected(tree(source));
    change(gate);
    assert.throws(() => check(tree(source), gate), /mask|record|count|current|token/i);
  }
});
