import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import { coherentTaskPrompt } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import {
  writeTree,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const root = process.env.RENDERER_CONCURRENT_STRUCTURE_OUTPUT;
assert.ok(root && process.env.RENDERER_PI_RUNTIME);
await mkdir(root);
const original = path.join(root, "original");
await mkdir(original);
await mkdir(path.join(original, "contracts"));
const initial = {
  "main.cpp": `#include <fstream>
#include <string>
#ifndef _NORTH_H_
#define _NORTH_H_
namespace frond { inline int North(int value) { return value + 1; } }
#endif
#ifndef _SOUTH_H_
#define _SOUTH_H_
namespace frond { inline int South(int value) { return value + 2; } }
#endif
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int scene = 0; scene < 2; scene++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = float(i % 17 + frond::North(scene) + frond::South(scene));
    std::ofstream file(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    file.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`,
};
const tasks = ["north", "south"].map((name, i) => {
  const op = {
    id: `header-${i}`,
    phase: "structure",
    action: "header",
    file: `${name}.h`,
    guard: `_${name.toUpperCase()}_H_`,
    includes: [],
  };
  const goal = `Extract the ${name} header from the current monolith, replacing its body with the header include.`;
  return {
    id: `task-00${i + 1}`,
    phase: "structure",
    subsystem: op.file,
    operations: [op],
    goal,
    prompt: coherentTaskPrompt(goal, [op]),
  };
});
let expected = initial;
const contractHashes = {};
async function checkpoint(id) {
  const bytes = JSON.stringify(prepareCoherentContract(expected)) + "\n";
  contractHashes[id] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(original, "contracts", id + ".json"), bytes);
}
await checkpoint("initial");
for (const task of tasks) {
  expected = task.operations.reduce(applyCoherentStructure, expected);
  await checkpoint(task.id);
}
await writeTree(path.join(original, "initial"), initial);
const bytes = JSON.stringify(tasks) + "\n";
await writeFile(path.join(original, "tasks.json"), bytes);
const pixels = await buildCoherentCandidate(
  path.join(original, "initial"),
  path.join(root, "golden"),
  initial,
);
await writeFile(
  path.join(original, "manifest.json"),
  JSON.stringify({
    version: "renderer-coherent-v1",
    initial: treeIdentity(initial),
    final: treeIdentity(expected),
    tasks: tasks.length,
    tasksSha256: createHash("sha256").update(bytes).digest("hex"),
    contractHashes,
    pixels,
  }),
);
assert.equal((await runCoherent(original, path.join(root, "old-route"))).status, "pass");
const preparation = path.join(root, "preparation");
assert.equal((await prepareConcurrent(original, preparation)).graphWidth, 2);
assert.equal((await runConcurrent(preparation, path.join(root, "reference"))).status, "pass");

await test(
  "real Pi agents extract independent headers from the same initial monolith at the same time",
  { timeout: 120000 },
  async (t) => {
    const directory = path.join(root, "provider");
    await mkdir(directory);
    const provider = await providerFixture(directory, (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const content = body.messages.findLast((message) => message.role === "user").content;
      const message =
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      const rows = message.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const op = rows.find((row) =>
        tasks.some(
          (task) => task.operations[0].guard === row.guard && task.operations[0].file === row.file,
        ),
      );
      assert.ok(op && tasks.some((task) => task.operations[0].guard === op.guard));
      return {
        command: `python3 - <<'PY'
from pathlib import Path
import fcntl, time
file=${JSON.stringify(op.file)}
guard=${JSON.stringify(op.guard)}
Path('/workspace/.started-'+file.removesuffix('.h')).touch()
end=time.monotonic()+15
while not all(Path('/workspace/.started-'+name).exists() for name in ['north','south']):
    assert time.monotonic()<end, 'Header tasks were serialized'
    time.sleep(0.01)
with open('/workspace/.fixture-lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    main=Path('/workspace/main.cpp')
    text=main.read_text()
    start=text.index('#ifndef '+guard+'\\n')
    end=text.index('#endif\\n',start)+len('#endif\\n')
    Path('/workspace/'+file).write_text(text[start:end].rstrip())
    main.write_text(text[:start]+'#include "'+file+'"\\n'+text[end:])
PY`,
      };
    });
    t.after(() => provider.close());
    const config = path.join(directory, "config.json");
    await writeFile(config, JSON.stringify(provider.config));
    const report = await runConcurrent(preparation, path.join(root, "native"), {
      configPath: config,
    });
    assert.equal(report.status, "pass");
    assert.equal(report.acceptedTasks, 2);
    assert.equal(report.acceptedRounds, 1);
    assert.equal(report.repairs, 0);
    assert.deepEqual(
      report.schedule[0].assignments.map((item) => item.task),
      tasks.map((task) => task.id),
    );
    assert.equal(new Set(report.executions.map((item) => item.receipt.sessionId)).size, 2);
    assert.ok(
      Math.max(...report.executions.map((item) => item.startedMs)) <
        Math.min(...report.executions.map((item) => item.startedMs + item.elapsedMs)),
    );
    assert.ok(report.agentsClosed.every(Boolean));
    assert.deepEqual(report.checks.at(-1).pixels, pixels);
    const source = await readFile(path.join(root, "native/workspace/main.cpp"), "utf8");
    assert.ok(source.includes('#include "north.h"') && source.includes('#include "south.h"'));
    assert.ok(!source.includes("inline int North") && !source.includes("inline int South"));
  },
);
