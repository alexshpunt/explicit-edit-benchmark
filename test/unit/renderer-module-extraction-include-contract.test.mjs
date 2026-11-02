import test from "node:test";
import assert from "node:assert/strict";
import {
  includeContract,
  includeContractProse,
} from "../../src/suites/explicit-edit-multi-agent/extraction/include-contract.mjs";

test("include requirements retain ordered system and project includes and duplicates", () => {
  const contract = includeContract({
    destination: `#pragma once
#include <array>
#include "project.h"
#include <array>
int hidden_body() { return 1234567; }
`,
  });
  assert.deepEqual(
    contract.map(({ directive, context }) => ({ directive, context })),
    [
      { directive: "#include <array>", context: [] },
      { directive: '#include "project.h"', context: [] },
      { directive: "#include <array>", context: [] },
    ],
  );
  const prose = includeContractProse(contract);
  assert.ok(prose.includes("#include <array>"));
  assert.ok(prose.includes('#include "project.h"'));
  assert.ok(!prose.includes("hidden_body"));
  assert.ok(!prose.includes("1234567"));
});

test("include requirements identify complete nested branch context", () => {
  const contract = includeContract({
    destination: `#if FIRST
#include <first>
#elif SECOND
#if THIRD
#include "nested.h"
#else
#include <fallback>
#endif
#else
#include <last>
#endif
`,
  });
  assert.deepEqual(
    contract.map(({ directive, context }) => ({ directive, context })),
    [
      { directive: "#include <first>", context: [["#if FIRST"]] },
      { directive: '#include "nested.h"', context: [["#if FIRST", "#elif SECOND"], ["#if THIRD"]] },
      {
        directive: "#include <fallback>",
        context: [
          ["#if FIRST", "#elif SECOND"],
          ["#if THIRD", "#else"],
        ],
      },
      { directive: "#include <last>", context: [["#if FIRST", "#elif SECOND", "#else"]] },
    ],
  );
});

test("same condition text in distinct blocks remains distinguishable", () => {
  const contract = includeContract({
    destination: `#if FLAG
#include <one>
#include <two>
#endif
#if FLAG
#include <three>
#endif
`,
  });
  assert.deepEqual(
    contract.map(({ groups }) => groups),
    [[1], [1], [2]],
  );
});

test("comments, literals, and continued macros cannot introduce phantom includes", () => {
  const contract = includeContract({
    destination: `/*
#include <not-comment>
*/
const char* x = R"tag(
#include <not-string>
)tag";
#define WRAPPED(x) \\
#include <not-macro>
#include <real> // comment
`,
  });
  assert.deepEqual(
    contract.map(({ directive }) => directive),
    ["#include <real>"],
  );
});

test("include requirements do not disclose directives inside a function body", () => {
  assert.throws(() =>
    includeContract({ destination: "void run() {\n#include <private-in-body>\n}\n" }),
  );

  assert.throws(() =>
    includeContract({
      destination: "void run() {\n#if FLAG\n}\n#endif\n#include <private-in-branch>\n}\n",
    }),
  );
});

test("alternate braces and spliced line comments are rejected instead of exposing body text", () => {
  assert.throws(() => includeContract({ destination: "void run() <%\n#include <private>\n%>\n" }));
  assert.throws(() => includeContract({ destination: "// comment \\\n#include <private>\n" }));
});

test("unsupported includes and malformed conditional nesting fail closed", () => {
  assert.throws(() => includeContract({ destination: "#include SOME_MACRO\n" }));
  assert.throws(() => includeContract({ destination: "#if ONE\n#include <x>\n" }));
  assert.throws(() => includeContract({ destination: "#else\n#include <x>\n" }));
  assert.throws(() => includeContract({ destination: "#if A\n#else\n#elif B\n#endif\n" }));
});
