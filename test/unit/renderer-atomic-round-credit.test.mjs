import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  prepareAtomicNamingBatch,
  applyAtomicNamingBatch,
} from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-naming-replay.mjs";
import { indexBarrierSymbolMap } from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";
import {
  prepareAtomicRoundCredit,
  evaluateAtomicRoundCredit,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-round-credit.mjs";

const before = {
  "main.cpp": `namespace frond {
int combine(int left, int right) { return left + right; }
int untouched() { return 7; }
}
`,
};

function plans(tree, renames) {
  return renames.map(([id, from, to]) => ({
    id,
    plan: {
      edits: Object.entries(tree).flatMap(([file, source]) =>
        [...source.matchAll(new RegExp(`\\b${from}\\b`, "g"))].map((match) => ({
          file,
          start: match.index,
          old: from,
          new: to,
        })),
      ),
    },
  }));
}

async function fixture(
  t,
  tree = before,
  renames = [
    ["left", "left", "leftName"],
    ["right", "right", "rightName"],
  ],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-round-credit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let index = 0;
  const symbols = (source) =>
    indexBarrierSymbolMap(source, { evidence: path.join(directory, String(index++)) });
  const bindings = plans(tree, renames);
  const batch = prepareAtomicNamingBatch(tree, bindings);
  const expectedTree = applyAtomicNamingBatch(tree, batch, batch.ids).tree;
  const prepared = prepareAtomicRoundCredit({
    beforeTree: tree,
    expectedTree,
    nodes: bindings.map(({ id }) => ({ id, operations: [{ phase: "names" }] })),
    namingBatches: [batch],
    expectedSymbols: await symbols(expectedTree),
  });
  return {
    expectedTree,
    async grade(candidate) {
      return evaluateAtomicRoundCredit(candidate, prepared, {
        candidateSymbols: await symbols(candidate),
      });
    },
  };
}

const outcomes = (result) => Object.fromEntries(result.atoms.map(({ id, passed }) => [id, passed]));

for (const [left, right] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
]) {
  test(`shared-owner atomic credit: left=${left}, right=${right}`, async (t) => {
    const { grade } = await fixture(t);
    let source = before["main.cpp"];
    if (left) source = source.replaceAll(/\bleft\b/g, "leftName");
    if (right) source = source.replaceAll(/\bright\b/g, "rightName");
    const result = await grade({ "main.cpp": source });
    assert.deepEqual(outcomes(result), { left, right });
    assert.equal(result.passed, Number(left) + Number(right));
    assert.equal(result.total, 2);
    assert.equal(result.integrityPassed, true);
  });
}

test("a consistently misspelled sibling does not erase independent binding credit", async (t) => {
  const { grade, expectedTree } = await fixture(t);
  const result = await grade({
    "main.cpp": expectedTree["main.cpp"].replaceAll("rightName", "wrongName"),
  });
  assert.deepEqual(outcomes(result), { left: true, right: false });
  assert.equal(result.integrityPassed, true);
});

test("declaration-only renames and binding collisions cannot certify recovered ASTs", async (t) => {
  const { grade, expectedTree } = await fixture(t);
  for (const candidate of [
    before["main.cpp"].replace("int left,", "int leftName,"),
    expectedTree["main.cpp"].replaceAll("rightName", "leftName"),
  ]) {
    const result = await grade({ "main.cpp": candidate });
    assert.equal(result.passed, 0);
    assert.ok(result.atoms.every((atom) => atom.failures.length > 0));
  }
});

test("reordering functions, reopening namespaces and Unicode layout preserve token anchors", async (t) => {
  const { grade, expectedTree } = await fixture(t);
  const source = expectedTree["main.cpp"];
  const candidate = source.replace("namespace frond {\n", "namespace frond { /* π 😀 */\n");
  // Comments are protected too: use a trusted comment before moving owners.
  const unicode = await fixture(t, {
    "main.cpp": before["main.cpp"].replace("namespace frond {\n", "namespace frond { /* π 😀 */\n"),
  });
  const result = await unicode.grade({ "main.cpp": candidate });
  assert.equal(result.passed, 2);
  const reordered = `namespace frond { int untouched() { return 7; } }\nnamespace frond {\nint combine(int leftName, int rightName) { return leftName + rightName; }\n}\n`;
  assert.equal((await grade({ "main.cpp": reordered })).passed, 2);
});

test("a duplicate assigned owner fails its atoms without inventing additional credit", async (t) => {
  const { grade, expectedTree } = await fixture(t);
  const duplicate =
    "namespace frond { int combine(int leftName, int rightName) { return leftName + rightName; } }\n";
  const result = await grade({ "main.cpp": expectedTree["main.cpp"] + duplicate });
  assert.equal(result.passed, 0);
  assert.equal(result.total, 2);
});

test("protected body corruption inside an assigned owner is attributable", async (t) => {
  const { grade, expectedTree } = await fixture(t);
  const result = await grade({
    "main.cpp": expectedTree["main.cpp"].replace("leftName + rightName", "leftName - rightName"),
  });
  assert.equal(result.passed, 0);
  assert.equal(result.integrityPassed, true);
});

