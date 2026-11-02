import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { preparePairedExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/paired-plan.mjs";
import { runExtractionRecovery } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery.mjs";
import { recoveryModelDrivers } from "../../src/suites/explicit-edit-multi-agent/extraction/case.mjs";
import { pairedExtractionFixture } from "../helpers/module-extraction-generation.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_RUNTIME;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const definitions = {
  long: "int pick(long value) { return value + 3; }\n",
  read: "int read_pick() { return pick(0); }\n",
  int: "int pick(int value) { return value + 7; }\n",
};
const correct = definitions.long + definitions.read + definitions.int;
const program =
  '#include "yocto_a.h"\n#include "yocto_b.h"\n#include <fstream>\n#include <string>\n' +
  correct +
  `int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int variant = 0; variant < 2; variant++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++)
      pixels[i] = i % 4 == 3 ? 1 : (i % 7) + variant + read_pick();
    std::ofstream image(std::string(argv[1]) + "-" + std::to_string(variant) + ".rgba32f", std::ios::binary);
    image.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`;
const expectedPixels = [0, 1].map((variant) => {
  const bytes = Buffer.alloc(32 * 32 * 4 * 4);
  for (let index = 0; index < 32 * 32 * 4; index++)
    bytes.writeFloatLE(index % 4 === 3 ? 1 : (index % 7) + variant + 3, index * 4);
  return hash(bytes);
});

