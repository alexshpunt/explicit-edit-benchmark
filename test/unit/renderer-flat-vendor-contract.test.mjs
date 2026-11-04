import test from "node:test";
import assert from "node:assert/strict";
import { flatVendorContract } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-vendor-contract.mjs";
import { flatVendorInstructions } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-assignments.mjs";

test("flat vendor contracts expose directives and declarations without their payloads", async () => {
  const source = `#pragma once
#define SCALE(x) ((x) * 739421)
typedef struct { int value; } Thing;
int sample(Thing x);
`;
  const contract = await flatVendorContract(source, "header");
  assert.equal(contract.version, "flat-vendor-contract-v1");
  assert.deepEqual(contract.directives, [
    { kind: "pragma-once" },
    { kind: "macro", name: "SCALE(x)" },
  ]);
  assert.ok(
    contract.entities.some((entity) => entity.kind === "typedef" && entity.signature === "Thing"),
  );
  assert.ok(
    contract.entities.some(
      (entity) =>
        entity.kind === "function-declaration" && entity.signature === "int sample(Thing x)",
    ),
  );
  assert.ok(!JSON.stringify(contract).includes("739421"));
});

test("implementation inventory identifies function signatures but not function bodies", async () => {
  const source = `#include "vendor.h"
#define M(x) ((x) + 38751)
int sample(int x) {
#define INNER 93248
  return M(x) + INNER;
#undef INNER
}
`;
  const contract = await flatVendorContract(source, "implementation");
  assert.deepEqual(
    contract.directives.map(({ kind }) => kind),
    ["include", "macro", "macro", "undef"],
  );
  assert.deepEqual(contract.directives[2].inside, {
    kind: "function-definition",
    signature: "int sample(int x)",
  });
  assert.deepEqual(contract.directives[3].inside, contract.directives[2].inside);
  assert.equal(contract.directives[1].inside, undefined);
  assert.ok(
    contract.entities.some(
      (entity) => entity.kind === "function-definition" && entity.signature === "int sample(int x)",
    ),
  );
  assert.ok(!/38751|93248|return/.test(JSON.stringify(contract)));
  const prose = flatVendorInstructions(contract);
  assert.match(prose, /inside.*int sample\(int x\)/);
  assert.match(prose, /INNER/);
  assert.doesNotMatch(prose, /38751|93248|return/);
});

test("unsupported conditionals, ambiguous macro payloads, and unsupported roles fail closed", async () => {
  await assert.rejects(flatVendorContract("#if X\nint f();\n#endif\n", "header"));
  await assert.rejects(flatVendorContract("#define X 1\n#define X 2\n", "header"));
  await assert.rejects(flatVendorContract("int f();\n", "other"));
  await assert.rejects(flatVendorContract("int f() \\\n{ return 1; }\n", "implementation"));
});
