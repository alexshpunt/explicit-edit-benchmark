import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  buildCoherentCandidate,
  measureCoherentCandidate,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";

const source = `#include <fstream>
#include <string>
int main(int argc, char** argv) {
  for (int scene = 0; scene < 2; ++scene) {
    std::ofstream output(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    for (int index = 0; index < 32 * 32 * 4; ++index) {
      float value = (scene + index % 4 + 1) / 8.0f;
      output.write(reinterpret_cast<const char*>(&value), sizeof(value));
    }
  }
}
`;
const pixels = [0, 1].map((scene) => {
  const bytes = Buffer.alloc(32 * 32 * 4 * 4);
  for (let index = 0; index < bytes.length / 4; index++)
    bytes.writeFloatLE((scene + (index % 4) + 1) / 8, index * 4);
  return createHash("sha256").update(bytes).digest("hex");
});
async function fixture(t, program = source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-build-outcomes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tree = { "main.cpp": program };
  const candidate = path.join(directory, "source");
  await writeTree(candidate, tree);
  return { candidate, evidence: path.join(directory, "evidence"), tree };
}
const measure = ({ candidate, evidence, tree }, options = {}) =>
  measureCoherentCandidate(candidate, evidence, tree, { expectedPixels: pixels, ...options });

test("fresh build and both repeated output matches have separate affirmative evidence", async (t) => {
  const result = await measure(await fixture(t));
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, true);
  assert.deepEqual(result.pixels, pixels);
  assert.equal(result.failure, undefined);
});

test("candidate compiler errors give a failed build rather than infrastructure or missing evidence", async (t) => {
  const result = await measure(await fixture(t, source.replace("float value =", "float value ?")));
  assert.equal(result.buildPassed, false);
  assert.equal(result.resultMatched, false);
  assert.equal(result.failure.category, "build");
  assert.equal(typeof result.failure.cause.stderr, "string");
  assert.ok(result.failure.cause.stderr.length > 0);
});

test("successfully compiled wrong pixels retain successful build evidence", async (t) => {
  const result = await measure(await fixture(t, source.replace("/ 8.0f", "/ 4.0f")));
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, false);
  assert.equal(result.failure.category, "behavior");
  assert.notDeepEqual(result.pixels, pixels);
});

test("missing or invalid outputs cannot erase an already successful build", async (t) => {
  for (const program of [
    "int main() { return 0; }\n",
    "int main() { return 3; }\n",
    source.replace("/ 8.0f", "/ 0.0f"),
  ]) {
    const result = await measure(await fixture(t, program));
    assert.equal(result.buildPassed, true);
    assert.equal(result.resultMatched, false);
    assert.equal(result.failure.category, "behavior");
  }
});

test("a repeated-render mismatch retains the successful build", async (t) => {
  const program = source.replace(
    "(scene + index % 4 + 1)",
    '(scene + index % 4 + 1 + (std::string(argv[1]).find("repeat") != std::string::npos))',
  );
  const result = await measure(await fixture(t, program));
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, false);
  assert.equal(result.failure.category, "behavior");
});

test("external cancellation remains an exception, not candidate failure evidence", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const prepared = await fixture(t);
  await assert.rejects(() => measure(prepared, { signal: controller.signal }), {
    name: "AbortError",
  });
});

test("invalid trusted expected pixels are controller errors rather than candidate outcomes", async (t) => {
  const prepared = await fixture(t);
  for (const expectedPixels of [undefined, null, [], Array(2), ["bad", "bad"]])
    await assert.rejects(() => measure(prepared, { expectedPixels }), { name: "AssertionError" });
});

test("sandbox infrastructure failure is not converted to a failed candidate", async (t) => {
  const prepared = await fixture(t);
  prepared.candidate += "-missing";
  await assert.rejects(
    () => measure(prepared),
    (error) => error.category === "infrastructure",
  );
});

test("the original strict build API keeps its exact pixels return shape", async (t) => {
  const { candidate, evidence, tree } = await fixture(t);
  assert.deepEqual(await buildCoherentCandidate(candidate, evidence, tree), pixels);
});
