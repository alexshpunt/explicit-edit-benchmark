import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import {
  prepareBarrierSymbolMap,
  evaluateBarrierSymbolMap,
} from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-overload-barrier-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let index = 0;
  return () => ({ evidence: path.join(directory, String(index++)) });
}

const initial = {
  "main.cpp":
    "namespace sample {\nstruct Restored {};\nstruct Peer {};\nstruct Other {};\nvoid inspect(Restored value) {}\nvoid inspect(Peer value) {}\n}\n",
};
const reordered = {
  "main.cpp":
    "namespace sample { struct Restored {}; struct Peer {}; struct Other {}; }\nnamespace sample { void inspect(Peer value) {} }\nnamespace sample { void inspect(Restored value) {} }\n",
};

test("known type bindings survive valid reopened namespaces and reordered overloads at a barrier", async (t) => {
  const options = await fixture(t);
  const expected = await prepareBarrierSymbolMap(initial, options());
  assert.equal(
    evaluateCoherentContract(reordered, prepareCoherentContract(initial)).status,
    "pass",
  );
  assert.equal((await evaluateBarrierSymbolMap(reordered, expected, options())).status, "pass");
});

test("a barrier rejects an all-consistent wrong type spelling", async (t) => {
  const options = await fixture(t);
  const expected = await prepareBarrierSymbolMap(initial, options());
  const mistaken = { "main.cpp": reordered["main.cpp"].replaceAll("Restored", "Mistaken") };
  assert.equal((await evaluateBarrierSymbolMap(mistaken, expected, options())).status, "fail");
});

test("relocated overloads retain protected peer bindings, bodies and copy counts at a barrier", async (t) => {
  const options = await fixture(t);
  const expected = await prepareBarrierSymbolMap(initial, options());
  const contract = prepareCoherentContract(initial);
  for (const source of [
    reordered["main.cpp"].replace("inspect(Peer value)", "inspect(Other value)"),
    reordered["main.cpp"].replace(
      "inspect(Peer value) {}",
      "inspect(Peer value) { int changed = 1; (void)changed; }",
    ),
    reordered["main.cpp"].replace("namespace sample { void inspect(Peer value) {} }\n", ""),
  ]) {
    const damaged = { "main.cpp": source };
    assert.equal(evaluateCoherentContract(damaged, contract).status, "fail");
    assert.equal((await evaluateBarrierSymbolMap(damaged, expected, options())).status, "fail");
  }
});
