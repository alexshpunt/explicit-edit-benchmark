import assert from "node:assert/strict";
import test from "node:test";
import { vendorSymbolSpecifications } from "../../src/suites/explicit-edit-multi-agent/extraction/symbol-vendor.mjs";

test("vendor inventory retains original API signatures without function bodies or initializer values", async () => {
  const task = {
    kind: "vendor-header",
    fragments: [
      {
        text: `#define STBIRDEF extern
#define stbir__inline inline
STBIRDEF int render(int width, const float *values);
typedef struct { int x; } RenderOptions;
static stbir__inline int clamp(int x) { return x + 219876; }
static int lookup[] = { 34567, 98765 };
`,
      },
    ],
  };
  const out = await vendorSymbolSpecifications(task);
  assert.ok(
    out.some(
      (x) =>
        x.kind === "function-declaration" &&
        x.signature === "STBIRDEF int render(int width, const float *values)",
    ),
  );
  assert.ok(
    out.some(
      (x) =>
        x.kind === "function-definition" && x.signature === "static stbir__inline int clamp(int x)",
    ),
  );
  assert.ok(out.some((x) => x.kind === "typedef" && x.signature === "RenderOptions"));
  assert.ok(out.some((x) => x.kind === "variable" && x.signature === "static int lookup[]"));
  const data = JSON.stringify(out);
  assert.ok(out.some((x) => x.signature === "RenderOptions" && x.members?.includes("int x;")));
  for (const forbidden of ["219876", "34567", "98765", "return x"])
    assert.ok(!data.includes(forbidden));
});

test("equivalent repeated vendor declarations retain multiplicity without source-order hints", async () => {
  const task = {
    kind: "vendor-header",
    fragments: [{ text: "STBIRDEF int f(int x);\n" }, { text: "STBIRDEF int f(int x);\n" }],
  };
  const out = await vendorSymbolSpecifications(task);
  assert.deepEqual(out, [
    { scope: "", kind: "function-declaration", signature: "STBIRDEF int f(int x)", count: 2 },
  ]);
});

test("identical vendor function signatures with distinct bodies are rejected", async () => {
  await assert.rejects(
    vendorSymbolSpecifications({
      kind: "vendor-header",
      fragments: [
        { text: "int f(int x) { return x; }\n" },
        { text: "int f(int x) { return x + 1; }\n" },
      ],
    }),
  );
});
test("vendor types with the same name are distinguished by exact field signatures", async () => {
  const out = await vendorSymbolSpecifications({
    kind: "vendor-header",
    fragments: [
      { text: "typedef struct { int a; } Render;\n" },
      { text: "typedef struct { int b; } Render;\n" },
    ],
  });
  assert.deepEqual(
    out.map(({ signature, members }) => ({ signature, members })),
    [
      { signature: "Render", members: ["int a;"] },
      { signature: "Render", members: ["int b;"] },
    ],
  );
});

test("multiple fields in one declaration retain their exact types", async () => {
  const out = await vendorSymbolSpecifications({
    kind: "vendor-header",
    fragments: [{ text: "typedef struct { int *a, b; } Render;\n" }],
  });
  assert.deepEqual(out[0].members, ["int *a;", "int b;"]);
});

test("vendor types with identical identities but different initializers are rejected", async () => {
  await assert.rejects(
    vendorSymbolSpecifications({
      kind: "vendor-header",
      fragments: [
        { text: "typedef struct { int a = 1; } Render;\n" },
        { text: "typedef struct { int a = 2; } Render;\n" },
      ],
    }),
  );
});

test("same vendor variable identity with different initializers is ambiguous", async () => {
  await assert.rejects(
    vendorSymbolSpecifications({
      kind: "vendor-header",
      fragments: [{ text: "static int item = 1;\n" }, { text: "static int item = 2;\n" }],
    }),
  );
});

test("vendor inventory is independent of fragment traversal order", async () => {
  const a = { text: "STBIRDEF int z(int x);\n" },
    b = { text: "STBIRDEF int a(int x);\n" };
  assert.deepEqual(
    await vendorSymbolSpecifications({ kind: "vendor-header", fragments: [a, b] }),
    await vendorSymbolSpecifications({ kind: "vendor-header", fragments: [b, a] }),
  );
});

test("non-ASCII source before a signature preserves the exact public signature", async () => {
  const out = await vendorSymbolSpecifications({
    kind: "vendor-header",
    fragments: [{ text: "// 🦉 café\nSTBIRDEF int shown(int input);\n" }],
  });
  assert.equal(out[0].signature, "STBIRDEF int shown(int input)");
});
test("vendor qualifiers in raw string literals do not change parsing", async () => {
  const literal = 'R"STBIRDEF(text)STBIRDEF"';
  const out = await vendorSymbolSpecifications({
    kind: "vendor-header",
    fragments: [{ text: `const char* label(const char* s = ${literal});\n` }],
  });
  assert.equal(out[0].signature, `const char* label(const char* s = ${literal})`);
});

test("function signatures with embedded bodies fail closed", async () => {
  await assert.rejects(
    vendorSymbolSpecifications({
      kind: "vendor-header",
      fragments: [{ text: "int f(int x = [] { return 4; }());\n" }],
    }),
  );
});
test("unknown malformed top-level vendor syntax fails closed", async () => {
  await assert.rejects(
    vendorSymbolSpecifications({
      kind: "vendor-header",
      fragments: [{ text: "int f( { invalid }\n" }],
    }),
  );
});
