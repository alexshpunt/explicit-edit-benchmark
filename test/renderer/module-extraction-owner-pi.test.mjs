import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { runExtractionRecovery } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery.mjs";
import { recoveryModelDrivers } from "../../src/suites/explicit-edit-multi-agent/extraction/case.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_RUNTIME;
const bodies = [
  "int alpha() { return 1; }",
  "int beta() { return 2; }",
  "int gamma() { return 3; }",
];
const program = `#include <fstream>
#include <string>
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int variant = 0; variant < 2; variant++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = i % 4 == 3 ? 1 : (i % 7) + variant;
    std::ofstream image(std::string(argv[1]) + "-" + std::to_string(variant) + ".rgba32f", std::ios::binary);
    image.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`;
const expectedPixels = [0, 1].map((variant) => {
  const bytes = Buffer.alloc(32 * 32 * 4 * 4);
  for (let i = 0; i < 32 * 32 * 4; i++)
    bytes.writeFloatLE(i % 4 === 3 ? 1 : (i % 7) + variant, i * 4);
  return createHash("sha256").update(bytes).digest("hex");
});
const preamble = `from pathlib import Path
import fcntl, time, os
from contextlib import contextmanager
source = Path('main.cpp')
@contextmanager
def shared_lock():
    fd = os.open('/workspace', os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)
def wait_for(test):
    limit = time.monotonic() + 8
    while not test():
        assert time.monotonic() < limit
        time.sleep(0.01)
`;

