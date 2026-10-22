import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { projectAst } from "../../src/suites/explicit-edit-multi-agent/cpp/compiler-ast.mjs";
import { createDirectCallEditFilter } from "../../src/suites/explicit-edit-multi-agent/cpp/direct-call-edits.mjs";
import { proveSharedCallInstantiation } from "../../src/suites/explicit-edit-multi-agent/cpp/shared-call-instantiation.mjs";

const source = `namespace frond {
struct Float {}; struct Byte {}; struct Other {}; struct Fourth {};
template<typename T> struct Box {};
void old(const Box<Float>&) {}
void old(const Box<Byte>&) {}
void old(const Box<Other>&) {}
void old(const Box<Fourth>&) {}
template<typename T> void shared(const Box<T>& value, int level) { if (level) old(value); }
}
int main() {}
`;
const hash = (text) => createHash("sha256").update(text).digest("hex");
function flatten(roots) {
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    (node.inner ?? []).forEach(visit);
  }
  roots.forEach(visit);
  return nodes;
}
async function fixture(t, text = source, types = ["Float", "Byte", "Other", "Fourth"]) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/shared-call-instantiation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "original.cpp");
  await writeFile(filename, text);
  const roots = await projectAst(filename, ["-std=c++17", "-pthread"]);
  const nodes = flatten(roots);
  const required = types.map((type) => {
    const node = nodes.find(
      (item) =>
        item.kind === "FunctionDecl" &&
        item.name === "old" &&
        item.type?.qualType?.startsWith(`void (const Box<${type}> &`),
    );
    assert.ok(node);
    return { offset: node.loc.offset, name: "old", newName: "restored", role: "function" };
  });
  return {
    roots,
    source: text,
    sourcePath: filename,
    directory,
    required,
    allowed: required,
    edit: { start: text.indexOf("old(value"), old: "old", new: "restored" },
  };
}
function compile(text) {
  execFileSync("clang++", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
    input: text,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("uninstantiated original calls gain compiler evidence without changing their source prefix", async (t) => {
  const data = await fixture(t);
  assert.equal(createDirectCallEditFilter(data.roots, data.source).sharedCall(data), false);
  const result = await proveSharedCallInstantiation(data);
  assert.ok(result);
  assert.equal(result.sharedCall(data), true);
  assert.equal(result.evidence.sourceSha256, hash(data.source));
  assert.equal(result.evidence.probeSha256, hash(data.source + result.evidence.suffix));
  const probe = await readFile(result.evidence.probeFile, "utf8");
  assert.equal(probe, data.source + result.evidence.suffix);
  assert.equal(result.evidence.requiredDeclarations.length, 4);
  assert.equal(
    result.evidence.calleeOffset,
    Buffer.byteLength(data.source.slice(0, data.edit.start)),
  );
  compile(probe);
  for (const entry of data.required) {
    const changed = probe.slice(0, entry.offset) + "restored" + probe.slice(entry.offset + 3);
    assert.throws(() => compile(changed.replace("old(value)", "restored(value)")));
  }
  compile(probe.replaceAll(/\bold\b/g, "restored"));
  const second = await proveSharedCallInstantiation(data);
  assert.ok(second);
  assert.notEqual(second.evidence.probeFile, result.evidence.probeFile);
});

test("ordinary initialized locals and Unicode retain byte-based original call identity", async (t) => {
  const data = await fixture(
    t,
    `const char* label = "é";\n${source.replace("if (level) old(value);", "auto copy = value; if (level) old(value);")}`,
  );
  const result = await proveSharedCallInstantiation(data);
  assert.ok(result);
  assert.equal(result.sharedCall(data), true);
  assert.notEqual(result.evidence.calleeOffset, data.edit.start);
  assert.equal(result.sharedCall({ ...data, edit: null }), false);
  assert.equal(
    result.sharedCall({ ...data, edit: { ...data.edit, start: data.source.length + 1 } }),
    false,
  );
});
test("two overloads and forward template declarations retain physical identity across compiler lifetimes", async (t) => {
  const text = source.replace(
    "template<typename T> void shared",
    "template<typename T> void shared(const Box<T>&, int);\ntemplate<typename T> void shared",
  );
  const data = await fixture(t, text, ["Float", "Byte"]);
  // All visible families must be included even if the proof needs just two.
  data.allowed = flatten(data.roots)
    .filter((node) => node.kind === "FunctionDecl" && node.name === "old")
    .map((node) => ({
      offset: node.loc.offset,
      name: "old",
      newName: "restored",
      role: "function",
    }));
  const result = await proveSharedCallInstantiation(data);
  assert.ok(result);
  assert.equal(result.sharedCall(data), true);
  assert.equal(result.evidence.requiredDeclarations.length, 2);
});

test("forward template instantiation stubs do not replace written enclosing declarations", async (t) => {
  const text = source.replace(
    "template<typename T> void shared",
    "template<typename T> void shared(const Box<T>&, int);\nvoid instantiate_early() { shared(Box<Float>{}, 1); }\ntemplate<typename T> void shared",
  );
  const data = await fixture(t, text);
  const result = await proveSharedCallInstantiation(data);
  assert.ok(result);
  assert.equal(result.sharedCall(data), true);
  assert.equal(result.evidence.requiredDeclarations.length, 4);
});

test("an interior integer slot and explicit defaulted arguments preserve original template proof", async (t) => {
  const text = source
    .replaceAll(
      /void old\(const Box<([A-Za-z]+)>&\)/g,
      "void old(const Box<$1>&, bool locked = false)",
    )
    .replace(
      "int level) { if (level) old(value);",
      "int level, bool locked = false) { if (level) old(value, locked);",
    );
  const data = await fixture(t, text);
  const result = await proveSharedCallInstantiation(data);
  assert.ok(result);
  assert.equal(result.sharedCall(data), true);
  compile(data.source + result.evidence.suffix);
});

test("compiler-empty statement slots do not crash template proof inspection", async (t) => {
  const data = await fixture(
    t,
    source.replace("if (level) old(value);", "for (; level; --level) old(value);"),
  );
  assert.ok(flatten(data.roots).some((node) => Object.keys(node).length === 0));
  const result = await proveSharedCallInstantiation(data);
  assert.ok(result);
  assert.equal(result.sharedCall(data), true);
  const malformed = structuredClone(data.roots);
  const template = flatten(malformed).find(
    (node) => node.kind === "FunctionTemplateDecl" && node.name === "shared",
  );
  template.inner.push({ unsupportedMetadata: true });
  assert.equal(await proveSharedCallInstantiation({ ...data, roots: malformed }), undefined);
});

test("unknown original observations and incomplete lookup closure still veto private probes", async (t) => {
  const data = await fixture(t);
  const call = flatten(data.roots).find(
    (node) => node.kind === "UnresolvedLookupExpr" && node.name === "old",
  );
  assert.ok(call);
  const unknown = { kind: "DependentScopeDeclRefExpr", range: structuredClone(call.range) };
  assert.equal(
    await proveSharedCallInstantiation({ ...data, roots: [...data.roots, unknown] }),
    undefined,
  );
  assert.equal(
    await proveSharedCallInstantiation({ ...data, allowed: data.required.slice(0, 2) }),
    undefined,
  );
});

test("packs, macros and ambiguous enclosing integer slots remain uncertified", async (t) => {
  for (const text of [
    source.replace("int level)", "int level, int other)"),
    source
      .replace("typename T> void shared", "typename... T> void shared")
      .replace("Box<T>& value", "Box<T...>& value"),
    source
      .replace(
        "template<typename T> void shared",
        "#define APPLY(value) old(value)\ntemplate<typename T> void shared",
      )
      .replace("if (level) old(value)", "if (level) APPLY(value)"),
    source.replace("int level)", "long level)"),
  ]) {
    const data = await fixture(t, text);
    if (data.edit.start < 0) data.edit.start = text.indexOf("old(value)");
    assert.equal(await proveSharedCallInstantiation(data), undefined);
  }
});

test("filename-sensitive template branches cannot gain evidence from a different probe filename", async (t) => {
  for (const check of [
    "__FILE__[sizeof(__FILE__) - 10] == 'p'",
    "FILE_TOKEN(__FI, LE__)[sizeof(FILE_TOKEN(__FI, LE__)) - 10] == 'p'",
  ]) {
    const text =
      "#define FILE_JOIN(a,b) a##b\n#define FILE_TOKEN(a,b) FILE_JOIN(a,b)\n" +
      source.replace("if (level) old(value);", `if constexpr (${check}) old(value);`);
    const data = await fixture(t, text);
    assert.equal(await proveSharedCallInstantiation(data), undefined);
  }
});

test("private overlay retains the original logical filename without replacing its disk source", async (t) => {
  const data = await fixture(
    t,
    source.replace(
      "if (level) old(value);",
      "if constexpr (__FILE__[sizeof(__FILE__) - 10] == 'g') old(value);",
    ),
  );
  const result = await proveSharedCallInstantiation(data);
  assert.ok(result);
  assert.equal(result.sharedCall(data), true);
  assert.equal(result.evidence.logicalFile, data.sourcePath);
  assert.equal(await readFile(data.sourcePath, "utf8"), data.source);
  const overlay = await readFile(result.evidence.overlayFile, "utf8");
  assert.equal(hash(overlay), result.evidence.overlaySha256);
  assert.deepEqual(JSON.parse(overlay), {
    version: 0,
    "use-external-names": false,
    roots: [
      { type: "file", name: data.sourcePath, "external-contents": result.evidence.probeFile },
    ],
  });
});

test("clock builtins and token-pasted clock expansions remain unsupported", async (t) => {
  for (const expression of ["__TIME__", "FILE_TOKEN(__TI, ME__)", "__DATE__", "__TIMESTAMP__"]) {
    const text =
      "#define FILE_JOIN(a,b) a##b\n#define FILE_TOKEN(a,b) FILE_JOIN(a,b)\n" +
      source.replace(
        "if (level) old(value);",
        `if constexpr (sizeof(${expression}) > 0) old(value);`,
      );
    const data = await fixture(t, text);
    assert.equal(await proveSharedCallInstantiation(data), undefined);
  }
});

test("late-only overloads and failed original-template instantiations cannot supply evidence", async (t) => {
  const text = source
    .replace("void old(const Box<Byte>&) {}\n", "")
    .replace("}\nint main()", "void old(const Box<Byte>&) {}\n}\nint main()");
  const data = await fixture(t, text);
  assert.equal(await proveSharedCallInstantiation(data), undefined);
  const failed = await fixture(
    t,
    source.replace("if (level) old(value);", "if (level) old(value); value.missing();"),
  );
  assert.equal(await proveSharedCallInstantiation(failed), undefined);
});
