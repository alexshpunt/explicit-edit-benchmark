import assert from "node:assert/strict";
import test from "node:test";
import {
  sortedExtractionCpp,
  sortedExtractionProject,
} from "../../src/suites/explicit-edit-multi-agent/extraction/sorted-structure.mjs";

const compare = async (left, right) =>
  assert.equal(await sortedExtractionCpp(left), await sortedExtractionCpp(right));
const distinct = async (left, right) =>
  assert.notEqual(await sortedExtractionCpp(left), await sortedExtractionCpp(right));

test("include placement and peer ordering are not structural differences", async () => {
  await compare(
    '#include "x.h"\nnamespace N { using std::array; }\n#include "y.h"\n',
    'namespace N { using std::array; }\n#include "y.h"\n#include "x.h"\n',
  );
  await compare(
    'namespace N { int f(){return 1;} }\n#include "x.h"\nnamespace N { int g(){return 2;} }\n',
    '#include "x.h"\nnamespace N { int g(){return 2;} int f(){return 1;} }\n',
  );
  await compare("namespace N {}\nnamespace A { namespace B {} }\nint x;\n", "int x;\n");
  await compare("namespace N {}", "");
});

test("include identity, multiplicity, scope, and branch remain significant", async () => {
  await distinct('#include "x.h"\n', '#include "y.h"\n');
  await distinct('#include "x.h"\n', '#include "x.h"\n#include "x.h"\n');
  await distinct('#include "x.h"\n', 'namespace N {\n#include "x.h"\n}\n');
  await distinct(
    '#if X\n#include "x.h"\n#else\n#include "y.h"\n#endif\n',
    '#if X\n#include "y.h"\n#else\n#include "x.h"\n#endif\n',
  );
  await distinct('#if X\n#include "x.h"\n#endif\n', '#if Y\n#include "x.h"\n#endif\n');
  await compare(
    '#if X\n#include "x.h"\n#include "y.h"\n#endif\n',
    '#if X\n#include "y.h"\n#include "x.h"\n#endif\n',
  );
});

test("nested branches and duplicate complete units remain distinct", async () => {
  await compare(
    "#if A\n#if B\nint x;\nint y;\n#elif C\nint z;\n#else\nint w;\n#endif\n#endif\n",
    "#if A\n#if B\nint y;\nint x;\n#elif C\nint z;\n#else\nint w;\n#endif\n#endif\n",
  );
  await distinct(
    "#if A\n#if B\nint x;\n#elif C\nint z;\n#else\nint w;\n#endif\n#endif\n",
    "#if A\n#if B\nint z;\n#elif C\nint x;\n#else\nint w;\n#endif\n#endif\n",
  );
  await distinct("namespace N { int x; int x; }", "namespace N { int x; }");
  await distinct("namespace N { using std::pair; }", "using std::pair; namespace N {}");
});

test("definitions, namespace kinds, macros and non-C++ files stay protected", async () => {
  await distinct("namespace N { int f(){return 1;} }", "namespace N { int f(){return 2;} }");
  await distinct("struct X { int a; int b; };", "struct X { int b; int a; };");
  await distinct("namespace N { int x; }", "inline namespace N { int x; }");
  await distinct("namespace N { int x; }", "namespace { int x; }");
  await distinct("#define X a + + b\n", "#define X a ++ b\n");
  const left = await sortedExtractionProject({ "main.cpp": "int main(){}", "asset.txt": "a" });
  const right = await sortedExtractionProject({ "main.cpp": "int main(){}", "asset.txt": "b" });
  assert.notEqual(left.files["asset.txt"], right.files["asset.txt"]);
  assert.notDeepEqual(
    Object.keys(left.files),
    Object.keys((await sortedExtractionProject({ "main.cpp": "int main(){}" })).files),
  );
});
