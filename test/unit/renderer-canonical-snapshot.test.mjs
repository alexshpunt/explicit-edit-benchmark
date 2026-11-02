import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeCpp,
  canonicalizeProject,
} from "../../src/suites/explicit-edit-multi-agent/grading/canonical-snapshot.mjs";
import { decodeSourceBytes } from "../../src/suites/explicit-edit-multi-agent/cpp/source-bytes.mjs";

const text = async (source) => (await canonicalizeCpp(source)).text;

test("canonical C++ is ordered source code with complete statement lines before large moves", async () => {
  const declarations = Array.from({ length: 2000 }, (_, i) => `int field_${i} = ${i};`);
  const source = (items) => `int value(){${items.join("\n")}return field_0;}\n`;
  const baseline = await canonicalizeCpp(source(declarations));
  const statements = new Set(
    baseline.text
      .trim()
      .split("\n")
      .map((line) => line.trim()),
  );
  for (let i = 0; i < declarations.length; i++)
    assert.ok(statements.has(`int field_${i} = ${i} ;`));
  assert.ok(Buffer.byteLength(baseline.text) < Buffer.byteLength(source(declarations)) * 2);
  assert.equal((await canonicalizeCpp(baseline.text)).text, baseline.text);
  const { prepareCanonicalDiff } =
    await import("../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs");
  const reference = await canonicalizeCpp(source(declarations.slice(0, 500)));
  const prepared = prepareCanonicalDiff(
    { version: "ordered-code-fixture", files: { "value.cpp": baseline.text } },
    { version: "ordered-code-fixture", files: { "value.cpp": reference.text } },
  );
  assert.equal(prepared.totalHunks, 1);
  assert.equal(baseline.errors.length, 0);
  assert.equal(reference.errors.length, 0);
});

test("canonical source sorts definitions and is directly compilable C++ rather than parser JSON", async () => {
  const code = await text("int z(){return 7;} int a(){return 3;}");
  assert.equal(code, "int a ( ) {\n  return 3 ;\n}\nint z ( ) {\n  return 7 ;\n}\n");
  const snapshot = await canonicalizeProject({
    "main.cpp": "int z(){return 7;} int a(){return 3;}",
  });
  assert.equal(snapshot.files["main.cpp"], code);
});

test("separated statement changes remain independent ordinary canonical hunks", async () => {
  const source = Array.from({ length: 80 }, (_, i) => `int field_${i} = ${i};`).join("\n");
  const project = async (body) => canonicalizeProject({ "value.cpp": `void value(){${body}}\n` });
  const start = await project(source);
  const reference = await project(source.replace("field_11 = 11", "field_11 = 12"));
  const actual = await project(
    source.replace("field_11 = 11", "field_11 = 12").replace("field_61 = 61", "field_61 = 62"),
  );
  const { compareCanonicalSnapshots } =
    await import("../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs");
  const compared = compareCanonicalSnapshots(start, reference, actual);
  assert.equal(compared.totalHunks, 1);
  assert.equal(compared.passedHunks, 1);
  assert.equal(compared.actualHunks.length, 2);
  assert.equal(compared.mismatches.length, 1);
  assert.equal(compared.mismatches[0].kind, "extra");
});

test("canonical C++ ignores layout and comments without losing literal contents", async () => {
  const before = "int value(int x) { /* note */ return x + 1; } // end\n";
  const after = "int\nvalue ( int x )\n{ return x+1 ; }\n";
  assert.equal(await text(before), await text(after));
  for (const literal of ['"a  b // literal"', 'R"xx( a  b\n/* literal */ café 🙂 )xx"', "' '"]) {
    const snapshot = await text(`const auto value = ${literal};`);
    assert.ok(snapshot.includes(literal));
    assert.notEqual(snapshot, await text(`const auto value = ${literal.replace(" ", "  ")};`));
  }
});

