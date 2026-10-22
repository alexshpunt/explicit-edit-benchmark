import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { projectAst } from "../../src/suites/explicit-edit-multi-agent/cpp/compiler-ast.mjs";
import { createDirectCallEditFilter } from "../../src/suites/explicit-edit-multi-agent/cpp/direct-call-edits.mjs";

const declarations = `namespace frond {
struct Float {}; struct Byte {}; struct Third {};
template<class T> struct Box {};
void old(const Box<Float>&) {}
void old(const Box<Byte>&) {}
`;
const shared = "template<class T> void shared(const Box<T>& value) { old(value); }\n";
const both =
  "int main() { frond::shared(frond::Box<frond::Float>{}); frond::shared(frond::Box<frond::Byte>{}); }\n";

function flatten(roots) {
  const result = [];
  function visit(node) {
    result.push(node);
    for (const child of node.inner ?? []) visit(child);
  }
  roots.forEach(visit);
  return result;
}
async function fixture(t, source = declarations + shared + "}\n" + both) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/shared-call-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "main.cpp");
  await writeFile(file, source);
  const roots = await projectAst(file, ["-std=c++17"]);
  const nodes = flatten(roots);
  const entry = (type) => {
    const node = nodes.find(
      (node) =>
        node.kind === "FunctionDecl" &&
        node.name === "old" &&
        node.type?.qualType?.startsWith(`void (const Box<${type}> &`) &&
        Number.isInteger(node.loc?.offset),
    );
    assert.ok(node, `Missing compiler declaration for ${type}`);
    return { offset: node.loc.offset, name: "old", newName: "restored", role: "function" };
  };
  const required = [entry("Float"), entry("Byte")];
  const edit = { start: source.indexOf("old(value)"), old: "old", new: "restored" };
  const keep = createDirectCallEditFilter(roots, source);
  return {
    roots,
    nodes,
    source,
    entry,
    required,
    edit,
    keep,
    proof: { required, allowed: required, edit },
  };
}

test("one physical generic callee has positive resolved evidence for both overloads", async (t) => {
  const data = await fixture(t);
  assert.equal(data.keep.sharedCall(data.proof), true);
  for (const entry of data.required) assert.equal(await data.keep(entry, data.edit), true);
  assert.equal(
    data.keep.sharedCall({ ...data.proof, required: [...data.required, data.required[0]] }),
    true,
  );
});

test("an unresolved lookup and one resolved instantiation cannot certify the second binding", async (t) => {
  const data = await fixture(
    t,
    declarations + shared + "}\nint main() { frond::shared(frond::Box<frond::Float>{}); }\n",
  );
  assert.equal(data.keep.sharedCall(data.proof), false);
  const uninstantiated = await fixture(t, declarations + shared + "}\nint main() {}\n");
  assert.equal(uninstantiated.keep.sharedCall(uninstantiated.proof), false);
});

test("every resolved or same-arity lookup family must belong to the allowed group", async (t) => {
  const extra = "void old(const Box<Third>&) {}\n";
  const data = await fixture(
    t,
    declarations +
      extra +
      shared +
      "}\n" +
      both.replace("; }", "; frond::shared(frond::Box<frond::Third>{}); }"),
  );
  assert.equal(data.keep.sharedCall(data.proof), false);
  assert.equal(
    data.keep.sharedCall({ ...data.proof, allowed: [...data.required, data.entry("Third")] }),
    true,
  );
  const notInstantiated = await fixture(t, declarations + extra + shared + "}\n" + both);
  assert.equal(notInstantiated.keep.sharedCall(notInstantiated.proof), false);
});

test("different fixed arities are not evidence that bindings share a generic call", async (t) => {
  const data = await fixture(
    t,
    declarations.replace("void old(const Box<Byte>&)", "void old(const Box<Byte>&, int)") +
      shared +
      "}\nint main() { frond::shared(frond::Box<frond::Float>{}); }\n",
  );
  assert.equal(data.keep.sharedCall(data.proof), false);
});

test("unknown lookup identities and unsupported observations veto positive coupling", async (t) => {
  const data = await fixture(t);
  const call = data.nodes.find(
    (node) =>
      node.kind === "CallExpr" &&
      node.inner?.[0]?.kind === "UnresolvedLookupExpr" &&
      node.inner[0].name === "old",
  );
  assert.ok(call);
  const missingCandidate = structuredClone(call);
  missingCandidate.inner[0].lookups.push({
    id: "missing-family",
    kind: "FunctionDecl",
    name: "old",
  });
  assert.equal(
    createDirectCallEditFilter([...data.roots, missingCandidate], data.source).sharedCall(
      data.proof,
    ),
    false,
  );
  const unsupported = {
    kind: "DependentScopeDeclRefExpr",
    range: structuredClone(call.inner[0].range),
  };
  assert.equal(
    createDirectCallEditFilter([...data.roots, unsupported], data.source).sharedCall(data.proof),
    false,
  );
  const missingResolved = structuredClone(call);
  missingResolved.inner[0] = {
    kind: "DeclRefExpr",
    range: structuredClone(call.inner[0].range),
    referencedDecl: { id: "missing-family", kind: "FunctionDecl", name: "old" },
  };
  assert.equal(
    createDirectCallEditFilter([...data.roots, missingResolved], data.source).sharedCall(
      data.proof,
    ),
    false,
  );
  const missingCallRange = structuredClone(call);
  delete missingCallRange.range;
  assert.equal(
    createDirectCallEditFilter([...data.roots, missingCallRange], data.source).sharedCall(
      data.proof,
    ),
    false,
  );
});

