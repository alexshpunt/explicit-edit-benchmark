import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { runExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/run.mjs";
import {
  prepareExtractionReference,
  extractionReference,
} from "../../src/suites/explicit-edit-multi-agent/extraction/reference.mjs";

for (const count of [1, 10])
  test(`native reference extracts ${count} complete modules before one final real build and render`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "extraction-reference-"));
    try {
      const headers = Array.from({ length: count }, (_, index) => ({
        file: `module_${index}.h`,
        guard: `MODULE_${index}_H`,
        includes: index ? [`module_${index - 1}.h`] : [],
      }));
      // Nested original-header provenance; every task owns only its own envelope.
      let packed = "";
      for (let index = 0; index < count; index++)
        packed =
          `#ifndef MODULE_${index}_H\n#define MODULE_${index}_H\n` +
          packed +
          `inline int bad_${index}() { return ${index}; }\n#endif\n`;
      const expression = headers.map((_header, index) => `bad_${index}()`).join(" + ");
      const main = `#include <fstream>\n#include <string>\nint main(int argc, char** argv) {\nif (argc != 2) return 1;\nfor (int variant = 0; variant < 2; variant++) {\nfloat pixels[32 * 32 * 4];\nfor (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = i % 4 == 3 ? 1 : (i % 7) + variant + (${expression});\nstd::ofstream output(std::string(argv[1]) + "-" + std::to_string(variant) + ".rgba32f", std::ios::binary);\noutput.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));\n}\n}\n`;
      const plan = prepareHeaderExtraction({
        initial: { "main.cpp": packed + main },
        headers,
        modules: headers.map(({ file }) => file),
      });
      const expectedPixels = [0, 1].map((variant) => {
        const bytes = Buffer.alloc(32 * 32 * 4 * 4);
        for (let index = 0; index < 32 * 32 * 4; index++)
          bytes.writeFloatLE(
            index % 4 === 3 ? 1 : (index % 7) + variant + (count * (count - 1)) / 2,
            index * 4,
          );
        return createHash("sha256").update(bytes).digest("hex");
      });
      const tools = path.join(root, "tools");
      await prepareExtractionReference(tools);
      const output = path.join(root, "run");
      const result = await runExtraction(plan, output, {
        expectedPixels,
        createDriver: async (agent, _session, { signal }) =>
          extractionReference(path.join(output, "workspace"), tools, { agent, signal }),
        execute: (driver, task) => driver.execute(task),
      });
      assert.equal(result.status, "complete");
      assert.equal(result.participants.length, count);
      assert.equal(
        result.participants.every(({ closed }) => closed),
        true,
      );
      assert.equal(result.deliveries.length, count);
      assert.equal(result.extraction.status, "pass");
      assert.equal(result.integration.buildPassed, true);
      assert.equal(result.integration.resultMatched, true);
      assert.equal(
        await readFile(path.join(output, "workspace/main.cpp"), "utf8"),
        plan.expected["main.cpp"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
