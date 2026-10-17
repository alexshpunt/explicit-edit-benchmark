import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  scopedNamingSession,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
const source = `namespace frond {
template<class T> struct Box {};
template<class T, int N> struct Fixed {};
template<class T> void old(const Box<Box<T>>&);
template<class T, int N> void old(const Box<Fixed<T, N>>&);
template<class T> void old(const Box<Box<T>>&) {}
template<class T, int N> void old(const Box<Fixed<T, N>>&) {}
template<class T> void lists(const Box<Box<T>>& values) { old(values); }
template<class T> void arrays(const Box<Fixed<T, 3>>& values) { old(values); }
}
int main() { frond::lists(frond::Box<frond::Box<int>>{}); frond::arrays(frond::Box<frond::Fixed<int, 3>>{}); }
`;

const request = {
  id: "same-arity-templates",
  phase: "names",
  category: "functions-types",
  mapping: [{ from: "old", to: "restored" }],
  selectors: [{ kind: "function", scope: "frond::old" }],
};

test("standard-container overloads keep three disjoint bindings and their complete call union", async () => {
  const input = `#include <array>
#include <cstdint>
#include <string>
#include <vector>
namespace frond {
using std::array; using std::string; using std::vector; using std::size_t;
struct Model {};
template<class T> bool old(Model&, const string&, const string&, const vector<vector<T>>&);
template<class T> bool old(Model&, const string&, const string&, const vector<uint8_t>&, const vector<T>&);
template<class T, size_t N> bool old(Model&, const string&, const string&, const vector<array<T, N>>&);
template<class T> bool old(Model&, const string&, const string&, const vector<vector<T>>&) { return true; }
template<class T> bool old(Model&, const string&, const string&, const vector<uint8_t>&, const vector<T>&) { return true; }
template<class T, size_t N> bool old(Model&, const string&, const string&, const vector<array<T, N>>&) { return true; }
template<class T> bool lists(Model& model, const vector<vector<T>>& values) { return old(model, "face", "values", values); }
template<class T> bool triangles(Model& model, const vector<array<T, 3>>& values) { return old(model, "face", "triangles", values); }
template<class T> bool quads(Model& model, const vector<array<T, 4>>& values) { return old(model, "face", "quads", values); }
template<class T> bool lines(Model& model, const vector<array<T, 2>>& values) { return old(model, "line", "lines", values); }
template<class T> bool points(Model& model, const vector<T>& values) { return old(model, "point", "points", (const vector<array<T, 1>>&)values); }
template<class T> bool flat(Model& model, const vector<T>& values) { return old(model, "face", "flat", vector<uint8_t>{}, values); }
}
int main() {
  frond::Model model;
  return frond::lists(model, std::vector<std::vector<int>>{}) && frond::triangles(model, std::vector<std::array<int, 3>>{}) && frond::quads(model, std::vector<std::array<int, 4>>{}) && frond::lines(model, std::vector<std::array<int, 2>>{}) && frond::points(model, std::vector<int>{}) && frond::flat(model, std::vector<int>{});
}
`;
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/standard-template-bindings-"));
  let session;
  try {
    const tree = { "main.cpp": input };
    session = await scopedNamingSession(tree, root);
    const certified = await session.atomicPlans(request);
    assert.equal(certified.atoms.length, 3);
    assert.deepEqual(certified.atoms.map((atom) => atom.plan.edits.length).sort(), [3, 3, 6]);
    assert.equal(certified.plan.edits.length, 12);
    const sites = certified.atoms.flatMap((atom) => atom.plan.edits.map((edit) => edit.start));
    assert.equal(new Set(sites).size, sites.length);
    for (const atom of certified.atoms) {
      const result = applyScopedNamePlan(tree, atom.plan);
      execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
        input: result["main.cpp"],
      });
    }
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "an isolated worker replays same-arity bindings one current public request at a time",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/same-arity-isolated-worker-"));
    const workspace = path.join(root, "workspace");
    const tools = path.join(root, "executor");
    let session, worker;
    try {
      const analysis = path.join(root, "analysis");
      await mkdir(analysis);
      session = await scopedNamingSession({ "main.cpp": source }, analysis);
      const certified = await session.atomicPlans(request);
      session.close();
      session = undefined;
      await writeTree(workspace, { "main.cpp": source });
      await prepareConcurrentExecutor(tools);
      worker = concurrentExecutor(workspace, tools, { signal: t.signal });
      const receipts = [];
      for (const [index, atom] of certified.atoms.entries()) {
        receipts.push(
          await worker.execute({
            id: `task-001-edit-0000${index + 1}`,
            operations: [atom.operation],
          }),
        );
        const current = await readTree(workspace);
        execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
          input: current["main.cpp"],
        });
      }
      const final = await readTree(workspace);
      assert.equal(final["main.cpp"], source.replaceAll(/\bold\b/g, "restored"));
      assert.equal(receipts[0].lifetime, receipts[1].lifetime);
      assert.equal(receipts[1].delivered, 2);
      assert.equal(receipts[1].planner.snapshotAttempts, 1);
      assert.equal(receipts[1].planner.cacheHits, 1);
    } finally {
      session?.close();
      await worker?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("same-arity template bindings do not own calls with incompatible nested template arguments", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/same-arity-template-bindings-"));
  let session;
  try {
    const tree = { "main.cpp": source };
    session = await scopedNamingSession(tree, root);
    const certified = await session.atomicPlans(request);
    assert.equal(certified.atoms.length, 2);
    assert.equal(certified.plan.edits.length, 6);
    const occupied = new Set();
    for (const atom of certified.atoms) {
      assert.equal(atom.plan.edits.length, 3);
      const result = applyScopedNamePlan(tree, atom.plan);
      const nested = atom.operation.selectors[0].owner.signature.includes("Box<Box<T>>");
      assert.ok(
        result["main.cpp"].includes(
          `void lists(const Box<Box<T>>& values) { ${nested ? "restored" : "old"}(values); }`,
        ),
      );
      assert.ok(
        result["main.cpp"].includes(
          `void arrays(const Box<Fixed<T, 3>>& values) { ${nested ? "old" : "restored"}(values); }`,
        ),
      );
      for (const edit of atom.plan.edits) {
        const key = `${edit.file}:${edit.start}`;
        assert.ok(!occupied.has(key));
        occupied.add(key);
      }
      execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
        input: result["main.cpp"],
      });
    }
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});
