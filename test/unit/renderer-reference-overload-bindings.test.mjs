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
struct Model { int value = 1; };
int& old(Model& model, int) { return model.value; }
const int& old(const Model& model, int) { return model.value; }
template<class T> int read(const Model& model, const T& index) { return old(model, index); }
template<class T> int write(Model& model, const T& index) { return old(model, index); }
}
int main() { frond::Model model; return frond::read(model, 0) + frond::write(model, 0) - 2; }
`;
const request = {
  id: "reference-overloads",
  phase: "names",
  category: "functions-types",
  mapping: [{ from: "old", to: "restored" }],
  selectors: [{ kind: "function", scope: "frond::old" }],
};

// Other arguments may be dependent even though the cv-sensitive object is not.
const stringSource = `#include <string>
namespace frond {
using std::string;
struct Model { int value = 1; };
int& old(Model& model, const string&, const string&) { return model.value; }
const int& old(const Model& model, const string&, const string&) { return model.value; }
template<class T> int read(const Model& model, const T& property) { return old(model, "element", property); }
template<class T> int write(Model& model, const T& property) { return old(model, "element", property); }
}
int main() { frond::Model model; return frond::read(model, std::string{}) + frond::write(model, std::string{}) - 2; }
`;

function compile(text) {
  execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
    input: text,
  });
}

test("const and mutable reference overloads own only their corresponding dependent calls", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/reference-overload-bindings-"));
  let session;
  try {
    const tree = { "main.cpp": source };
    session = await scopedNamingSession(tree, root);
    const certified = await session.atomicPlans(request);
    assert.equal(certified.atoms.length, 2);
    assert.deepEqual(
      certified.atoms.map((atom) => atom.plan.edits.length),
      [2, 2],
    );
    assert.equal(certified.plan.edits.length, 4);
    const sites = new Set();
    for (const atom of certified.atoms) {
      const isConst = atom.operation.selectors[0].owner.signature.includes("(const ");
      const result = applyScopedNamePlan(tree, atom.plan);
      assert.ok(
        result["main.cpp"].includes(
          `int read(const Model& model, const T& index) { return ${isConst ? "restored" : "old"}(model, index); }`,
        ),
      );
      assert.ok(
        result["main.cpp"].includes(
          `int write(Model& model, const T& index) { return ${isConst ? "old" : "restored"}(model, index); }`,
        ),
      );
      for (const edit of atom.plan.edits) {
        const key = `${edit.file}:${edit.start}`;
        assert.ok(!sites.has(key));
        sites.add(key);
      }
      compile(result["main.cpp"]);
    }
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("identical concrete string parameters do not couple cv-reference overload bindings", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/string-reference-overloads-"));
  let session;
  try {
    const tree = { "main.cpp": stringSource };
    session = await scopedNamingSession(tree, root);
    const certified = await session.atomicPlans(request);
    assert.equal(certified.atoms.length, 2);
    assert.deepEqual(
      certified.atoms.map((atom) => atom.plan.edits.length),
      [2, 2],
    );
    assert.equal(certified.plan.edits.length, 4);
    for (const atom of certified.atoms) compile(applyScopedNamePlan(tree, atom.plan)["main.cpp"]);
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "isolated current-task planning keeps reference overload deliveries separate in either order",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/reference-overload-workers-"));
    let session, worker;
    try {
      const analysis = path.join(root, "analysis");
      await mkdir(analysis);
      session = await scopedNamingSession({ "main.cpp": source }, analysis);
      const certified = await session.atomicPlans(request);
      session.close();
      session = undefined;
      const tools = path.join(root, "executor");
      await prepareConcurrentExecutor(tools);
      for (const [order, atoms] of [certified.atoms, [...certified.atoms].reverse()].entries()) {
        const workspace = path.join(root, `workspace-${order}`);
        await writeTree(workspace, { "main.cpp": source });
        worker = concurrentExecutor(workspace, tools, { signal: t.signal });
        const receipts = [];
        for (const [index, atom] of atoms.entries()) {
          receipts.push(
            await worker.execute({
              id: `task-001-edit-0000${index + 1}`,
              operations: [atom.operation],
            }),
          );
          compile((await readTree(workspace))["main.cpp"]);
        }
        assert.equal(
          (await readTree(workspace))["main.cpp"],
          source.replaceAll(/\bold\b/g, "restored"),
        );
        assert.equal(receipts[0].lifetime, receipts[1].lifetime);
        assert.equal(receipts[1].delivered, 2);
        assert.equal(receipts[1].planner.snapshotAttempts, 1);
        assert.equal(receipts[1].planner.cacheHits, 1);
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
