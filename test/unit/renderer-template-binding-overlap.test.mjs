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
template<class T> void old(int, T);
template<class T> void old(int, T, int);
template<class T> void old(int, T) {}
template<class T> void old(int, T, int) {}
template<class T> void caller(T value) { old(0, value, {}); }
template<class T> void caller2(T value) { old(0, value); }
}
int main() { frond::caller(1); frond::caller2(1); }
`;
const request = {
  id: "template-overloads",
  phase: "names",
  category: "functions-types",
  mapping: [{ from: "old", to: "restored" }],
  selectors: [{ kind: "function", scope: "frond::old" }],
};
const arity = (operation) => (operation.selectors[0].owner.signature.includes("T, int") ? 3 : 2);
function compiles(tree) {
  execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
    input: tree["main.cpp"],
  });
}

await test("fixed-arity template overloads do not share an impossible dependent call binding", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/template-binding-overlap-"));
  let session;
  try {
    session = await scopedNamingSession({ "main.cpp": source }, root);
    const certified = await session.atomicPlans(request);
    assert.equal(certified.atoms.length, 2, "Each independently callable overload is one binding");
    for (const atom of certified.atoms) {
      const after = applyScopedNamePlan({ "main.cpp": source }, atom.plan);
      assert.ok(
        after["main.cpp"].includes(
          arity(atom.operation) === 3 ? "restored(0, value, {})" : "old(0, value, {})",
        ),
      );
      assert.ok(
        after["main.cpp"].includes(
          arity(atom.operation) === 2 ? "restored(0, value)" : "old(0, value)",
        ),
      );
      assert.equal(atom.plan.edits.length, 3);
      compiles(after);
    }
    const occupied = new Set();
    for (const atom of certified.atoms)
      for (const edit of atom.plan.edits) {
        const key = `${edit.file}:${edit.start}`;
        assert.ok(!occupied.has(key), "The certified physical plans must be disjoint");
        occupied.add(key);
      }
    assert.equal(certified.plan.edits.length, 6);
    assert.deepEqual(
      new Set(certified.plan.edits.map((edit) => `${edit.file}:${edit.start}`)),
      occupied,
    );
    compiles(applyScopedNamePlan({ "main.cpp": source }, certified.plan));
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, input] of [
  ["deduced", source],
  ["explicit", source.replaceAll("old(0, value", "old<T>(0, value")],
])
  await test(
    `an isolated persistent worker renames both template bindings separately (${label})`,
    { timeout: 30_000 },
    async (t) => {
      await mkdir(".tmp", { recursive: true });
      const root = await mkdtemp(path.resolve(".tmp/template-isolated-binding-"));
      const workspace = path.join(root, "workspace");
      const tools = path.join(root, "executor");
      let worker;
      try {
        await writeTree(workspace, { "main.cpp": input });
        await prepareConcurrentExecutor(tools);
        worker = concurrentExecutor(workspace, tools, { signal: t.signal });
        const deliver = (signature, index) =>
          worker.execute({
            id: `task-001-edit-0000${index}`,
            operations: [
              {
                ...request,
                selectors: [
                  {
                    kind: "function",
                    scope: "frond::old",
                    owner: { scope: "frond::old", signature },
                  },
                ],
              },
            ],
          });
        const first = await deliver("void (int, T)", 1);
        const partial = await readTree(workspace);
        assert.ok(
          partial["main.cpp"].includes(`old${label === "explicit" ? "<T>" : ""}(0, value, {})`),
        );
        assert.ok(
          partial["main.cpp"].includes(`restored${label === "explicit" ? "<T>" : ""}(0, value)`),
        );
        compiles(partial);
        const second = await deliver("void (int, T, int)", 2);
        const final = await readTree(workspace);
        assert.equal(final["main.cpp"], input.replaceAll(/\bold\b/g, "restored"));
        compiles(final);
        assert.equal(first.lifetime, second.lifetime);
        assert.equal(second.delivered, 2);
        assert.equal(second.planner.snapshotAttempts, 1);
        assert.equal(second.planner.cacheHits, 1);
      } finally {
        await worker?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

await test("explicit template arguments do not make a fixed-arity overload own another call", async () => {
  const explicit = source.replaceAll("old(0, value", "old<T>(0, value");
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/explicit-template-binding-"));
  let session;
  try {
    const tree = { "main.cpp": explicit };
    session = await scopedNamingSession(tree, root);
    const certified = await session.atomicPlans(request);
    assert.equal(certified.atoms.length, 2);
    assert.equal(certified.plan.edits.length, 6);
    for (const atom of certified.atoms) {
      assert.equal(atom.plan.edits.length, 3);
      const after = applyScopedNamePlan(tree, atom.plan);
      assert.ok(
        after["main.cpp"].includes(
          arity(atom.operation) === 3 ? "restored<T>(0, value, {})" : "old<T>(0, value, {})",
        ),
      );
      assert.ok(
        after["main.cpp"].includes(
          arity(atom.operation) === 2 ? "restored<T>(0, value)" : "old<T>(0, value)",
        ),
      );
      compiles(after);
    }
    session.close();
    session = undefined;
    const current = path.join(root, "current");
    await mkdir(current);
    session = await scopedNamingSession(tree, current);
    const plan = await session.plan({
      ...request,
      selectors: [
        {
          kind: "function",
          scope: "frond::old",
          owner: { scope: "frond::old", signature: "void (int, T)" },
        },
      ],
    });
    assert.equal(plan.edits.length, 3);
    compiles(applyScopedNamePlan(tree, plan));
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test(
  "a string literal cannot select a dependent class-template reference overload",
  { timeout: 30000 },
  async (t) => {
    const input = `#include <array>
