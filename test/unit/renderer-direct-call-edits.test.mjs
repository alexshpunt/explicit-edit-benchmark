import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { projectAst } from "../../src/suites/explicit-edit-multi-agent/cpp/compiler-ast.mjs";
import { createDirectCallEditFilter } from "../../src/suites/explicit-edit-multi-agent/cpp/direct-call-edits.mjs";

const overloads = `namespace frond {
template<class T> void old(int, T);
template<class T> void old(int, T, int);
template<class T> void old(int, T) {}
template<class T> void old(int, T, int) {}
`;

function flatten(roots) {
  const result = [];
  function visit(node) {
    result.push(node);
    for (const child of node.inner ?? []) visit(child);
  }
  for (const root of roots) visit(root);
  return result;
}
async function fixture(t, source) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/direct-call-edits-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.cpp");
  await writeFile(file, source);
  const roots = await projectAst(file, ["-std=c++17"]);
  const nodes = flatten(roots);
  const entry = (signature) => {
    const node = nodes.find(
      (node) =>
        node.kind === "FunctionDecl" &&
        node.name === "old" &&
        node.type?.qualType === signature &&
        Number.isInteger(node.loc?.offset),
    );
    assert.ok(node, `Missing compiler declaration: ${signature}`);
    return { role: "function", offset: node.loc.offset, name: "old" };
  };
  const edit = (text) => ({ start: source.indexOf(text), old: "old", new: "restored" });
  return { roots, source, nodes, entry, edit, keep: createDirectCallEditFilter(roots, source) };
}

test("only the impossible fixed-arity template candidate loses a dependent call edit", async (t) => {
  const data = await fixture(
    t,
    overloads +
      "template<class T> void caller(T value) { old(0, value, 0); }\n}\nint main() { frond::caller(1); }\n",
  );
  const call = data.edit("old(0, value, 0)");
  assert.equal(data.keep(data.entry("void (int, T)"), call), false);
  assert.equal(data.keep(data.entry("void (int, T, int)"), call), true);
  const declaration = { start: data.source.indexOf("old(int, T);"), old: "old", new: "restored" };
  assert.equal(data.keep(data.entry("void (int, T)"), declaration), true);
  assert.equal(data.keep({ ...data.entry("void (int, T)"), role: "type" }, call), true);
});

test("a braced argument is one AST argument and genuine two-argument calls remain", async (t) => {
  const data = await fixture(
    t,
    overloads +
      "template<class T> void caller(T value) { old(0, value, {}); old(0, value); }\n}\nint main() {}\n",
  );
  const two = data.entry("void (int, T)");
  assert.equal(data.keep(two, data.edit("old(0, value, {})")), false);
  assert.equal(data.keep(two, data.edit("old(0, value)")), true);
});

test("compiler byte locations and rename UTF-16 offsets stay distinct after Unicode", async (t) => {
  const data = await fixture(
    t,
    'const char* label = "💡";\n' +
      overloads +
      "template<class T> void caller(T value) { old(0, value, 0); }\n}\nint main() {}\n",
  );
  assert.equal(data.keep(data.entry("void (int, T)"), data.edit("old(0, value, 0)")), false);
});

test("defaults, variadics and parameter packs never justify discarding a call", async (t) => {
  for (const [declarations, signature] of [
    ["template<class T> void old(int, T, int = 0);", "void (int, T, int)"],
    ["template<class T> void old(int, T, ...);", "void (int, T, ...)"],
    ["template<class... T> void old(int, T...);", "void (int, T...)"],
  ]) {
    const data = await fixture(
      t,
      `namespace frond { ${declarations}\ntemplate<class T> void caller(T value) { old(0, value); }\n}\nint main() {}\n`,
    );
    assert.equal(data.keep(data.entry(signature), data.edit("old(0, value)")), true);
  }
});

test("pack-expanded calls, explicit template names and macro observations remain conservative", async (t) => {
  for (const [caller, call] of [
    ["template<class... T> void caller(T... value) { old(0, value...); }", "old(0, value...)"],
    ["template<class T> void caller(T value) { old<T>(0, value, 0); }", "old<T>"],
    [
      "#define APPLY(value) old(0, value, 0)\ntemplate<class T> void caller(T value) { APPLY(value); }",
      "old(0, value, 0)",
    ],
  ]) {
    const data = await fixture(t, overloads + caller + "\n}\nint main() {}\n");
    assert.equal(data.keep(data.entry("void (int, T, int)"), data.edit(call)), true);
    assert.equal(data.keep(data.entry("void (int, T)"), data.edit(call)), true);
  }
});

