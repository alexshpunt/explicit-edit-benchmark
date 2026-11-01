import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  measureExtractionCandidate,
  measureCoherentCandidate,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";

const program = `#include <fstream>
#include <string>
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  std::ofstream marker(std::string(argv[1]) + ".invocation");
  marker << 1;
  for (int variant = 0; variant < 2; variant++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++)
      pixels[i] = i % 4 == 3 ? 1 : (i % 7) + variant;
    std::ofstream image(std::string(argv[1]) + "-" + std::to_string(variant) + ".rgba32f", std::ios::binary);
    image.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`;
const expectedPixels = [0, 1].map((variant) => {
  const pixels = Buffer.alloc(32 * 32 * 4 * 4);
  for (let index = 0; index < 32 * 32 * 4; index++)
    pixels.writeFloatLE(index % 4 === 3 ? 1 : (index % 7) + variant, index * 4);
  return createHash("sha256").update(pixels).digest("hex");
});

test("extraction compiles once and renders once while the old verifier retains its repeat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "module-extraction-build-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "main.cpp"), program);
    const tree = { "main.cpp": program };
    const single = path.join(root, "single");
    const result = await measureExtractionCandidate(source, single, tree, {
      expectedPixels,
      completeInventory: true,
    });
    assert.equal(result.buildPassed, true);
    assert.equal(result.resultMatched, true);
    assert.deepEqual(result.pixels, expectedPixels);
    assert.equal(await readFile(path.join(single, "scene/scene.invocation"), "utf8"), "1");
    assert.equal((await readdir(single)).includes("repeat"), false);
    const previous = path.join(root, "previous");
    const old = await measureCoherentCandidate(source, previous, tree, { expectedPixels });
    assert.equal(old.resultMatched, true);
    assert.equal(await readFile(path.join(previous, "scene/scene.invocation"), "utf8"), "1");
    assert.equal(await readFile(path.join(previous, "repeat/repeat.invocation"), "utf8"), "1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed extraction compilation never starts a renderer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "module-extraction-failed-build-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    const broken = "int main() { return missing_identifier; }\n";
    await writeFile(path.join(source, "main.cpp"), broken);
    const evidence = path.join(root, "integration");
    const result = await measureExtractionCandidate(
      source,
      evidence,
      { "main.cpp": broken },
      { expectedPixels, completeInventory: true },
    );
    assert.equal(result.buildPassed, false);
    assert.equal(result.resultMatched, false);
    assert.ok(result.failure);
    const entries = await readdir(evidence);
    assert.equal(entries.includes("scene"), false);
    assert.equal(entries.includes("repeat"), false);
    assert.ok((await readFile(path.join(evidence, "compile.log"), "utf8")).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
