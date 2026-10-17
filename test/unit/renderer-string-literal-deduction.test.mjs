import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectAst } from "../../src/suites/explicit-edit-multi-agent/cpp/compiler-ast.mjs";
import { semanticSession } from "../../src/suites/explicit-edit-multi-agent/cpp/clangd-renames.mjs";
import { createTemplateCallWitness } from "../../src/suites/explicit-edit-multi-agent/cpp/template-call-witness.mjs";

const setup = `namespace frond {
template<class T, int N> struct Array {};
template<class T> struct List {};
template<class T, int N> bool pick(const Array<char, N>&, List<T>&);
template<class T> bool pick(const char*, List<T>&);
`;
const caller = `template<class U> bool use(List<U>& output) { return pick("radius", output); }
} int main() {}
`;

async function fixture(source, run, flags = ["-std=c++17"]) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/string-literal-deduction-"));
  const file = path.join(directory, "main.cpp");
  await writeFile(file, source);
  let compiler;
  try {
    const roots = await projectAst(file, flags);
    compiler = await semanticSession(file, source, flags);
    const nodes = new Map();
    const calls = [];
    function visit(node) {
      if (node.id && (!nodes.has(node.id) || node.inner)) nodes.set(node.id, node);
      if (node.kind === "CallExpr" && node.inner?.[0]?.kind === "UnresolvedLookupExpr")
        calls.push(node);
      for (const child of node.inner ?? []) visit(child);
    }
    roots.forEach(visit);
    const groups = new Map();
    for (const node of nodes.values()) {
      if (node.kind !== "FunctionTemplateDecl" || node.name !== "pick") continue;
      let first = node;
      while (first.previousDecl) first = nodes.get(first.previousDecl);
      if (!groups.has(first.id)) groups.set(first.id, []);
      groups
        .get(first.id)
        .push(...(node.inner ?? []).filter((child) => child.kind === "FunctionDecl"));
    }
    const families = [...groups.values()];
    const selected = families.find((family) =>
      /(?:Array|array|Identity)</.test(family[0].type.qualType),
    );
    assert.ok(selected);
    assert.ok(calls.length > 0);
    const witness = createTemplateCallWitness(roots, source, {
      ast: (range) => compiler.ast(range),
      symbols: (position) => compiler.symbols(position),
    });
    await run({ witness, selected, families, calls, roots });
  } finally {
    compiler?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectWitness(source, expected, flags) {
  await fixture(
    source,
    async ({ witness, selected, families, calls }) => {
      for (const call of calls)
        assert.equal(
          await witness({ selectedFunctions: selected, candidateFamilies: families, call }),
          expected,
        );
    },
    flags,
  );
}

test("a narrow string literal cannot deduce a dependent primary-class reference", async () => {
  await expectWitness(setup + caller, true);
  await expectWitness(setup.replace("const Array<char, N>&", "Array<char, N>&") + caller, true);
  await expectWitness(
    setup
      .replaceAll("template<class T, int N>", "template<class T>")
      .replace("const Array<char, N>&", "const Array<T>&") + caller,
    true,
  );
});

test("a class-reference mismatch at an earlier argument does not need concrete remaining arguments", async () => {
  const source = `namespace frond {
template<class T, int N> struct Array {};
template<class T, int N> bool pick(T, const Array<char, N>&);
template<class T> bool pick(T, const char*);
template<class U> bool use(U value) { return pick(value, "radius"); }
} int main() {}
`;
  await expectWitness(source, true);
});

test("standard array string names cannot be deduced from a string-literal property", async () => {
  const source = `#include <array>
#include <string>
#include <vector>
namespace frond {
using std::array; using std::string; using std::vector;
struct Model {};
template<class T, size_t N> bool pick(const Model&, const string&, const array<string, N>&, vector<array<T, N>>&);
template<class T> bool pick(const Model&, const string&, const string&, vector<T>&);
template<class U> bool use(const Model& model, vector<U>& output) { return pick(model, "vertex", "radius", output); }
} int main() {}
`;
  await expectWitness(source, true);
});

test("a concrete class parameter may use conversions and is not a deduction mismatch", async () => {
  const source = setup
    .replace("struct Array {};", "struct Array { Array(const char*); };")
    .replace("template<class T, int N> bool pick", "template<class T> bool pick")
    .replace("const Array<char, N>&", "const Array<char, 4>&");
  await expectWitness(source + caller, false);
});

test("aliases and non-deduced type contexts do not establish a primary-class pattern", async () => {
  await expectWitness(
    setup.replace(
      "template<class T, int N> struct Array {};",
      "template<class T, int N> using Array = T[N];",
    ) + caller,
    false,
  );
  await expectWitness(
    setup
      .replace(
        "template<class T> struct List {};",
        "template<class T> struct List {}; template<class T> struct Identity { using type = T; };",
      )
      .replace("const Array<char, N>&", "const typename Identity<Array<char, N>>::type&") + caller,
    false,
  );
});

test("explicit or qualified calls and macro or nonliteral arguments remain conservative", async () => {
  for (const input of [
    setup + caller.replace('pick("radius", output)', 'pick<U, 7>("radius", output)'),
    setup + caller.replace('pick("radius", output)', 'frond::pick("radius", output)'),
    setup + '#define PROPERTY "radius"\n' + caller.replace('"radius"', "PROPERTY"),
    setup +
      "#define PICK pick\n" +
      caller.replace('pick("radius", output)', 'PICK("radius", output)'),
    setup +
      caller
        .replace("List<U>& output", "List<U>& output, const char (&property)[7]")
        .replace('"radius"', "property"),
    setup.replace(
      "template<class T> bool pick(const char*, List<T>&);",
      "template<class S, class T> bool pick(const S*, List<T>&);",
    ) + caller.replace('"radius"', 'L"radius"'),
  ])
    await expectWitness(input, false);
});

test("defaults, template packs and viability attributes keep unsupported families unchanged", async () => {
  for (const declaration of [
    "template<class T, int N = 4> bool pick(const Array<char, N>&, List<T>&);",
    "template<class T, int N, class... Extra> bool pick(const Array<char, N>&, List<T>&);",
    'template<class T, int N> bool pick(const Array<char, N>&, List<T>&) __attribute__((enable_if(false, "disabled")));',
  ])
    await expectWitness(
      setup.replace(
        "template<class T, int N> bool pick(const Array<char, N>&, List<T>&);",
        declaration,
      ) + caller,
      false,
    );
});

test("missing or contradictory literal metadata cannot establish the deduction proof", async () => {
  await fixture(setup + caller, async ({ witness, selected, families, calls }) => {
    for (const change of [
      (call) => {
        call.inner[1] = null;
      },
      (call) => {
        delete call.inner[1].type;
      },
      (call) => {
        call.inner[1].valueCategory = "prvalue";
      },
      (call) => {
        call.inner[1].type.qualType = "const char *";
      },
      (call) => {
        call.inner[1].range.begin.offset = -1;
      },
    ]) {
      const call = structuredClone(calls[0]);
      change(call);
      assert.equal(
        await witness({ selectedFunctions: selected, candidateFamilies: families, call }),
        false,
      );
    }
  });
});

test("byte and UTF-16 offsets remain distinct before a literal deduction proof", async () => {
  await expectWitness("// 🐚\n" + setup + caller, true);
});
