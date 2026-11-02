import assert from "node:assert/strict";
import test from "node:test";
import {
  preambleContract,
  preambleContractProse,
} from "../../src/suites/explicit-edit-multi-agent/extraction/preamble-contract.mjs";

test("preamble inventory keeps directive barriers and branch ordering without macro payloads", () => {
  const source =
    '#pragma once\n#include <vector>\n#ifdef FLAG\n#define VALUE SECRET_PAYLOAD\n#else\n#include "other.h"\n#endif\n#include "last.h"\n';
  const items = preambleContract(source);
  assert.deepEqual(items, [
    { kind: "pragma-once" },
    { kind: "include", name: "<vector>" },
    { kind: "conditional", head: "#ifdef FLAG" },
    { kind: "macro", name: "VALUE" },
    { kind: "branch", head: "#else" },
    { kind: "include", name: '"other.h"' },
    { kind: "end-conditional" },
    { kind: "include", name: '"last.h"' },
  ]);
  const prose = preambleContractProse(items);
  assert.match(prose, /VALUE/);
  assert.doesNotMatch(prose, /SECRET_PAYLOAD|```/);
});

test("preamble inventory refuses indistinguishable macros with different private payloads", () => {
  assert.throws(() => preambleContract("#define A 1\n#define A 2\n"));
  assert.doesNotThrow(() => preambleContract("#if X\n#define A 1\n#else\n#define A 2\n#endif\n"));
});

test("preamble ambiguity is accepted only with verified anchors for the macro", () => {
  const source = "#define A 1\n#define A 2\n";
  assert.throws(() => preambleContract(source, { anchoredMacros: new Set(["B"]) }));
  assert.deepEqual(preambleContract(source, { anchoredMacros: new Set(["A"]) }), [
    { kind: "macro", name: "A" },
    { kind: "macro", name: "A" },
  ]);
});

test("raw string contents cannot become public directives", () => {
  const source = '#define MESSAGE R"(first\n#define PRIVATE_LITERAL )"\n';
  assert.throws(() => preambleContract(source));
});

test("macro splice removal cannot hide different replacement tokens", () => {
  assert.throws(() => preambleContract("#define X a\\\nb\n#define X a b\n"));
});

test("preamble inventory fails closed on unsupported syntax and unbalanced branches", () => {
  for (const source of [
    "int x;\n",
    "#include HEADER\n",
    "#pragma pack(1)\n",
    "#error secret\n",
    "#if X\n",
    "#else\n",
    "#define X(a,b 1\n",
    "#if X\n#else\n#else\n#endif\n",
  ]) {
    assert.throws(() => preambleContract(source), source);
  }
});

test("preamble inventory supports continuations, comments, undef, and function macro signatures", () => {
  const items = preambleContract(
    "/* private comment */\n#define F(x, y) ((x) + \\\n(y))\n#undef F\n",
  );
  assert.deepEqual(items, [
    { kind: "macro", name: "F(x, y)" },
    { kind: "undef", name: "F" },
  ]);
  assert.doesNotMatch(preambleContractProse(items), /private comment|\(\(x\)/);
});
