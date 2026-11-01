import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { runExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/run.mjs";
import { modelExtractionDrivers } from "../../src/suites/explicit-edit-multi-agent/extraction/case.mjs";
import { moduleExtractionPrompt } from "../../src/suites/explicit-edit-multi-agent/extraction/prompt.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_RUNTIME;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const padding of [0, 6000])
  test(
    `real Pi completes one whole-module assignment with ${padding} bytes of padding`,
    { skip: process.platform !== "linux" || !runtime, timeout: 60000 },
    async () => {
      await mkdir(path.resolve(".tmp"), { recursive: true });
      const root = await mkdtemp(path.resolve(".tmp/extraction-pi-"));
      let provider, drivers;
      try {
        const body = `#ifndef BODY_H\n#define BODY_H\n/*${"x".repeat(padding)}*/\ninline int bad_name() { return 3; }\n#endif\n`;
        const main = `#include <fstream>\n#include <string>\nint main(int argc, char** argv) {\nif (argc != 2) return 1;\nfor (int variant = 0; variant < 2; variant++) {\nfloat pixels[32 * 32 * 4];\nfor (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = i % 4 == 3 ? 1 : (i % 7) + variant + bad_name();\nstd::ofstream output(std::string(argv[1]) + "-" + std::to_string(variant) + ".rgba32f", std::ios::binary);\noutput.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));\n}\n}\n`;
        const plan = prepareHeaderExtraction({
          initial: { "main.cpp": body + main },
          headers: [{ file: "body.h", guard: "BODY_H", includes: [] }],
          modules: ["body.h"],
        });
        const assignment = moduleExtractionPrompt(plan.tasks[0]);
        const command = `python3 - <<'PY'\nfrom pathlib import Path\nimport hashlib\n${padding ? `assert hashlib.sha256(Path('/feedback/module.txt').read_bytes()).hexdigest() == '${hash(assignment)}'\n` : ""}p = Path('main.cpp')\ns = p.read_text()\na = s.index('#ifndef BODY_H\\n')\nb = s.index('#endif\\n', a) + len('#endif\\n')\nwith Path('body.h').open('x') as f: f.write(s[a:b])\np.write_text(s[:a] + '#include "body.h"\\n' + s[b:])\nPY`;
        provider = await providerFixture(root, (_request, number) =>
          number === 1 ? { command } : {},
        );
        const originalModels = await readFile(provider.config.modelsFile);
        const output = path.join(root, "run");
        drivers = modelExtractionDrivers(output, provider.config);
        const expectedPixels = [0, 1].map((variant) => {
          const bytes = Buffer.alloc(32 * 32 * 4 * 4);
          for (let i = 0; i < 32 * 32 * 4; i++)
            bytes.writeFloatLE(i % 4 === 3 ? 1 : (i % 7) + variant + 3, i * 4);
          return hash(bytes);
        });
        const result = await runExtraction(plan, output, { ...drivers, expectedPixels });
        await drivers.cleanup();
        assert.equal(result.status, "complete");
        assert.equal(result.extraction.status, "pass");
        assert.equal(result.integration.buildPassed, true);
        assert.equal(result.integration.resultMatched, true);
        assert.equal(result.participants.length, 1);
        assert.equal(result.participants[0].closed, true);
        assert.equal(result.deliveries[0].receipt.toolCalls, 1);
        assert.equal(result.deliveries[0].receipt.failedToolCalls, 0);
        assert.equal(provider.requests.length, 2);
        assert.deepEqual(provider.errors, []);
        const request = provider.requests[0];
        assert.deepEqual(
          request.tools.map((tool) => tool.function.name),
          ["bash"],
        );
        assert.ok(
          request.messages.every((message) => message.role !== "system" || !message.content),
        );
        const user = request.messages.find((message) => message.role === "user");
        assert.ok(
          JSON.stringify(user.content).includes(padding ? "/feedback/module.txt" : "bad_name"),
        );
        assert.equal(
          await readFile(path.join(output, "feedback/session-0/module.txt"), "utf8"),
          assignment,
        );
        assert.equal(await readFile(path.join(output, "workspace/body.h"), "utf8"), body);
        assert.deepEqual(await readFile(provider.config.modelsFile), originalModels);
        await assert.rejects(access(path.join(output, "participants/session-0/pi/models.json")), {
          code: "ENOENT",
        });
        const namespace = result.participants[0].participant.process.namespace;
        for (const pid of await readdir("/proc")) {
          if (!/^\d+$/.test(pid)) continue;
          try {
            if ((await readlink(`/proc/${pid}/ns/pid`)) !== namespace) continue;
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            assert.ok(
              ["Z", "X"].includes(
                stat
                  .slice(stat.lastIndexOf(")") + 1)
                  .trim()
                  .split(/\s+/)[0],
              ),
            );
          } catch (error) {
            if (!["ENOENT", "ESRCH", "EPERM", "EACCES"].includes(error.code)) throw error;
          }
        }
      } finally {
        if (drivers) await drivers.cleanup();
        provider?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
