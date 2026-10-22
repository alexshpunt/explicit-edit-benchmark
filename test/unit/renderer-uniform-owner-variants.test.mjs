import assert from "node:assert/strict";
import test from "node:test";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";

const owner = (left = "left", right = "right", literal = 7) =>
  `int sum(int ${left}, int ${right}) { return ${left} + ${right} + ${literal}; }`;
const tree = (...owners) => ({ "math.cpp": `namespace frond { ${owners.join("\n")} }\n` });
const ownerRecords = (source) =>
  prepareCoherentContract(source).obligations.filter((record) => record.kind === "owner");

function project(record, current = "left", peer = "right") {
  return {
    ...record,
    masks: record.tokens.flatMap((token, index) =>
      token === current
        ? [{ index, role: "current", from: "original_current", to: current }]
        : token === peer
          ? [{ index, role: "peer", from: "original_peer", to: peer }]
          : [],
    ),
  };
}

function gate(expected = tree(owner(), owner()), current = "left", peer = "right") {
  const familyRecords = prepareCoherentContract(expected).obligations;
  const records = familyRecords
    .filter((record) => record.kind === "owner" && record.file === "math.cpp")
    .map((record) => project(record, current, peer));
  return { records, familyRecords };
}

const check = (actual, projection = gate(), options) =>
  evaluateAtomicBindingGate(actual, projection, options);

test("uniform owner copies aggregate incomplete and wrong peer variants without revoking the current rename", () => {
  const projection = gate();
  assert.equal(projection.records.length, 1);
  assert.equal(projection.records[0].count, 2);
  for (const actual of [
    tree(owner("left", "original_peer"), owner("left", "original_peer")),
    tree(owner(), owner("left", "original_peer")),
    tree(owner(), owner("left", "mistaken_peer")),
  ]) {
    const result = check(actual, projection);
    assert.equal(result.status, "pass");
    assert.deepEqual(
      result.observedIds.sort(),
      ownerRecords(actual)
        .map((record) => record.id)
        .sort(),
    );
    assert.equal(check(actual, gate(undefined, "right", "left")).status, "fail");
  }
  const onlyRight = tree(owner("original_current", "right"), owner());
  assert.equal(check(onlyRight).status, "fail");
  assert.equal(check(onlyRight, gate(undefined, "right", "left")).status, "pass");
  assert.equal(check(tree(owner(), owner())).status, "pass");
});

test("every owner variant must complete current masks while repair inputs and physical-only gates keep their existing meaning", () => {
  const actual = tree(owner(), owner("original_current", "mistaken_peer"));
  const projection = gate();
  const result = check(actual, projection);
  assert.equal(result.status, "fail");
  assert.deepEqual(
    result.observedIds.sort(),
    ownerRecords(actual)
      .map((record) => record.id)
      .sort(),
  );
  assert.equal(check(actual, projection, { activeWrites: true }).status, "pending");
  assert.equal(check(actual, projection, { input: true }).status, "pass");
  const physical = structuredClone(projection);
  for (const record of physical.records) for (const mask of record.masks) mask.role = "peer";
  assert.equal(check(actual, physical, { physicalOnly: true }).status, "pass");
  const missingIdentifier = tree(owner(), owner().replace("return left", "return"));
  assert.equal(check(missingIdentifier).status, "unobservable");
});

test("missing, extra and protected-corrupted copies cannot disappear into aggregated peer variants", () => {
  const complete = owner();
  const partialPeer = owner("left", "original_peer");
  for (const actual of [
    tree(complete),
    tree(complete, partialPeer, complete),
    tree(complete, partialPeer, owner("left", "right", 9)),
    tree(complete, owner("left", "original_peer", 9)),
    tree(complete, partialPeer.replace("left +", "left -")),
  ]) {
    assert.equal(check(actual).status, "unobservable");
    assert.equal(check(actual, undefined, { input: true }).status, "unobservable");
    assert.equal(check(actual, undefined, { activeWrites: true }).status, "pending");
  }
});

test("a failed multiplicity check still reserves every masked-compatible actual identity", () => {
  const actual = tree(owner(), owner("left", "original_peer"), owner("left", "mistaken_peer"));
  const result = check(actual);
  assert.equal(result.status, "unobservable");
  assert.deepEqual(
    result.observedIds.sort(),
    ownerRecords(actual)
      .map((record) => record.id)
      .sort(),
  );
});

test("variant aggregation retains the complete unrelated-family denominator", () => {
  const expected = {
    ...tree(owner(), owner()),
    "other.cpp": "namespace frond { " + owner("private_left", "private_right") + " }\n",
  };
  const projection = gate(expected);
  const actual = {
    ...tree(owner(), owner("left", "original_peer")),
    "other.cpp": expected["other.cpp"],
  };
  assert.equal(check(actual, projection).status, "pass");
  assert.equal(check(actual, { records: projection.records }).status, "unobservable");
  assert.equal(
    check(tree(owner(), owner("left", "original_peer")), projection).status,
    "unobservable",
  );
  assert.equal(
    check(
      {
        ...actual,
        "extra.cpp": "namespace frond { " + owner("wrong_left", "wrong_right", 9) + " }\n",
      },
      projection,
    ).status,
    "unobservable",
  );
});

test("intersecting multi-variant projections reserve all actual identities and revoke both outcomes", () => {
  const triple = (left, middle, right) =>
    `int sum(int ${left}, int ${middle}, int ${right}) { return ${left} + ${middle} + ${right} + 7; }`;
  const first = triple("left", "peer_middle", "fixed_right");
  const second = triple("left", "fixed_middle", "peer_right");
  const expected = tree(first, first, second, second);
  const familyRecords = prepareCoherentContract(expected).obligations;
  const records = ownerRecords(expected).map((record) =>
    project(record, "left", record.tokens.includes("peer_middle") ? "peer_middle" : "peer_right"),
  );
  const actual = tree(
    triple("left", "other_middle", "fixed_right"),
    triple("left", "fixed_middle", "fixed_right"),
    triple("left", "fixed_middle", "other_right"),
  );
  const expectedIds = ownerRecords(actual)
    .map((record) => record.id)
    .sort();
  for (const ordered of [records, [...records].reverse()]) {
    const result = check(actual, { records: ordered, familyRecords });
    assert.equal(result.status, "unobservable");
    assert.equal(result.records.length, 2);
    assert.ok(
      result.records.every(
        (record) => record.status === "unobservable" && record.reason === "ambiguous-owner",
      ),
    );
    assert.deepEqual(result.observedIds.sort(), expectedIds);
  }
});