#include <string>
#include <vector>
namespace frond {
using std::array; using std::string; using std::vector;
struct Model {};
template<class T> bool old(const Model&, const string&, const string&, vector<T>&);
template<class T, size_t N> bool old(const Model&, const string&, const array<string, N>&, vector<array<T, N>>&);
template<class T> bool old(const Model&, const string&, const string&, vector<T>&) { return true; }
template<class T> bool caller(const Model& model, vector<T>& values) { return old(model, "vertex", "radius", values); }
}
int main() { frond::Model model; std::vector<float> values; return !frond::caller(model, values); }
`;
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/string-literal-overload-binding-"));
    let session, worker;
    try {
      const analysis = path.join(root, "analysis");
      await mkdir(analysis);
      const tree = { "main.cpp": input };
      session = await scopedNamingSession(tree, analysis);
      const certified = await session.atomicPlans(request);
      assert.equal(certified.atoms.length, 2);
      assert.deepEqual(certified.atoms.map((atom) => atom.plan.edits.length).sort(), [1, 3]);
      assert.equal(certified.plan.edits.length, 4);
      for (const atom of certified.atoms) compiles(applyScopedNamePlan(tree, atom.plan));
      session.close();
      session = undefined;
      const tools = path.join(root, "executor");
      await prepareConcurrentExecutor(tools);
      for (const [order, atoms] of [certified.atoms, [...certified.atoms].reverse()].entries()) {
        const workspace = path.join(root, `workspace-${order}`);
        await writeTree(workspace, tree);
        worker = concurrentExecutor(workspace, tools, { signal: t.signal });
        const receipts = [];
        for (const [index, atom] of atoms.entries()) {
          receipts.push(
            await worker.execute({
              id: `task-001-edit-0000${index + 1}`,
              operations: [atom.operation],
            }),
          );
          compiles(await readTree(workspace));
        }
        assert.equal(
          (await readTree(workspace))["main.cpp"],
          input.replaceAll(/\bold\b/g, "restored"),
        );
        assert.equal(receipts[0].lifetime, receipts[1].lifetime);
        assert.equal(receipts[1].delivered, 2);
        await worker.close();
        worker = undefined;
      }
    } finally {
      session?.close();
      await worker?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

await test("current-task reference planning preserves the sibling template call", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/template-current-binding-"));
  let session;
  try {
    session = await scopedNamingSession({ "main.cpp": source }, root);
    const plan = await session.plan({
      ...request,
      selectors: [
        {
          kind: "function",
          scope: "frond::old",
          owner: { scope: "frond::old", signature: "void (int, T)" },
        },
      ],
    });
    assert.equal(plan.edits.length, 3);
    const after = applyScopedNamePlan({ "main.cpp": source }, plan);
    assert.ok(after["main.cpp"].includes("old(0, value, {})"));
    assert.ok(after["main.cpp"].includes("restored(0, value)"));
    compiles(after);
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});