test("canonical C++ sorts function and class definition placement inside a namespace", async () => {
  const first =
    "namespace N { int z(){return 1;} struct B {int field;}; int a(){return 2;} struct A {}; }";
  const reordered =
    "namespace N { struct A {}; int a(){return 2;} struct B {int field;}; int z(){return 1;} }";
  assert.equal(await text(first), await text(reordered));
  assert.equal(
    await text("int z(){return 1;} int a(){return 2;}"),
    await text("int a(){return 2;} int z(){return 1;}"),
  );
});

test("adjacent named namespace blocks represent the same structural scope", async () => {
  const joined = "namespace N { int x; int y; int f(){return 2;} }";
  const split = "namespace N { int x; } namespace N { int y; int f(){return 2;} }";
  assert.equal(await text(joined), await text(split));
  assert.equal(
    await text("namespace A { namespace B { int x; int y; } }"),
    await text("namespace A { namespace B { int x; } namespace B { int y; } }"),
  );
  assert.notEqual(await text(joined), await text(split.replace("int y;", "int y = 1;")));
  assert.notEqual(
    await text(joined),
    await text(split.replace("namespace N { int y", "namespace M { int y")),
  );
  assert.notEqual(
    await text("namespace N { int x; int y; }"),
    await text("namespace N { int x; }\n#define X 1\nnamespace N { int y; }"),
  );
  assert.notEqual(
    await text("namespace N { int x; int y; }"),
    await text("namespace N { int x; }\n#if FOO\nnamespace N { int y; }\n#endif"),
  );
  assert.notEqual(
    await text("namespace N { int x; int y; }"),
    await text("inline namespace N { int x; } namespace N { int y; }"),
  );
});
test("namespace normalization does not reorder definitions across using directives", async () => {
  const before =
    "namespace N { int z(){return value;} } namespace N { using namespace A; int a(){return value;} }";
  const after =
    "namespace N { int a(){return value;} } namespace N { using namespace A; int z(){return value;} }";
  assert.notEqual(await text(before), await text(after));
  assert.notEqual(
    await text(before.replace("using namespace A", "using A::value")),
    await text(after.replace("using namespace A", "using A::value")),
  );
  assert.notEqual(
    await text(
      "namespace N { int z(){return value;} } namespace N { int value; int a(){return value;} }",
    ),
    await text(
      "namespace N { int a(){return value;} } namespace N { int value; int z(){return value;} }",
    ),
  );
});
test("namespace normalization preserves original projection coordinates and literals", async () => {
  const source =
    'const char* s = "namespace N { } café";\nnamespace N { int a; }\nnamespace N { int b; }';
  const result = await canonicalizeCpp(source, { projection: true });
  assert.ok(result.text.includes('"namespace N { } café"'));
  const nodes = result.projection.children.filter((item) => item.type === "namespace_definition");
  assert.equal(nodes.length, 2);
  assert.equal(source.slice(nodes[1].start, nodes[1].end), "namespace N { int b; }");
});
test("reopened namespaces have stable ordering after their nested definitions normalize", async () => {
  const one = "namespace N { int z(){return 1;} int a(){return 2;} }";
  const two = "namespace N { int m(){return 3;} }";
  const code = await text(one + two);
  assert.equal(code, await text(code));
  assert.equal(code, await text(two + one));
});
test("canonical C++ sorts method placement but preserves member layout and access", async () => {
  const first =
    "struct A { int z(){return 1;} int x; int y; int a(){return 2;} private: int p(){return 3;} };";
  const reordered =
    "struct A { int a(){return 2;} int x; int y; int z(){return 1;} private: int p(){return 3;} };";
  assert.equal(await text(first), await text(reordered));
  assert.notEqual(await text(first), await text(first.replace("int x; int y;", "int y; int x;")));
  assert.notEqual(await text(first), await text(first.replace("private:", "public:")));
  const privateMethod = "struct A { int a(){return 1;} private: int z(){return 2;} };";
  const switched = "struct A { int z(){return 2;} private: int a(){return 1;} };";
  assert.notEqual(await text(privateMethod), await text(switched));
});

test("canonical C++ sorts template definitions without sorting template parameters", async () => {
  const a = "template<class T> T z(T x){return x;} template<class T> T a(T x){return x;}";
  const b = "template<class T> T a(T x){return x;} template<class T> T z(T x){return x;}";
  assert.equal(await text(a), await text(b));
  assert.notEqual(
    await text("template<class T,class U> int f(){return 1;}"),
    await text("template<class U,class T> int f(){return 1;}"),
  );
});

