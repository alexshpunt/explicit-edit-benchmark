import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  scopedNamingSession,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

const source = `namespace frond {
struct Float {}; struct Byte {};
template<class T> struct Box {};
void old(const Box<Float>&) {}
void old(const Box<Byte>&) {}
void old(int, int) {}
void direct() { old(1, 2); }
template<class T> void shared(const Box<T>& value) { old(value); }
}
int main() { frond::shared(frond::Box<frond::Float>{}); frond::shared(frond::Box<frond::Byte>{}); frond::direct(); }
`;
const request = {
  id: "shared-overload-callee",
  phase: "names",
  category: "functions-types",
  mapping: [{ from: "old", to: "restored" }],
  selectors: [{ kind: "function", scope: "frond::old" }],
};

test(
  "isolated reference participants receive a whole inseparable unit, without its private proof",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/coupled-isolated-reference-"));
    let session, worker;
    try {
      const directory = path.join(root, "analysis");
      await mkdir(directory);
      session = await scopedNamingSession({ "main.cpp": source }, directory);
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
          assert.equal(Object.hasOwn(atom.operation, "coupling"), false);
          assert.equal(Object.hasOwn(atom.operation, "plan"), false);
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

function compile(text) {
  return execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
    input: text,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("only genuinely inseparable overloads share one certified atomic edit", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/shared-overload-binding-"));
  let session;
  try {
    compile(source);
    const tree = { "main.cpp": source };
    session = await scopedNamingSession(tree, root);
    const certified = await session.atomicPlans(request);
    assert.equal(certified.atoms.length, 2);
    assert.deepEqual(
      certified.operation.bindingGroups.map((group) => group.bindingCount).sort(),
      [1, 2],
    );
    assert.deepEqual(certified.atoms.map((atom) => atom.plan.edits.length).sort(), [2, 3]);
    assert.equal(certified.plan.edits.length, 5);
    const occupied = new Set();
    for (const atom of certified.atoms) {
      for (const edit of atom.plan.edits) {
        const key = `${edit.file}:${edit.start}`;
        assert.ok(!occupied.has(key));
        occupied.add(key);
      }
      compile(applyScopedNamePlan(tree, atom.plan)["main.cpp"]);
    }
    session.close();
    session = undefined;
    const plans = [];
    for (const [index, type] of ["Float", "Byte"].entries()) {
      const directory = path.join(root, `analysis-${index}`);
      await mkdir(directory);
      session = await scopedNamingSession(tree, directory);
      const plan = await session.plan({
        ...request,
        selectors: [
          {
            kind: "function",
            scope: "frond::old",
            owner: { scope: "frond::old", signature: `void (const Box<${type}> &)` },
          },
        ],
      });
      assert.equal(plan.edits.length, 2);
      assert.throws(
        () => compile(applyScopedNamePlan(tree, plan)["main.cpp"]),
        (error) => {
          assert.equal(error.status, 1);
          assert.match(error.stderr.toString(), /no matching function/);
          return true;
        },
      );
      plans.push(plan);
      session.close();
      session = undefined;
    }
    const common = plans[0].edits.filter((edit) =>
      plans[1].edits.some((other) => other.file === edit.file && other.start === edit.start),
    );
    assert.equal(common.length, 1);
    assert.equal(source.slice(common[0].start, common[0].start + 3), "old");
    const directory = path.join(root, "union");
    await mkdir(directory);
    session = await scopedNamingSession(tree, directory);
    const union = await session.plan(request);
    assert.equal(union.edits.length, 5);
    const after = applyScopedNamePlan(tree, union);
    assert.equal(after["main.cpp"], source.replaceAll(/\bold\b/g, "restored"));
    compile(after["main.cpp"]);
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("defaulted recursion couples the enclosing template only with positive original-token proof", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/defaulted-self-coupling-"));
  const original = `namespace frond {
struct Float {}; struct Byte {};
template<typename T> struct Box {};
int old(const Box<Float>&, bool locked = false) { return 1; }
int old(const Box<Byte>&, bool locked = false) { return 2; }
template<typename T> int old(const Box<T>& value, int level, bool locked = false) {
  if (level < 1) return 0;
  return old(value, locked);
}
}
int main() {}
`;
  let session;
  try {
    session = await scopedNamingSession({ "main.cpp": original }, root);
    const certified = await session.atomicPlans(request);
    assert.equal(certified.atoms.length, 1);
    assert.equal(certified.operation.bindingGroups[0].bindingCount, 3);
    const atom = certified.atoms[0];
    assert.equal(atom.plan.edits.length, 4);
    assert.equal(atom.coupling.members.length, 3);
    assert.equal(atom.coupling.instantiations.length, 1);
    assert.equal(atom.coupling.instantiations[0].proof.requiredDeclarations.length, 3);
    const after = applyScopedNamePlan({ "main.cpp": original }, atom.plan)["main.cpp"];
    assert.equal(after, original.replaceAll(/\bold\b/g, "restored"));
    compile(after);
    const sealed = coherentNamingPlans({ "main.cpp": original }, [certified.plan], [], [certified]);
    assert.equal(sealed.bindings[0].operation.bindingGroups[0].bindingCount, 3);
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an uninstantiated original template gains private positive coupling evidence", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/uninstantiated-overload-binding-"));
  const original = `namespace frond {
int previous = 0;
struct Float {}; struct Byte {};
template<typename T> struct Box {};
void old(const Box<Float>&) {}
void old(const Box<Byte>&) {}
void old(int, int) {}
void direct() { old(1, 2); }
template<typename T> void shared(const Box<T>& value, int level) { if (level) old(value); }
}
int main() { frond::direct(); }
`;
  const instantiate = `\nvoid force_original_body() {
frond::shared(frond::Box<frond::Float>{}, 1);
frond::shared(frond::Box<frond::Byte>{}, 1);
}\n`;
  let session;
  try {
    compile(original + instantiate);
    session = await scopedNamingSession({ "main.cpp": original }, root);
    const certified = await session.atomicPlans(request);
    const coupled = certified.atoms.find((atom) => atom.coupling);
    assert.ok(coupled);
    assert.deepEqual(
      certified.operation.bindingGroups.map((group) => group.bindingCount).sort(),
      [1, 2],
    );
    assert.equal(certified.plan.edits.length, 5);
    assert.equal(coupled.coupling.instantiations.length, 1);
    const earlier = {
      id: "earlier-group",
      edits: [
        {
          file: "main.cpp",
          start: original.indexOf("previous"),
          old: "previous",
          new: "earlier_renamed_global",
        },
      ],
    };
    const current = applyScopedNamePlan({ "main.cpp": original }, earlier);
    const sealed = coherentNamingPlans(current, [certified.plan], [earlier], [certified]);
    const shifted = sealed.bindings[0].atoms.find((atom) => atom.coupling);
    const delta = earlier.edits[0].new.length - earlier.edits[0].old.length;
    const beforeProof = coupled.coupling.instantiations[0];
    const afterProof = shifted.coupling.instantiations[0];
    assert.equal(afterProof.site.start, beforeProof.site.start + delta);
    assert.deepEqual(
      afterProof.declarations,
      beforeProof.declarations.map((site) => ({ ...site, start: site.start + delta })),
    );
    assert.deepEqual(afterProof.proof, beforeProof.proof);
    assert.deepEqual(shifted.coupling.origin, coupled.coupling);
    const malformed = structuredClone(certified);
    malformed.atoms.find((atom) => atom.coupling).coupling.instantiations[0].proof.sourceSha256 =
      "0".repeat(64);
    assert.throws(
      () => coherentNamingPlans({ "main.cpp": original }, [certified.plan], [], [malformed]),
      /instantiation evidence/,
    );
    assert.equal(Object.hasOwn(coupled.operation, "coupling"), false);
    assert.equal(Object.hasOwn(coupled.operation, "instantiations"), false);
    for (const atom of certified.atoms)
      compile(applyScopedNamePlan({ "main.cpp": original }, atom.plan)["main.cpp"] + instantiate);
    const after = applyScopedNamePlan({ "main.cpp": original }, certified.plan)["main.cpp"];
    assert.equal(after, original.replaceAll(/\bold\b/g, "restored"));
    compile(after + instantiate);
  } finally {
    session?.close();
    await rm(root, { recursive: true, force: true });
  }
});
