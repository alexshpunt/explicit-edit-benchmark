import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  prepareBarrierSymbolMap,
  evaluateBarrierSymbolMap,
} from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-anonymous-local-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let index = 0;
  return () => ({ evidence: path.join(directory, String(index++)) });
}

const sample = `inline float sample(unsigned input) {
  union {
    unsigned bits;
    float value;
  } local;
  local.bits = input;
  return local.value;
}
`;
const other = "inline int other(int input) { return input + 1; }\n";
const tree = (header) => ({ "api.h": header, "main.cpp": '#include "api.h"\n' });

test("anonymous local constructors survive header line and column displacement", async (t) => {
  const options = await fixture(t);
  const expected = await prepareBarrierSymbolMap(tree(sample + other), options());
  for (const header of [
    "\n" + sample + other,
    "/* extra header context\nwithout changing declarations */\n" + sample + other,
    other + sample.replace("  union {", "      union {"),
  ]) {
    const result = await evaluateBarrierSymbolMap(tree(header), expected, options());
    assert.equal(
      result.status,
      "pass",
      JSON.stringify(result.obligations.filter((x) => x.status === "fail")),
    );
  }
});

test("distinct anonymous local constructors keep distinct bindings after formatting", async (t) => {
  const options = await fixture(t);
  const source = `inline unsigned pair(unsigned input) {
  union { unsigned bits; float value; } first;
  union { unsigned bits; float value; } second;
  first.bits = input;
  second.bits = input + 1;
  return first.bits + second.bits;
}
`;
  const expected = await prepareBarrierSymbolMap(tree(source), options());
  const functionRecord = expected.symbols.find(
    (record) => record.definition && record.kind === "FUNCTION_DECL",
  );
  const constructors = functionRecord.references
    .map(([, binding]) => (binding.startsWith("local:") ? JSON.parse(binding.slice(6)) : null))
    .filter((binding) => binding?.[5] === "CONSTRUCTOR");
  assert.equal(constructors.length, 2);
  assert.equal(new Set(constructors.map((binding) => JSON.stringify(binding))).size, 2);
  const result = await evaluateBarrierSymbolMap(tree("\n\n" + source), expected, options());
  assert.equal(result.status, "pass");
});

test("anonymous local constructor stability still rejects changed bodies and signatures", async (t) => {
  const options = await fixture(t);
  const expected = await prepareBarrierSymbolMap(tree(sample), options());
  for (const header of [
    sample.replace("local.bits = input;", "local.bits = input + 1;"),
    sample.replace("unsigned input)", "unsigned input, unsigned extra)"),
  ]) {
    const result = await evaluateBarrierSymbolMap(tree(header), expected, options());
    assert.equal(result.status, "fail");
    assert.ok(result.obligations.some((x) => x.status === "fail" && x.kind === "symbol"));
  }
});
