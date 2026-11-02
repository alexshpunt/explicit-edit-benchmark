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

import { pairedExtractionFixture } from "../helpers/module-extraction-generation.mjs";
import { preparePairedExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/paired-plan.mjs";
import { extractCurrentFile } from "../../src/suites/explicit-edit-multi-agent/extraction/edit.mjs";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
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

test("extraction preserves external header macro context through real compilation and both scenes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "module-extraction-import-context-"));
  try {
    const headerA =
      '#ifndef A_H\n#define A_H\n#include "yocto_math.h"\nnamespace yocto {\n#ifdef assert\ninline int import_context() { return 0; }\n#else\ninline int import_context() { return 99; }\n#endif\nint operation_a();\n}\n#endif\n';
    const main =
      '#include <cassert>\n#include "yocto_a.h"\n#include "yocto_b.h"\n' +
      program.replace(
        "if (argc != 2)",
        "if (yocto::import_context() != 0) return 42;\n  if (argc != 2)",
      );
    const plan = preparePairedExtraction({
      ...pairedExtractionFixture({ main, headerA }),
      modules: ["frond_a", "frond_b"],
      agents: 2,
    });
    let extracted = { ...plan.initial };
    for (const task of plan.tasks) extracted = extractCurrentFile(extracted, task);
    assert.deepEqual(extracted, plan.expected);
    for (const [name, tree] of [
      ["initial", plan.initial],
      ["extracted", extracted],
    ]) {
      const source = path.join(root, name);
      await writeTree(source, tree);
      const result = await measureExtractionCandidate(
        source,
        path.join(root, name + "-evidence"),
        tree,
        { expectedPixels, completeInventory: true },
      );
      assert.equal(result.buildPassed, true);
      assert.equal(result.resultMatched, true);
      assert.deepEqual(result.pixels, expectedPixels);
    }
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