for (const mode of ["parallel", "serial"])
  test(
    `real Pi owners retain their contexts through ${mode} source repairs`,
    { skip: process.platform !== "linux" || !runtime, timeout: 120000 },
    async () => {
      await mkdir(path.resolve(".tmp"), { recursive: true });
      const root = await mkdtemp(path.resolve(".tmp/extraction-owner-pi-"));
      let drivers, provider;
      let verified = false;
      try {
        const headers = bodies
          .map((body, i) => `#ifndef H${i}\n#define H${i}\n${body}\n#endif\n`)
          .join("");
        const plan = {
          ...prepareHeaderExtraction({
            initial: { "main.cpp": headers + program },
            headers: bodies.map((_body, i) => ({ file: `f${i}.h`, guard: `H${i}`, includes: [] })),
            modules: ["f0.h", "f1.h", "f2.h"],
          }),
          version: "renderer-module-extraction-plan-v2",
          scope: "experimental-module-pairs",
          agents: 2,
        };
        const output = path.join(root, "run");
        provider = await providerFixture(root, (request) =>
          request.messages.at(-1).role === "tool"
            ? {}
            : { command: "python3 /feedback/native-case.py" },
        );
        const models = await readFile(provider.config.modelsFile);
        drivers = recoveryModelDrivers(output, provider.config);
        const repairs = [];
        const report = await runExtractionRecovery(plan, output, {
          ...drivers,
          expectedPixels,
          async execute(driver, task, context) {
            const index = plan.tasks.findIndex((t) => t.id === task.id);
            assert.ok(
              index >= 0,
              JSON.stringify({
                stage: context.stage,
                id: task.id,
                report: JSON.parse(await readFile(path.join(output, "report.json"), "utf8")),
              }),
            );
            let script = preamble;
            if (context.stage === "original") {
              script += `with shared_lock():
    text = source.read_text()
    fragments = ${JSON.stringify(task.fragments.map((f) => f.text))}
    for number, fragment in enumerate(fragments):
        assert text.count(fragment) == 1
        text = text.replace(fragment, ${JSON.stringify(task.replacement)} if number == 0 else '', 1)
    with Path(${JSON.stringify(task.file)}).open('x') as target:
        target.write(${JSON.stringify(task.destination)})
    source.write_text(text)
`;
              if (index === 2)
                script += `wait_for(lambda: all(Path(name).exists() for name in ${JSON.stringify(plan.tasks.map((t) => t.file))}))
with shared_lock():
    source.write_text(source.read_text() + ${JSON.stringify(mode === "parallel" ? bodies.slice(0, 2).join("\n") + "\n" : `namespace n {\n${bodies.slice(0, 2).join("\n")}\n}\n`)})
`;
            } else {
              assert.equal(context.stage, "structural-correction");
              assert.equal(context.agent, index % 2);
              repairs.push(task);
              if (mode === "parallel")
                script += `Path('.repair-enter-${index}').touch()
wait_for(lambda: all(Path('.repair-enter-' + str(i)).exists() for i in [0, 1]))
`;
              const diagnostic = task.recovery.diagnostics.find((d) => d.kind === "source-residue");
              assert.ok(diagnostic);
              script += `with shared_lock():
    text = source.read_text()
    body = ${JSON.stringify(bodies[index])}
    assert text.count(body) == 1
${mode === "serial" ? `    assert text[${diagnostic.start}:${diagnostic.end}] == body\n` : ""}    text = '\\n\\n' + text.replace(body, '', 1)
    text = text.replace('namespace n {\\n\\n\\n}', '')
    source.write_text(text)
`;
              if (mode === "parallel")
                script += `Path('.repair-done-${index}').touch()
${index === 0 ? "wait_for(lambda: all(Path('.repair-done-' + str(i)).exists() for i in [0, 1]))\nfor i in [0, 1]:\n    for kind in ['enter', 'done']:\n        Path('.repair-' + kind + '-' + str(i)).unlink()\n" : ""}`;
            }
            // Only the test provider's read-only feedback is prepared here. All
            // measured source changes occur in the real participant's Bash tool.
            await writeFile(
              path.join(
                output,
                "stages/original/feedback",
                `session-${context.session}`,
                "native-case.py",
              ),
              script,
            );
            return drivers.execute(driver, task, context);
          },
        });
        await drivers.cleanup();
        assert.equal(report.passed, true);
        assert.equal(report.participants.length, 2);
        assert.equal(report.deliveries.length, 5);
        assert.equal(report.barriers.length, 1);
        assert.equal(report.barriers[0].participants.length, 2);
        assert.equal(report.recoveryChecks[0].ready.length, mode === "parallel" ? 2 : 1);
        assert.equal(repairs.length, 2);
        assert.equal(report.score.structural.totalHunks, 3);
        assert.equal(report.score.score, mode === "parallel" ? 50 : 100 * (2 / 3));
        assert.equal(report.first.integration.buildPassed, mode === "serial");
        assert.equal(report.integration.buildPassed, true);
        assert.equal(report.integration.resultMatched, true);
        assert.deepEqual(report.integration.pixels, expectedPixels);
        assert.deepEqual(
          report.stages.map((s) => s.stage),
          ["original", "structural-correction"],
        );
        assert.ok(report.participants.every((p) => p.closed));
        assert.ok(
          report.deliveries.every((d) => d.status === "settled" && d.receipt.failedToolCalls === 0),
        );
        for (const repair of report.deliveries.filter((d) => d.stage === "structural-correction")) {
          const original = report.deliveries.find(
            (d) => d.stage === "original" && d.ids[0] === repair.ids[0],
          );
          assert.ok(original);
          assert.equal(repair.agent, original.agent);
          assert.equal(repair.receipt.sessionId, original.receipt.sessionId);
          assert.equal(repair.receipt.lifetime, original.receipt.lifetime);
        }
        assert.deepEqual(await readFile(provider.config.modelsFile), models);
        assert.deepEqual(provider.errors, []);
        for (const p of report.participants)
          await assert.rejects(
            access(
              path.join(
                output,
                "stages/original/participants",
                `session-${p.session}/pi/models.json`,
              ),
            ),
            { code: "ENOENT" },
          );
        verified = true;
      } finally {
        if (drivers) await drivers.cleanup();
        provider?.close();
        if (verified) await rm(root, { recursive: true, force: true });
      }
    },
  );