test("contradictory, unclassified and missing observations cannot remove an edit", async (t) => {
  const data = await fixture(
    t,
    overloads + "template<class T> void caller(T value) { old(0, value, 0); }\n}\nint main() {}\n",
  );
  const entry = data.entry("void (int, T)");
  const edit = data.edit("old(0, value, 0)");
  const call = data.nodes.find(
    (node) => node.kind === "CallExpr" && node.inner?.[0]?.kind === "UnresolvedLookupExpr",
  );
  assert.ok(call);
  const conflicting = structuredClone(call);
  conflicting.inner.pop();
  assert.equal(
    createDirectCallEditFilter([...data.roots, conflicting], data.source)(entry, edit),
    true,
  );
  const declaration = data.nodes.find(
    (node) => node.kind === "FunctionDecl" && node.loc?.offset === entry.offset,
  );
  const resolved = structuredClone(call);
  resolved.inner[0] = {
    kind: "DeclRefExpr",
    range: call.inner[0].range,
    referencedDecl: { id: declaration.id, kind: "FunctionDecl", name: "old" },
  };
  assert.equal(
    createDirectCallEditFilter([...data.roots, resolved], data.source)(entry, edit),
    true,
  );
  const unknown = structuredClone(call.inner[0]);
  unknown.kind = "DeclRefExpr";
  delete unknown.lookups;
  assert.equal(
    createDirectCallEditFilter([...data.roots, unknown], data.source)(entry, edit),
    true,
  );
  assert.equal(data.keep({ ...entry, offset: -1 }, edit), true);
  assert.equal(data.keep(entry, { ...edit, old: "other" }), true);
});

test("nameless unsupported references veto exclusions at their source range", async (t) => {
  const data = await fixture(
    t,
    overloads + "template<class T> void caller(T value) { old(0, value, 0); }\n}\nint main() {}\n",
  );
  const entry = data.entry("void (int, T)");
  const edit = data.edit("old(0, value, 0)");
  const lookup = data.nodes.find((node) => node.kind === "UnresolvedLookupExpr");
  for (const reference of [
    { kind: "DependentScopeDeclRefExpr", range: lookup.range },
    { kind: "DependentScopeDeclRefExpr" },
    ...[0, -1, 1.5, "3", null, data.source.length + 1].map((tokLen) => ({
      kind: "DependentScopeDeclRefExpr",
      range: { begin: lookup.range.begin, end: { ...lookup.range.end, tokLen } },
    })),
  ]) {
    const keep = createDirectCallEditFilter([...data.roots, reference], data.source);
    assert.equal(
      keep(entry, edit),
      true,
      "An unclassified reference must not disappear from the evidence",
    );
  }
});

test("same-arity call exclusions require an explicit asynchronous compiler witness", async (t) => {
  const data = await fixture(
    t,
    overloads + "template<class T> void caller(T value) { old(0, value, 0); }\n}\nint main() {}\n",
  );
  const entry = data.entry("void (int, T, int)");
  const edit = data.edit("old(0, value, 0)");
  let observations = 0;
  const keep = createDirectCallEditFilter(data.roots, data.source, {
    isDominated: async ({ selectedFunctions, candidateFamilies, call }) => {
      observations++;
      assert.ok(selectedFunctions.every((node) => node.kind === "FunctionDecl"));
      assert.ok(candidateFamilies.some((family) => family.includes(selectedFunctions[0])));
      assert.equal(call.kind, "CallExpr");
      return true;
    },
  });
  assert.equal(await keep(entry, edit), false);
  assert.ok(observations > 0);
  const unknown = createDirectCallEditFilter(data.roots, data.source, {
    isDominated: async () => false,
  });
  assert.equal(await unknown(entry, edit), true);
});

test("a resolved selected use vetoes an asynchronous sibling witness", async (t) => {
  const data = await fixture(
    t,
    overloads +
      "template<class T> void caller(T value) { old(0, value, 0); }\n}\nint main() { frond::caller(1); }\n",
  );
  const keep = createDirectCallEditFilter(data.roots, data.source, {
    isDominated: async () => true,
  });
  assert.equal(await keep(data.entry("void (int, T, int)"), data.edit("old(0, value, 0)")), true);
});
test("a repeated shallow AST stub cannot erase complete declaration metadata", async (t) => {
  const data = await fixture(
    t,
    overloads + "template<class T> void caller(T value) { old(0, value, 0); }\n}\nint main() {}\n",
  );
  const entry = data.entry("void (int, T)");
  const declaration = data.nodes.find(
    (node) => node.kind === "FunctionDecl" && node.loc?.offset === entry.offset,
  );
  const stub = {
    id: declaration.id,
    kind: declaration.kind,
    name: declaration.name,
    type: declaration.type,
  };
  assert.equal(
    createDirectCallEditFilter([...data.roots, stub], data.source)(
      entry,
      data.edit("old(0, value, 0)"),
    ),
    false,
  );
});