for (const kind of ["structural", "build", "image"])
  test(
    `real Pi ${kind} recovery edits the candidate once and passes real compilation and both scenes`,
    { skip: process.platform !== "linux" || !runtime, timeout: 120000 },
    async () => {
      await mkdir(path.resolve(".tmp"), { recursive: true });
      const root = await mkdtemp(path.resolve(".tmp/extraction-recovery-pi-"));
      let provider, drivers;
      try {
        const plan = preparePairedExtraction({
          ...pairedExtractionFixture({ main: program }),
          modules: ["frond_a", "frond_b"],
          agents: 1,
        });
        const output = path.join(root, "run");
        const stage = kind === "structural" ? "structural-correction" : `${kind}-correction`;
        const broken =
          kind === "build"
            ? definitions.read + definitions.long + definitions.int
            : definitions.long + definitions.int + definitions.read;
        const damagedTask = plan.tasks.find((task) => task.file.endsWith("_a.cpp"));
        assert.ok(damagedTask);
        const commands = plan.tasks.map(
          (task, index) => `flock -x /workspace python3 - <<'PY'
from pathlib import Path
source = Path('main.cpp')
text = source.read_text()
fragments = ${JSON.stringify(task.fragments.map(({ text }) => text))}
${task.kind === "header" ? `first = text.index(fragments[0])\npoint = text.rfind("namespace frond {", 0, first)\nassert point >= 0\ntext = text[:point] + ${JSON.stringify(task.replacement)} + text[point:]\n` : ""}for index, fragment in enumerate(fragments):
    assert text.count(fragment) == 1
    text = text.replace(fragment, ${JSON.stringify(task.kind === "header" ? "" : task.replacement)} if index == 0 else '', 1)
body = ${JSON.stringify(task.destination)}
${kind === "structural" && task.id === damagedTask.id ? "body += '\\nint recovery_error = ;\\n'" : ""}
with Path(${JSON.stringify(task.file)}).open('x') as target:
    target.write(body)
${index === plan.tasks.length - 1 && kind !== "structural" ? `assert text.count(${JSON.stringify(correct)}) == 1\ntext = text.replace(${JSON.stringify(correct)}, ${JSON.stringify(broken)}, 1)` : ""}
source.write_text(text)
PY`,
        );
        const repair =
          kind === "structural"
            ? `python3 - <<'PY'\nfrom pathlib import Path\nPath(${JSON.stringify(damagedTask.file)}).write_text(${JSON.stringify(damagedTask.destination)})\nPY`
            : `set +e
bash /feedback/check-${kind === "build" ? "build" : "images"}.sh
before=$?
set -e
test "$before" -ne 0
flock -x /workspace python3 - <<'PY'
from pathlib import Path
p = Path('main.cpp')
text = p.read_text()
assert text.count(${JSON.stringify(broken)}) == 1
p.write_text(text.replace(${JSON.stringify(broken)}, ${JSON.stringify(correct)}, 1))
PY
bash /feedback/check-${kind === "build" ? "build" : "images"}.sh`;
        commands.push(repair);
        provider = await providerFixture(root, (_request, number) =>
          number % 2 === 1 ? { command: commands[(number - 1) / 2] } : {},
        );
        const originalModels = await readFile(provider.config.modelsFile);
        drivers = recoveryModelDrivers(output, provider.config);
        const report = await runExtractionRecovery(plan, output, { ...drivers, expectedPixels });
        await drivers.cleanup();
        assert.equal(report.status, "complete");
        assert.equal(report.passed, true);
        assert.deepEqual(
          report.stages.map(({ stage }) => stage),
          ["original", stage],
        );
        assert.equal(report.participants.length, kind === "structural" ? 1 : 2);
        const originals = report.deliveries.filter((delivery) => delivery.stage === "original");
        const repairs = report.deliveries.filter((delivery) => delivery.stage === stage);
        assert.equal(originals.length, plan.tasks.length);
        assert.equal(repairs.length, 1);
        assert.deepEqual(
          report.deliveries.map((delivery) => delivery.stage),
          [...plan.tasks.map(() => "original"), stage],
        );
        const original = originals.find((delivery) => delivery.ids.includes(damagedTask.id));
        assert.ok(original);
        for (const key of ["sessionId", "lifetime"]) {
          assert.equal(typeof original.receipt[key], "string");
          assert.ok(original.receipt[key].length > 0);
          assert.equal(typeof repairs[0].receipt[key], "string");
          if (kind === "structural") assert.equal(repairs[0].receipt[key], original.receipt[key]);
          else assert.notEqual(repairs[0].receipt[key], original.receipt[key]);
        }
        const repairRequest = provider.requests[2 * plan.tasks.length];
        assert.ok(repairRequest);
        const priorUsers = commands.slice(0, plan.tasks.length).map((_command, index) => {
          const users = provider.requests[2 * index].messages.filter(({ role }) => role === "user");
          return users.at(-1);
        });
        const recoveryUsers = repairRequest.messages.filter(({ role }) => role === "user");
        const previousCalls = repairRequest.messages.flatMap((message) => message.tool_calls ?? []);
        if (kind === "structural") {
          assert.equal(recoveryUsers.length, plan.tasks.length + 1);
          assert.deepEqual(recoveryUsers.slice(0, -1), priorUsers);
          assert.deepEqual(
            previousCalls.map((call) => JSON.parse(call.function.arguments).command),
            commands.slice(0, plan.tasks.length),
          );
        } else {
          assert.equal(recoveryUsers.length, 1);
          assert.deepEqual(previousCalls, []);
        }
        assert.equal(report.waves[1].agents, 1);
        assert.equal(report.waves[1].ids.length, 1);
        assert.equal(report.integration.buildPassed, true);
        assert.equal(report.integration.resultMatched, true);
        assert.deepEqual(report.integration.pixels, expectedPixels);
        assert.equal(report.structure.status, "pass");
        assert.equal(report.score.structural.totalHunks, plan.tasks.length);
        assert.equal(report.score.build.factor, kind === "image" ? 1 : 0.75);
        assert.equal(report.score.images.factor, kind === "image" ? 0.75 : 1);
        assert.equal(report.score.score, kind === "structural" ? 67.5 : 75);
        if (kind === "structural")
          assert.equal(
            report.first.structure.files.find(({ id }) => id === damagedTask.id).targetMatched,
            false,
          );
        else assert.equal(report.first.structure.status, "pass");
        assert.equal(report.first.integration.buildPassed, kind === "image");
        assert.equal(report.first.integration.resultMatched, false);
        assert.equal(provider.requests.length, 2 * (plan.tasks.length + 1));
        assert.deepEqual(provider.errors, []);
        for (const delivery of report.deliveries) {
          assert.equal(delivery.status, "settled");
          assert.equal(delivery.receipt.toolCalls, 1);
          assert.equal(delivery.receipt.failedToolCalls, 0);
        }
        assert.equal(
          await readFile(path.join(output, "workspace/main.cpp"), "utf8"),
          plan.expected["main.cpp"],
        );
        assert.deepEqual(await readFile(provider.config.modelsFile), originalModels);
        for (const participant of report.participants) {
          assert.equal(participant.closed, true);
          await assert.rejects(
            access(
              path.join(
                output,
                "stages",
                participant.stage,
                `participants/session-${participant.session}/pi/models.json`,
              ),
            ),
            { code: "ENOENT" },
          );
          const namespace = participant.participant.process.namespace;
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
        }
      } finally {
        if (drivers) await drivers.cleanup();
        provider?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
