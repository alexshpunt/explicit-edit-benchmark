import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  scopedNamingSession,
  currentNamingSelectors,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { applyScopedNamePlan } from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

function certified(source, mappings) {
  const groups = mappings.map(({ from, to }) => ({
    mapping: { from, to },
    selectors: [{ kind: "variable", scope: from }],
  }));
  const operation = {
    id: "names",
    phase: "names",
    category: "locals-parameters",
    mapping: mappings,
    bindingGroups: groups,
    bindingCertification: {
      version: "renderer-atomic-bindings-v1",
      sha256: createHash("sha256").update(JSON.stringify(groups)).digest("hex"),
    },
  };
  const atoms = groups.map((group, bindingGroup) => ({
    bindingGroup,
    operation: {
      id: operation.id,
      phase: operation.phase,
      category: operation.category,
      mapping: [group.mapping],
      selectors: group.selectors,
    },
    plan: {
      id: operation.id,
      edits: [...source.matchAll(new RegExp(`\\b${group.mapping.from}\\b`, "g"))].map((match) => ({
        file: "main.cpp",
        start: match.index,
        old: group.mapping.from,
        new: group.mapping.to,
      })),
    },
  }));
  return {
    operation,
    atoms,
    plan: { id: operation.id, edits: atoms.flatMap((atom) => atom.plan.edits) },
  };
}

function seal(tree, certification, applied = []) {
  return coherentNamingPlans(tree, [certification.plan], applied, [certification]);
}

test("union and binding plans share the group-start source after earlier length changes", () => {
  const source = "int prior = 1; int arg = prior; int other = arg;\n";
  const previous = {
    id: "previous",
    edits: [
      { file: "main.cpp", start: source.indexOf("prior"), old: "prior", new: "previous_name" },
    ],
  };
  const tree = applyScopedNamePlan({ "main.cpp": source }, previous);
  const certification = certified(source, [
    { from: "arg", to: "value" },
    { from: "other", to: "x" },
  ]);
  const original = structuredClone(certification);
  const record = seal(tree, certification, [previous]);
  assert.equal(record.version, "renderer-coherent-atomic-plans-v1");
  assert.equal(record.bindings.length, 1);
  assert.deepEqual(record.bindings[0].operation, certification.operation);
  assert.deepEqual(
    record.bindings[0].atoms.map((atom) => atom.bindingGroup),
    [0, 1],
  );
  for (const atom of record.bindings[0].atoms)
    for (const edit of atom.plan.edits)
      assert.equal(tree[edit.file].slice(edit.start, edit.start + edit.old.length), edit.old);
  let actual = tree;
  const applied = [];
  for (const atom of record.bindings[0].atoms) {
    actual = applyScopedNamePlan(actual, atom.plan, applied);
    applied.push(atom.plan);
  }
  assert.deepEqual(actual, applyScopedNamePlan(tree, record.plans[0]));
  assert.deepEqual(certification, original);
});

test("missing, overlapping or substituted atom edits cannot seal a compiler union", () => {
  const source = "int arg = 1; int other = arg;\n";
  const original = certified(source, [
    { from: "arg", to: "value" },
    { from: "other", to: "x" },
  ]);
  const mutations = [
    (item) => item.atoms[0].plan.edits.pop(),
    (item) => item.atoms[1].plan.edits.push(item.atoms[0].plan.edits[0]),
    (item) => {
      item.atoms[0].plan.edits[0].new = "wrong";
    },
    (item) => {
      item.atoms[1].bindingGroup = 0;
    },
    (item) => {
      item.atoms[0].operation.selectors = [{ kind: "variable", scope: "other" }];
    },
    (item) => {
      item.operation.bindingCertification.sha256 = "0".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.throws(() => seal({ "main.cpp": source }, candidate), /Certified|certified|binding/i);
  }
});

test("earlier type renames change a certified function selector even when its physical binding is unchanged", async () => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/coherent-certified-plans-"));
  const tree = {
    "main.cpp":
      "namespace first { struct OldType {}; }\nnamespace second { int old(first::OldType arg) { return 1; } }\nint main() { return second::old(first::OldType{}); }\n",
  };
  let origins;
  const session = await scopedNamingSession(tree, directory, {
    onSelection: (selected) => {
      origins = selected;
    },
  });
  let currentSession;
  try {
    const type = await session.atomicPlans({
      id: "type",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "OldType", to: "RestoredType" }],
      selectors: [{ kind: "type", scope: "first::OldType" }],
    });
    const functionRequest = {
      id: "function",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "old", to: "renamed" }],
      selectors: [
        {
          kind: "function",
          scope: "second::old",
          owner: { scope: "second::old", signature: "int (first::OldType)" },
        },
      ],
    };
    const functionBinding = await session.atomicPlans(functionRequest);
    const current = applyScopedNamePlan(tree, type.plan);
    const sealed = seal(current, functionBinding, [type.plan]);
    const rebasedOrigins = origins.map((origin) => ({
      ...origin,
      start:
        origin.start +
        type.plan.edits
          .filter((edit) => edit.file === origin.file && edit.start < origin.start)
          .reduce((sum, edit) => sum + edit.new.length - edit.old.length, 0),
    }));
    const [selectors] = await currentNamingSelectors(current, [rebasedOrigins], directory);
    assert.notDeepEqual(selectors, functionBinding.atoms[0].operation.selectors);
    assert.equal(selectors[0].owner.signature, "int (first::RestoredType)");
    await mkdir(path.join(directory, "current"));
    currentSession = await scopedNamingSession(current, path.join(directory, "current"));
    await assert.rejects(
      currentSession.atomicPlans(functionRequest),
      /Missing current owner\/signature binding/,
    );
    const refreshed = await currentSession.atomicPlans({ ...functionRequest, selectors });
    assert.deepEqual(refreshed.plan.edits, sealed.plans[0].edits);
    assert.deepEqual(refreshed.atoms[0].operation.selectors, selectors);
  } finally {
    session.close();
    currentSession?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("private certification records remain paired with their original operation union", () => {
  const source = "int arg = 1;\n";
  const certification = certified(source, [{ from: "arg", to: "value" }]);
  assert.throws(
    () => coherentNamingPlans({ "main.cpp": source }, [certification.plan], [], []),
    /certified|Certified/,
  );
  const wrongUnion = structuredClone(certification.plan);
  wrongUnion.edits[0].new = "wrong";
  assert.throws(
    () => coherentNamingPlans({ "main.cpp": source }, [wrongUnion], [], [certification]),
    /union|Union/,
  );
});
