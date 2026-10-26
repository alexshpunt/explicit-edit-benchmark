import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

const source = `#define SCALE(x) ((x) + 7)
namespace sample {
struct Restored {};
struct Peer {};
struct Other {};
int inspect(Restored value) { return SCALE(1); }
int inspect(Peer value) { const char* text = "protected"; return 2; }
}
#if MODE
namespace sample { int inactive(int value) { return value + 4; } }
#else
namespace sample { int active() { return 3; } }
#endif
`;
const initial = { "main.cpp": source };
const contract = prepareCoherentContract(initial);

test("barriers accept reopened namespaces and reordered complete overloads", () => {
  const reordered = source.replace(
    'int inspect(Restored value) { return SCALE(1); }\nint inspect(Peer value) { const char* text = "protected"; return 2; }',
    '}\nnamespace sample { int inspect(Peer value) { const char* text = "protected"; return 2; } }\nnamespace sample { int inspect(Restored value) { return SCALE(1); }',
  );
  assert.equal(evaluateCoherentContract({ "main.cpp": reordered }, contract).status, "pass");
});

test("barriers retain peer types, bodies, literals, macro syntax and inactive branches", () => {
  const mutations = [
    source.replace("inspect(Peer value)", "inspect(Other value)"),
    source.replace("return 2", "return 5"),
    source.replace('"protected"', '"changed"'),
    source.replace("#define SCALE(x)", "#define SCALE (x)"),
    source.replace("((x) + 7)", "((x) + 9)"),
    source.replace("return value + 4", "return value + 8"),
    source.replace("#if MODE", "#if OTHER_MODE"),
    source.replace("int inspect(Restored value) { return SCALE(1); }\n", ""),
    source + "namespace sample { int inspect(Restored value) { return SCALE(1); } }\n",
    source.replaceAll("Restored", "Mistaken"),
  ];
  for (const changed of mutations)
    assert.equal(evaluateCoherentContract({ "main.cpp": changed }, contract).status, "fail");
  assert.equal(
    evaluateCoherentContract({ ...initial, "extra.h": "int added;\n" }, contract).status,
    "fail",
  );
});

test("barriers reject a partial rename or changed peer in any duplicate declaration", () => {
  const complete = {
    "api.h":
      "namespace sample { struct Restored {}; int inspect(Restored); int inspect(Restored); }\n",
  };
  const expected = prepareCoherentContract(complete);
  for (const source of [
    complete["api.h"].replace("int inspect(Restored);", "int inspect(Mistaken);"),
    complete["api.h"].replace("int inspect(Restored);", ""),
    complete["api.h"].replace(
      "int inspect(Restored);",
      "int inspect(Restored); int inspect(Restored);",
    ),
  ])
    assert.equal(evaluateCoherentContract({ "api.h": source }, expected).status, "fail");
});