test("canonical C++ normalizes method prototypes without sorting callback fields", async () => {
  assert.equal(
    await text("struct A { int z(); int x; int a(); };"),
    await text("struct A { int a(); int x; int z(); };"),
  );
  assert.notEqual(
    await text("struct A { int (*z)(int); int (*a)(int); };"),
    await text("struct A { int (*a)(int); int (*z)(int); };"),
  );
  assert.notEqual(
    await text("struct A { int z(), x; int a(), y; };"),
    await text("struct A { int a(), y; int z(), x; };"),
  );
});

test("canonical C++ retains statements, expressions, parameters and argument order", async () => {
  for (const [a, b] of [
    ["int f(){int a=1;int b=2;return a+b;}", "int f(){int b=2;int a=1;return a+b;}"],
    ["int f(int x,int y){return x-y;}", "int f(int y,int x){return x-y;}"],
    ["int f(int x,int y){return x-y;}", "int f(int x,int y){return y-x;}"],
    ["int f(){return call(1,2);}", "int f(){return call(2,1);}"],
    ["int f(){return 1;} int unused(){return 2;}", "int f(){return 1;} int unused(){return 9;}"],
  ])
    assert.notEqual(await text(a), await text(b));
});

test("canonical C++ does not move definitions between preprocessor branches or lexical scopes", async () => {
  const a = "#if A\nint f(){return 1;}\n#else\nint g(){return 2;}\n#endif\n";
  const b = "#if A\nint g(){return 2;}\n#else\nint f(){return 1;}\n#endif\n";
  assert.notEqual(await text(a), await text(b));
  assert.notEqual(
    await text("namespace A { int f(){return 1;} }"),
    await text("namespace B { int f(){return 1;} }"),
  );
  const before = "int z(){return 1;}\n#define VALUE 2\nint a(){return VALUE;}\n";
  const after = "int a(){return VALUE;}\n#define VALUE 2\nint z(){return 1;}\n";
  assert.notEqual(await text(before), await text(after));
});

test("inactive preprocessor branches normalize blank layout without accumulating newlines", async () => {
  const source = "#if 0\n\n\nint value(){return 3;}\n#endif\n";
  const code = await text(source);
  assert.equal(code, await text(code));
  assert.equal(code, await text(source.replace("\n\n\n", "\n")));
});

test("canonical C++ preserves macro argument gaps that change stringification", async () => {
  const source = (argument) =>
    `#define stringify(x) #x\nconst char* value(){return stringify(${argument});}\n`;
  assert.notEqual(await text(source("alpha + beta")), await text(source("alpha+beta")));
});

test("macro argument gaps collapse comments and whitespace width without losing separation", async () => {
  const source = (argument) =>
    `#define stringify(x) #x\nconst char* value(){return stringify(${argument});}\n`;
  assert.equal(
    await text(source(" alpha /* note */ +  beta ")),
    await text(source("alpha + beta")),
  );
  assert.notEqual(await text(source("alpha + beta")), await text(source("alpha+ beta")));
});

test("project macro arguments retain gaps through a definition in another header", async () => {
  const project = (argument) => ({
    "macros.h": "#define stringify(x) #x\n#define expand(x) stringify(x)\n",
    "main.cpp": `#include "macros.h"\nconst char* value(){return expand(${argument});}\n`,
  });
  assert.notEqual(
    (await canonicalizeProject(project("alpha + beta"))).sha256,
    (await canonicalizeProject(project("alpha+beta"))).sha256,
  );
});