test("unrelated protected corruption vetoes the round while retaining raw atom evidence", async (t) => {
  const { grade, expectedTree } = await fixture(t);
  const result = await grade({
    "main.cpp": expectedTree["main.cpp"].replace("return 7;", "return 8;"),
  });
  assert.equal(result.passed, 2);
  assert.equal(result.integrityPassed, false);
  assert.ok(result.preservationFailures.length > 0);
});

test("a failed independent translation unit does not erase valid atom evidence", async (t) => {
  const tree = {
    "a.cpp": "int first(int left) { return left; }\n",
    "b.cpp": "int second(int right) { return right; }\n",
  };
  const { grade, expectedTree } = await fixture(t, tree);
  const result = await grade({
    ...expectedTree,
    "b.cpp": expectedTree["b.cpp"].replace("return rightName;", "return rightName *;"),
  });
  assert.deepEqual(outcomes(result), { left: true, right: false });
  assert.equal(result.integrityPassed, true);
});

test("field declaration and cross-file uses must all have the requested name and binding", async (t) => {
  const tree = {
    "pair.h": "#pragma once\nstruct Pair { int left; int right; };\n",
    "main.cpp": '#include "pair.h"\nint combine(Pair pair) { return pair.left + pair.right; }\n',
  };
  const { grade, expectedTree } = await fixture(t, tree);
  assert.equal((await grade(expectedTree)).passed, 2);
  const partial = {
    ...expectedTree,
    "main.cpp": expectedTree["main.cpp"].replace("pair.leftName", "pair.left"),
  };
  assert.equal((await grade(partial)).passed, 0);
});

test("a missing shared header cannot be credited through a surviving or recovered TU", async (t) => {
  const tree = {
    "pair.h": "#pragma once\nstruct Pair { int left; int right; };\n",
    "a.cpp": '#include "pair.h"\nint first(Pair pair) { return pair.left; }\n',
    "b.cpp": '#include "pair.h"\nint second(Pair pair) { return pair.right; }\n',
  };
  const { grade, expectedTree } = await fixture(t, tree);
  const candidate = { ...expectedTree };
  delete candidate["pair.h"];
  const result = await grade(candidate);
  assert.equal(result.passed, 0);
});

test("a valid but rebound sibling use fails only that atom's certified slot", async (t) => {
  const tree = { "main.cpp": "namespace frond { inline int wrong = 4; }\n" + before["main.cpp"] };
  const { grade, expectedTree } = await fixture(t, tree);
  const result = await grade({
    "main.cpp": expectedTree["main.cpp"].replace(
      "return leftName + rightName;",
      "return wrong + rightName;",
    ),
  });
  assert.deepEqual(outcomes(result), { left: false, right: true });
  assert.equal(result.integrityPassed, true);
});

test("an assigned compiler failure is not proof of collateral corruption in unchanged owners", async (t) => {
  const { grade } = await fixture(t);
  const candidate = before["main.cpp"].replace("int left,", "int leftName,");
  const result = await grade({ "main.cpp": candidate });
  assert.equal(result.passed, 0);
  assert.equal(result.integrityPassed, true);
});

test("a broken assigned owner cannot turn an independent valid TU into an integrity veto", async (t) => {
  const tree = {
    "a.cpp": "int first(int left) { return left; }\n",
    "b.cpp": "int second(int right) { return right; }\nint untouched() { return 7; }\n",
  };
  const { grade, expectedTree } = await fixture(t, tree);
  const result = await grade({
    ...expectedTree,
    "b.cpp": expectedTree["b.cpp"].replace("return rightName;", "return rightName *;"),
  });
  assert.deepEqual(outcomes(result), { left: true, right: false });
  assert.equal(result.integrityPassed, true);
});

test("inactive protected code outside assigned owners vetoes the round", async (t) => {
  const tree = { "main.cpp": before["main.cpp"] + "#if 0\nint disabled() { return 9; }\n#endif\n" };
  const { grade, expectedTree } = await fixture(t, tree);
  const result = await grade({
    "main.cpp": expectedTree["main.cpp"].replace("return 9;", "return 10;"),
  });
  assert.equal(result.passed, 2);
  assert.equal(result.integrityPassed, false);
});

test("inactive protected code inside an assigned owner invalidates its atoms", async (t) => {
  const tree = {
    "main.cpp": before["main.cpp"].replace(
      "return left + right;",
      "\n#if 0\nreturn 9;\n#else\nreturn left + right;\n#endif\n",
    ),
  };
  const { grade, expectedTree } = await fixture(t, tree);
  const result = await grade({
    "main.cpp": expectedTree["main.cpp"].replace("return 9;", "return 10;"),
  });
  assert.equal(result.passed, 0);
  assert.equal(result.integrityPassed, true);
});
test("unchanged owner tokens do not conceal a using-directive binding rebind", async (t) => {
  const tree = {
    "main.cpp": `namespace alpha { inline int value = 1; }
namespace beta { inline int value = 1; }
namespace frond {
using namespace alpha;
int combine(int left, int right) { return left + right + value; }
using namespace beta;
}
`,
  };
  const { grade, expectedTree } = await fixture(t, tree);
  const source = expectedTree["main.cpp"]
    .replace("using namespace alpha;", "using namespace beta;")
    .replace("using namespace beta;\n}", "using namespace alpha;\n}");
  const result = await grade({ "main.cpp": source });
  assert.equal(result.passed, 0);
});
