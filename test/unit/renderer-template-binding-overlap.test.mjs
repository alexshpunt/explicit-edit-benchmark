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

await test(
  "an isolated persistent worker renames both template bindings separately from current source",
  { timeout: 30_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/template-isolated-binding-"));
    const workspace = path.join(root, "workspace");
    const tools = path.join(root, "executor");
    let worker;
    try {
      await writeTree(workspace, { "main.cpp": source });
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
      assert.ok(partial["main.cpp"].includes("old(0, value, {})"));
      assert.ok(partial["main.cpp"].includes("restored(0, value)"));
      compiles(partial);
      const second = await deliver("void (int, T, int)", 2);
      const final = await readTree(workspace);
      assert.equal(final["main.cpp"], source.replaceAll(/\bold\b/g, "restored"));
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