test("mapping, declaration identity and function role are mandatory for every group member", async (t) => {
  const data = await fixture(t);
  for (const entry of [
    { ...data.required[1], newName: "other" },
    { ...data.required[1], name: "other" },
    { ...data.required[1], role: "variable" },
    { ...data.required[1], offset: data.edit.start },
    { ...data.required[1], offset: -1 },
  ]) {
    assert.equal(
      data.keep.sharedCall({ ...data.proof, required: [data.required[0], entry] }),
      false,
    );
    assert.equal(
      data.keep.sharedCall({ ...data.proof, allowed: [...data.required, entry] }),
      false,
    );
  }
  assert.equal(
    data.keep.sharedCall({ ...data.proof, required: [data.required[0]], allowed: data.required }),
    false,
  );
  assert.equal(
    data.keep.sharedCall({ ...data.proof, required: [data.required[0], data.required[0]] }),
    false,
  );
  for (const input of [undefined, null, {}, { ...data.proof, edit: null }])
    assert.equal(data.keep.sharedCall(input), false);
  assert.equal(data.keep.sharedCall({ ...data.proof, allowed: [data.required[0]] }), false);
  assert.equal(
    data.keep.sharedCall({ ...data.proof, edit: { ...data.edit, new: "other" } }),
    false,
  );
});

test("declarations and macro-expanded or non-call references cannot prove shared calls", async (t) => {
  const data = await fixture(t);
  assert.equal(
    data.keep.sharedCall({
      ...data.proof,
      edit: { ...data.edit, start: data.source.indexOf("old(const Box<Float>") },
    }),
    false,
  );
  const macro = await fixture(
    t,
    declarations +
      "#define APPLY(value) old(value)\ntemplate<class T> void shared(const Box<T>& value) { APPLY(value); }\n}\n" +
      both,
  );
  assert.equal(macro.keep.sharedCall(macro.proof), false);
  const pointerSource =
    declarations + shared + "void (*pointer)(const Box<Float>&) = &old;\n}\n" + both;
  const pointer = await fixture(t, pointerSource);
  assert.equal(
    pointer.keep.sharedCall({
      ...pointer.proof,
      edit: { ...pointer.edit, start: pointerSource.indexOf("old;") },
    }),
    false,
  );
});

test("macro arguments and missing argument locations cannot certify coupling", async (t) => {
  const source =
    declarations + "#define ARG value\n" + shared.replace("old(value)", "old(ARG)") + "}\n" + both;
  const data = await fixture(t, source);
  assert.equal(
    data.keep.sharedCall({
      ...data.proof,
      edit: { ...data.edit, start: source.indexOf("old(ARG)") },
    }),
    false,
  );
  const ordinary = await fixture(t);
  const call = ordinary.nodes.find(
    (node) =>
      node.kind === "CallExpr" &&
      node.inner?.[0]?.kind === "UnresolvedLookupExpr" &&
      node.inner[0].name === "old",
  );
  const incomplete = structuredClone(call);
  delete incomplete.inner[1].range;
  assert.equal(
    createDirectCallEditFilter([...ordinary.roots, incomplete], ordinary.source).sharedCall(
      ordinary.proof,
    ),
    false,
  );
});

test("only provably different fixed arities may be ignored in the lookup closure", async (t) => {
  for (const [extra, expected] of [
    ["void old(const Box<Third>&, int) {}\n", true],
    ["void old(const Box<Third>&, int = 0) {}\n", false],
  ]) {
    const data = await fixture(t, declarations + extra + shared + "}\n" + both);
    assert.equal(data.keep.sharedCall(data.proof), expected);
  }
});

test("defaults are harmless only for fully supplied required families; variadics remain unsupported", async (t) => {
  for (const [parameter, expected] of [
    ["const Box<Byte>& = Box<Byte>{}", true],
    ["const Box<Byte>&, ...", false],
  ]) {
    const data = await fixture(
      t,
      declarations.replace("const Box<Byte>&", parameter) + shared + "}\n" + both,
    );
    assert.equal(data.keep.sharedCall(data.proof), expected);
  }
});

test("only compiler-inserted defaults may be absent from written argument counts", async (t) => {
  const data = await fixture(t);
  const resolved = data.nodes.find((node) => {
    if (node.kind !== "CallExpr") return false;
    let callee = node.inner?.[0];
    while (callee?.kind === "ImplicitCastExpr" && callee.inner?.length === 1)
      callee = callee.inner[0];
    return callee?.kind === "DeclRefExpr" && callee.range?.begin?.offset === data.edit.start;
  });
  assert.ok(resolved);
  const extra = structuredClone(resolved);
  extra.inner.push({
    kind: "CXXDefaultArgExpr",
    type: { qualType: "bool" },
    range: { begin: {}, end: {} },
  });
  assert.equal(
    createDirectCallEditFilter([...data.roots, extra], data.source).sharedCall(data.proof),
    false,
  );
  const written = structuredClone(resolved);
  written.inner[1].kind = "CXXDefaultArgExpr";
  assert.equal(
    createDirectCallEditFilter([...data.roots, written], data.source).sharedCall(data.proof),
    false,
  );
});

test("UTF-16 edit positions and byte declaration origins remain distinct for shared evidence", async (t) => {
  const data = await fixture(
    t,
    'const char* label = "💡";\n' + declarations + shared + "}\n" + both,
  );
  assert.equal(data.keep.sharedCall(data.proof), true);
});
