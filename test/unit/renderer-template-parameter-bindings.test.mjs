import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  scopedNamingSession,
  scopedNamingPlan,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

const tree = {
  "main.cpp": `namespace frond {
template <typename T> constexpr auto bounds(T top);
template <typename T> constexpr auto bounds(T oldMin, T oldMax);
template <typename T> constexpr auto bounds(T top) {
  return bounds((T)0, top);
}
template <typename T> constexpr auto bounds(T oldMin, T oldMax) {
  struct iterator {
    T index;
    void operator++() { ++index; }
    bool operator!=(const iterator& other) const { return index != other.index; }
    T operator*() const { return index; }
  };
  struct range {
    T first = 0, last = 0;
    iterator begin() const { return {first}; }
    iterator end() const { return {last}; }
  };
  return range{oldMin, oldMax};
}
}
int main() { int sum = 0; for (auto value : frond::bounds(3)) sum += value; return sum; }
`,
};

function request(definitions) {
  return {
    id: "template-parameters",
    phase: "names",
    category: "locals-parameters",
    mapping: [
      { from: "oldMin", to: "minimum" },
      { from: "oldMax", to: "maximum" },
    ],
    selectors: definitions.map((definition) => ({
      kind: "function",
      scope: "frond::bounds",
      signature: "auto (T, T)",
      definition,
    })),
  };
}

async function withSession(run) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/template-parameter-bindings-"));
  const session = await scopedNamingSession(tree, directory);
  try {
    await run(session, directory);
  } finally {
    session.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a template prototype's parameters do not own uses of its definition's parameters", async () => {
  await withSession(async (session) => {
    const plan = await session.plan(request([false]));
    assert.equal(plan.edits.length, 2);
    const result = applyScopedNamePlan(tree, plan)["main.cpp"];
    assert.ok(result.includes("bounds(T minimum, T maximum);"));
    assert.ok(result.includes("bounds(T oldMin, T oldMax) {"));
    assert.ok(result.includes("return range{oldMin, oldMax};"));
  });
});

test("current-task planning replays each certified parameter independently on compilable source", async () => {
  await withSession(async (session, directory) => {
    const certified = await session.atomicPlans(request([false, true]));
    session.close();
    let current = tree;
    for (const atom of [...certified.atoms].reverse()) {
      const [plan] = await scopedNamingPlan(current, [atom.operation], directory);
      assert.equal(plan.edits.length, atom.plan.edits.length);
      current = applyScopedNamePlan(current, plan);
      execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
        input: current["main.cpp"],
      });
    }
    assert.deepEqual(current, applyScopedNamePlan(tree, certified.plan));
  });
});
test("template declaration and definition parameters have disjoint atomic plans", async () => {
  await withSession(async (session) => {
    const certified = await session.atomicPlans(request([false, true]));
    const sites = certified.atoms.flatMap((atom) =>
      atom.plan.edits.map((edit) => JSON.stringify([edit.file, edit.start])),
    );
    assert.equal(new Set(sites).size, sites.length);
    assert.equal(certified.atoms.length, 4);
    assert.equal(certified.plan.edits.length, 6);
    const result = applyScopedNamePlan(tree, certified.plan)["main.cpp"];
    assert.ok(result.includes("bounds(T minimum, T maximum);"));
    assert.ok(result.includes("bounds(T minimum, T maximum) {"));
    assert.ok(result.includes("return range{minimum, maximum};"));
  });
});
