import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareBarrierSymbolMap,
  indexBarrierSymbolMap,
} from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";
import {
  prepareAtomicRoundCredit,
  evaluateAtomicRoundCredit,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-round-credit.mjs";
import { prepareAtomicRoundFootprints } from "../../src/suites/explicit-edit-multi-agent/grading/round-footprints.mjs";
import { prepareAtomicEffect } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-structural-effects.mjs";
import {
  prepareAtomicNamingBatch,
  applyAtomicNamingBatch,
} from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-naming-replay.mjs";

async function fixture(t, prefix, body, invocation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-dependent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = { "main.cpp": prefix + body + invocation };
  const expected = { "main.cpp": prefix + '#include "moved.h"\n' + invocation, "moved.h": body };
  const nodes = [{ id: "move", operations: [{ phase: "structure" }] }];
  const structuralFootprints = prepareAtomicRoundFootprints(
    before,
    [
      {
        id: "move",
        effect: prepareAtomicEffect(before, expected),
        filesBefore: Object.keys(before).sort(),
        filesAfter: Object.keys(expected).sort(),
      },
    ],
    expected,
  );
  const expectedSymbols = await prepareBarrierSymbolMap(expected, {
    evidence: path.join(directory, "trusted"),
  });
  const prepared = prepareAtomicRoundCredit({
    beforeTree: before,
    expectedTree: expected,
    nodes,
    structuralFootprints,
    expectedSymbols,
  });
  let sequence = 0;
  return {
    expected,
    grade: async (candidate) =>
      evaluateAtomicRoundCredit(candidate, prepared, {
        candidateSymbols: await indexBarrierSymbolMap(candidate, {
          evidence: path.join(directory, "candidate-" + ++sequence),
        }),
      }),
  };
}

test("a dependent overload set certifies its real canonical move and rejects different declarations", async (t) => {
  const prefix =
    "namespace A { int pick(int x) { return x; } long pick(long x) { return x; } }\n" +
    "namespace B { int pick(int x) { return x; } long pick(long x) { return x; } }\nusing A::pick;\n";
  const body = "template <typename T> auto call(T value) { return pick(value); }\n";
  const { expected, grade } = await fixture(t, prefix, body, "int main() { return call(0); }\n");
  const good = await grade(expected);
  assert.equal(good.passed, 1);
  assert.equal(good.integrityPassed, true);
  const bad = await grade({
    ...expected,
    "main.cpp": expected["main.cpp"].replace("using A::pick;", "using B::pick;"),
  });
  assert.equal(bad.passed, 0);
  assert.equal(bad.integrityPassed, false);
});

test("overload declaration order is irrelevant but an additional binding target is not", async (t) => {
  const prefix =
    "namespace A { int pick(int x) { return x; } long pick(long x) { return x; } }\nusing A::pick;\n";
  const body = "template <typename T> auto call(T value) { return pick(value); }\n";
  const { expected, grade } = await fixture(t, prefix, body, "int main() { return call(0); }\n");
  const reordered = {
    ...expected,
    "main.cpp": expected["main.cpp"].replace(
      "int pick(int x) { return x; } long pick(long x) { return x; }",
      "long pick(long x) { return x; } int pick(int x) { return x; }",
    ),
  };
  const good = await grade(reordered);
  assert.equal(good.passed, 1);
  assert.equal(good.integrityPassed, true);
  const added = {
    ...expected,
    "main.cpp": expected["main.cpp"].replace(
      "namespace A {",
      "namespace A { float pick(float x) { return x; }",
    ),
  };
  const bad = await grade(added);
  assert.equal(bad.passed, 0);
  assert.equal(bad.integrityPassed, false);
});
test("identical guarded typedef copies retain their own active and inactive compiler facts", async (t) => {
  const prefix =
    "#ifndef ENTRY_TYPE\ntypedef unsigned Entry;\n#define ENTRY_TYPE unsigned\n#endif\n" +
    "#ifndef ENTRY_TYPE\ntypedef unsigned Entry;\n#define ENTRY_TYPE unsigned\n#endif\n";
  const { expected, grade } = await fixture(
    t,
    prefix,
    "int call() { return 0; }\n",
    "int main() { return call(); }\n",
  );
  const good = await grade(expected);
  assert.equal(good.passed, 1);
  assert.equal(good.integrityPassed, true);
});

test("namespace reopenings keep one compiler entity across project and system declarations", async (t) => {
  const prefix =
    "#include <string>\nusing namespace std::string_literals;\nnamespace std {}\nusing namespace std::string_literals;\n";
  const { expected, grade } = await fixture(
    t,
    prefix,
    "int call() { return 0; }\n",
    "int main() { return call(); }\n",
  );
  const good = await grade(expected);
  assert.equal(good.passed, 1);
  assert.equal(good.integrityPassed, true);
});
async function namingFixture(t, source, definitions) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-named-copies-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = { "main.cpp": source };
  const plans = definitions.map(([id, from, to]) => ({
    id,
    plan: {
      edits: [...source.matchAll(new RegExp("\\b" + from + "\\b", "g"))].map((match) => ({
        file: "main.cpp",
        start: match.index,
        old: from,
        new: to,
      })),
    },
  }));
  const batch = prepareAtomicNamingBatch(before, plans);
  const expected = applyAtomicNamingBatch(before, batch, batch.ids).tree;
  const prepared = prepareAtomicRoundCredit({
    beforeTree: before,
    expectedTree: expected,
    nodes: plans.map(({ id }) => ({ id, operations: [{ phase: "names" }] })),
    namingBatches: [batch],
    expectedSymbols: await prepareBarrierSymbolMap(expected, {
      evidence: path.join(directory, "trusted"),
    }),
  });
  let sequence = 0;
  return {
    expected,
    grade: async (candidate) =>
      evaluateAtomicRoundCredit(candidate, prepared, {
        candidateSymbols: await indexBarrierSymbolMap(candidate, {
          evidence: path.join(directory, "candidate-" + ++sequence),
        }),
      }),
  };
}
test("distinct requested names do not collapse otherwise identical physical owners", async (t) => {
  const { expected, grade } = await namingFixture(
    t,
    "int oldA() { return 0; }\nint oldB() { return 0; }\nint main() { return oldA() + oldB(); }\n",
    [
      ["a", "oldA", "newA"],
      ["b", "oldB", "newB"],
    ],
  );
  for (const { source, expectedB } of [
    { source: expected["main.cpp"], expectedB: true },
    { source: expected["main.cpp"].replaceAll("newB", "wrongB"), expectedB: false },
  ]) {
    const result = await grade({ "main.cpp": source });
    assert.deepEqual(Object.fromEntries(result.atoms.map(({ id, passed }) => [id, passed])), {
      a: true,
      b: expectedB,
    });
    assert.equal(result.integrityPassed, true);
  }
});
test("convergent parameter names retain every original obligation in an indistinguishable declaration family", async (t) => {
  const { expected, grade } = await namingFixture(
    t,
    "int call(int argShp);\nint call(int pShp);\nint main() { return 0; }\n",
    [
      ["a", "argShp", "shape"],
      ["b", "pShp", "shape"],
    ],
  );
  const good = await grade(expected);
  assert.deepEqual(
    good.atoms.map(({ passed }) => passed),
    [true, true],
  );
  assert.equal(good.integrityPassed, true);
  const bad = await grade({ "main.cpp": expected["main.cpp"].replace("int shape", "int wrong") });
  assert.deepEqual(
    bad.atoms.map(({ passed }) => passed),
    [false, false],
  );
  assert.equal(bad.integrityPassed, true);
});
test("same-invocation macro declarations cannot hide a dependent lookup rebind", async (t) => {
  const prefix =
    "#define DECLS namespace A { int pick(int x) { return x; } } namespace B { int pick(int x) { return x; } }\nDECLS;\nusing A::pick;\n";
  const body = "template <typename T> auto call(T value) { return pick(value); }\n";
  const { expected, grade } = await fixture(t, prefix, body, "int main() { return call(0); }\n");
  const good = await grade(expected);
  assert.equal(good.passed, 1);
  assert.equal(good.integrityPassed, true);
  const bad = await grade({
    ...expected,
    "main.cpp": expected["main.cpp"].replace("using A::pick;", "using B::pick;"),
  });
  assert.equal(bad.passed, 0);
  assert.equal(bad.integrityPassed, false);
});
test("nested dependent members retain their compiler lookup context instead of becoming collateral failures", async (t) => {
  const body =
    "template <typename T> int call(T value) { struct Item { T index; bool same(const Item& other) const { return index == other.index; } }; return Item{value}.same(Item{value}); }\n";
  const { expected, grade } = await fixture(
    t,
    "",
    body,
    "int main() { return call(0) ? 0 : 1; }\n",
  );
  const good = await grade(expected);
  assert.equal(good.passed, 1);
  assert.equal(good.integrityPassed, true);
});
