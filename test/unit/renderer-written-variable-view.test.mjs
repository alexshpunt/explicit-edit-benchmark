import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  applyScopedNamePlan,
  scopedNamingPlan,
  scopedNamingSession,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

async function certify(tree, request) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/written-variable-view-"));
  let session;
  try {
    session = await scopedNamingSession(tree, directory);
    const result = await session.atomicPlans(request);
    session.close();
    session = undefined;
    const [runtime] = await scopedNamingPlan(tree, [request], directory);
    assert.deepEqual(runtime.edits, result.plan.edits);
    const updated = applyScopedNamePlan(tree, result.plan);
    execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
      input: updated["main.cpp"],
    });
    return { result, updated };
  } finally {
    session?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function parameterRequest(scope, signature, from, to, definition) {
  return {
    id: "written-parameter",
    phase: "names",
    category: "locals-parameters",
    mapping: [{ from, to }],
    selectors: [{ kind: "function", scope, signature, definition }],
  };
}

test("different template prototype and definition parameter names remain independent after instantiation", async () => {
  const tree = {
    "main.cpp": `namespace frond {
template <typename T> auto value(T prototype);
template <typename T> auto bridge(T input) { return value(input); }
template <typename T> auto value(T current) {
  struct result { T member; };
  return result{current};
}
}
int main() { return frond::bridge(3).member; }
`,
  };
  const declaration = await certify(
    tree,
    parameterRequest("frond::value", "auto (T)", "prototype", "declaration", false),
  );
  assert.equal(declaration.result.atoms.length, 1);
  assert.equal(declaration.result.plan.edits.length, 1);
  assert.ok(declaration.updated["main.cpp"].includes("auto value(T declaration);"));
  assert.ok(declaration.updated["main.cpp"].includes("auto value(T current) {"));
  assert.ok(declaration.updated["main.cpp"].includes("return result{current};"));

  const definition = await certify(
    tree,
    parameterRequest("frond::value", "auto (T)", "current", "argument", true),
  );
  assert.equal(definition.result.atoms.length, 1);
  assert.equal(definition.result.plan.edits.length, 2);
  assert.ok(definition.updated["main.cpp"].includes("auto value(T prototype);"));
  assert.ok(definition.updated["main.cpp"].includes("auto value(T argument) {"));
  assert.ok(definition.updated["main.cpp"].includes("return result{argument};"));
});

test("an explicitly written specialization retains its own parameter and body binding", async () => {
  const tree = {
    "main.cpp": `namespace frond {
template <typename T> int value(T argument) { return argument; }
template <> int value<int>(int argument) { return argument + 1; }
}
int main() { return frond::value(2) + frond::value(3.0); }
`,
  };
  const { result, updated } = await certify(
    tree,
    parameterRequest("frond::value", "int (int)", "argument", "specialized", true),
  );
  assert.equal(result.atoms.length, 1);
  assert.equal(result.plan.edits.length, 2);
  assert.ok(updated["main.cpp"].includes("int value(T argument) { return argument; }"));
  assert.ok(
    updated["main.cpp"].includes("int value<int>(int specialized) { return specialized + 1; }"),
  );
});

test("a block-scope extern still shares its namespace declaration and bound uses", async () => {
  const tree = {
    "main.cpp": `namespace frond {
int counter = 3;
int read() { extern int counter; return counter; }
int untouched() { int counter = 7; return counter; }
int elsewhere() { return counter; }
}
int main() { return frond::read() + frond::untouched() + frond::elsewhere(); }
`,
  };
  const { result, updated } = await certify(
    tree,
    parameterRequest("frond::read", "int ()", "counter", "total", true),
  );
  assert.equal(result.atoms.length, 1);
  assert.equal(result.plan.edits.length, 4);
  assert.ok(updated["main.cpp"].includes("int total = 3;"));
  assert.ok(updated["main.cpp"].includes("int read() { extern int total; return total; }"));
  assert.ok(updated["main.cpp"].includes("int elsewhere() { return total; }"));
  assert.ok(updated["main.cpp"].includes("int untouched() { int counter = 7; return counter; }"));
});
