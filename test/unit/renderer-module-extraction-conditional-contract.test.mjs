import assert from "node:assert/strict";
import test from "node:test";
import { conditionalBlockContracts } from "../../src/suites/explicit-edit-multi-agent/extraction/conditional-contract.mjs";

const contract = (destination) => conditionalBlockContracts({ kind: "header", destination });

test("conditional branches bind public identities without exposing their bodies", async () => {
  const result = await contract(`namespace N {
#if defined(ONE)
int b(){return 731;}
int a(){return 873;}
#elif defined(TWO)
#define FEATURE 4
#else
int c();
#endif
}`);
  assert.deepEqual(result, [
    {
      scope: "N",
      branches: [
        {
          head: "#if defined(ONE)",
          entities: [
            { scope: "N", kind: "function-definition", signature: "int a()", count: 1 },
            { scope: "N", kind: "function-definition", signature: "int b()", count: 1 },
          ],
          blocks: [],
        },
        {
          head: "#elif defined(TWO)",
          entities: [{ scope: "N", kind: "macro", signature: "FEATURE", count: 1 }],
          blocks: [],
        },
        {
          head: "#else",
          entities: [{ scope: "N", kind: "function-declaration", signature: "int c()", count: 1 }],
          blocks: [],
        },
      ],
      count: 1,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /return|731|873/);
});

test("conditional prose describes branch membership without a destination template", async () => {
  const { conditionalContractsProse } =
    await import("../../src/suites/explicit-edit-multi-agent/extraction/conditional-contract.mjs");
  const blocks = await contract(`#if A\nint f(){ return 9831; }\n#else\nint g();\n#endif\n`);
  const prose = conditionalContractsProse(blocks);
  assert.match(prose, /#if A/);
  assert.match(prose, /int f\(\)/);
  assert.match(prose, /#else/);
  assert.doesNotMatch(prose, /9831|```|\{\s*return/);
});

test("conditional and include comments are not disclosed", async () => {
  const result = await contract(
    `#if ENABLED /* SECRET_ONE */\n#include <vector> /* SECRET_TWO */\n#endif\n`,
  );
  assert.doesNotMatch(JSON.stringify(result), /SECRET_ONE|SECRET_TWO/);
  assert.equal(result[0].branches[0].entities[0].signature, "#include <vector>");
});
test("identical blocks and identities have explicit multiplicity", async () => {
  const result = await contract(
    `#if A\nint f();\nint f();\n#endif\n#if A\nint f();\nint f();\n#endif\n`,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].count, 2);
  assert.equal(result[0].branches[0].entities[0].count, 2);
});

test("function bodies remain opaque even when they contain conditional directives", async () => {
  const result = await contract(
    `#if OUTER\nint f(){\n#if SECRET_IN_BODY\nreturn 409;\n#else\nreturn 500;\n#endif\n}\n#endif\n`,
  );
  assert.equal(result[0].branches[0].entities[0].signature, "int f()");
  assert.doesNotMatch(JSON.stringify(result), /SECRET_IN_BODY|409|500/);
});

test("equal names in separate branches retain their distinct branch associations", async () => {
  const result = await contract(`#if LEFT\n#define X 1\n#else\n#define X 2\n#endif\n`);
  assert.equal(result[0].branches.length, 2);
  assert.equal(result[0].branches[0].entities[0].signature, "X");
  assert.equal(result[0].branches[1].entities[0].signature, "X");
});
test("same conditional path and macro identity cannot hide different replacement text", async () => {
  await assert.rejects(contract(`#if A\n#define X 1\n#endif\n#if A\n#define X 2\n#endif\n`));
});

test("conditional macro payload ambiguity can be resolved by verified anchors", async () => {
  const destination = `#if A\n#define X 1\n#endif\n#if A\n#define X 2\n#endif\n`;
  await assert.rejects(
    conditionalBlockContracts({ kind: "header", destination }, { anchoredMacros: new Set(["Y"]) }),
  );
  const result = await conditionalBlockContracts(
    { kind: "header", destination },
    { anchoredMacros: new Set(["X"]) },
  );
  assert.equal(result[0].count, 2);
});

test("nested branches are grouped and invalid or opaque directives fail closed", async () => {
  const result = await contract(`#if A\n#if B\nint f();\n#endif\n#else\nint g();\n#endif\n`);
  assert.equal(result[0].branches[0].blocks[0].branches[0].head, "#if B");
  await assert.rejects(contract(`#if A\n#error private message\n#endif\n`));
  await assert.rejects(contract(`#if A\nint f();\n`));
});