test("ordinary function call layout still normalizes in a project with macros", async () => {
  const source = (call) =>
    `#define stringify(x) #x\nint sum(int a,int b){return a+b;}\nint value(){return ${call};}\n`;
  assert.equal(await text(source("sum(1 + 2, 3)")), await text(source("sum ( 1+2 ,3 )")));
  const literal = 'const char* note = R"x(\n#define sum(x) #x\n)x";\n';
  assert.equal(
    await text(literal + "int f(){return sum(1+2);}"),
    await text(literal + "int f(){return sum(1 + 2);}"),
  );
});
test("canonical C++ keeps opaque macro tokens, literals and maximal-munch operators", async () => {
  // A replacement list can later be expanded into a stringifying macro argument.
  assert.notEqual(await text("#define VALUE ( 1 + 2 )\n"), await text("#define VALUE (1+2)\n"));
  assert.notEqual(await text("#define VALUE (a + + b)\n"), await text("#define VALUE (a ++ b)\n"));
  assert.notEqual(await text("#define VALUE (1e+2)\n"), await text("#define VALUE (1e +2)\n"));
  assert.notEqual(await text("#define VALUE (0xFF)\n"), await text("#define VALUE (0 xFF)\n"));
  assert.notEqual(
    await text("#define VALUE (1'000'123)\n"),
    await text("#define VALUE (1 '000' 123)\n"),
  );
  assert.notEqual(await text('#define VALUE "a  b"\n'), await text('#define VALUE "a b"\n'));
  assert.notEqual(await text("#define VALUE (1)\n"), await text("#define VALUE (2)\n"));
});

test("canonical C++ records malformed source without repairing it", async () => {
  const source = "int f( { return 7; } ???";
  const result = await canonicalizeCpp(source);
  assert.ok(result.errors.length > 0);
  assert.notEqual(result.text, await text("int f(){return 7;}"));
  assert.notEqual(result.text, await text(source.replace("7", "8")));
  assert.equal(source, "int f( { return 7; } ???");
  assert.deepEqual(result, await canonicalizeCpp(source));
});

test("canonical snapshots preserve malformed UTF-8 as distinct original bytes", async () => {
  const source = decodeSourceBytes(Buffer.from([0x69, 0x6e, 0x74, 0x20, 0x80, 0x3b]));
  const different = decodeSourceBytes(Buffer.from([0x69, 0x6e, 0x74, 0x20, 0x81, 0x3b]));
  const a = await canonicalizeCpp(source),
    b = await canonicalizeCpp(different);
  assert.ok(a.errors.some((row) => row.kind === "encoding"));
  assert.notEqual(a.text, b.text);
});

test("canonical project snapshots retain file identity, unknown contents and stable parser identity", async () => {
  const input = {
    "src/b.h": "int z(){return 1;}",
    "src/a.cpp": "int a(){return 2;}",
    "CMakeLists.txt": "set(VALUE 1)\n",
  };
  const copy = structuredClone(input),
    first = await canonicalizeProject(input);
  const second = await canonicalizeProject(Object.fromEntries(Object.entries(input).reverse()));
  assert.deepEqual(first, second);
  assert.deepEqual(input, copy);
  assert.deepEqual(Object.keys(first.files), ["CMakeLists.txt", "src/a.cpp", "src/b.h"]);
  assert.equal(first.canonicalizer.parser.version, "0.27.1");
  assert.equal(first.canonicalizer.grammar.version, "0.23.4");
  assert.match(first.canonicalizer.grammar.sha256, /^[0-9a-f]{64}$/);
  assert.notDeepEqual(
    first,
    await canonicalizeProject({ ...input, "CMakeLists.txt": "set(VALUE 2)\n" }),
  );
  assert.notDeepEqual(first, await canonicalizeProject({ ...input, "empty.h": "" }));
  assert.notDeepEqual(
    await canonicalizeProject({ "a.h": "int f(){return 1;}" }),
    await canonicalizeProject({ "b.h": "int f(){return 1;}" }),
  );
});

test("canonical snapshot rejects ambiguous or unsafe paths and unsupported input values", async () => {
  for (const file of ["/tmp/a.h", "../a.h", "a/../a.h", "a//b.h", "a\\b.h", ".", ""]) {
    await assert.rejects(canonicalizeProject({ [file]: "int value;" }), { name: "TypeError" });
  }
  await assert.rejects(canonicalizeProject({ "a.h": 42 }), { name: "TypeError" });
});
