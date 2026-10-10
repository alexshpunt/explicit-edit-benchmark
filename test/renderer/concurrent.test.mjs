import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import { appendCoherentNamingTask } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import {
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { multiAgentResult } from "../../src/suites/explicit-edit-multi-agent/results.mjs";

const root = process.env.RENDERER_CONCURRENT_OUTPUT;
assert.ok(root && process.env.RENDERER_PI_RUNTIME);
await mkdir(root);
const original = path.join(root, "original");
await mkdir(original);
await mkdir(path.join(original, "contracts"));
const names = ["Alpha", "Beta", "Gamma", "Delta"];
const source = `#include <fstream>
#include <string>
namespace frond {
${names.map((name, i) => `int ${name}(int wrong) { return wrong + ${i + 1}; }\nint Use${name}(int value) { return frond::${name}(value); }`).join("\n")}
}
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int scene = 0; scene < 2; scene++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = float(i % 17 + ${names.map((name) => `frond::Use${name}(scene)`).join(" + ")});
    std::ofstream file(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    file.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`;
const tasks = [];
const edits = new Map();
let current = source;
const contractHashes = {};
async function checkpoint(id) {
  const bytes = JSON.stringify(prepareCoherentContract({ "main.cpp": current })) + "\n";
  contractHashes[id] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(original, "contracts", `${id}.json`), bytes);
}
await checkpoint("initial");
for (const category of ["locals-parameters", "functions-types"]) {
  for (const [i, name] of names.entries()) {
    const parameter = category === "locals-parameters";
    const from = parameter ? "wrong" : name;
    const to = parameter ? `p${i}` : name.toLowerCase();
    appendCoherentNamingTask(tasks, category, "main.cpp", [
      {
        id: `${category}-${i}`,
        phase: "names",
        category,
        mapping: [{ from, to }],
        selectors: [
          { kind: "function", scope: `frond::${name}`, signature: "int (int)", definition: true },
        ],
      },
    ]);
    const changes = parameter
      ? [[`int ${name}(int wrong) { return wrong +`, `int ${name}(int ${to}) { return ${to} +`]]
      : [
          [`int ${name}(`, `int ${to}(`],
          [`frond::${name}(`, `frond::${to}(`],
        ];
    for (const [old, next] of changes) current = current.replaceAll(old, next);
    edits.set(tasks.at(-1).id, { i, parameter, changes });
    await checkpoint(tasks.at(-1).id);
  }
}
const final = { "main.cpp": current };
await writeTree(path.join(original, "initial"), { "main.cpp": source });
const bytes = JSON.stringify(tasks) + "\n";
await writeFile(path.join(original, "tasks.json"), bytes);
const pixels = await buildCoherentCandidate(
  path.join(original, "initial"),
  path.join(root, "golden"),
  { "main.cpp": source },
);
await writeFile(
  path.join(original, "manifest.json"),
  JSON.stringify({
    version: "renderer-coherent-v1",
    initial: treeIdentity({ "main.cpp": source }),
    final: treeIdentity(final),
    tasks: tasks.length,
    tasksSha256: createHash("sha256").update(bytes).digest("hex"),
    contractHashes,
    pixels,
  }),
);
assert.equal((await runCoherent(original, path.join(root, "old-scripted"))).status, "pass");
const preparation = path.join(root, "concurrent");
const manifest = await prepareConcurrent(original, preparation);
assert.equal(manifest.graphWidth, 4);
assert.equal(
  (await runConcurrent(preparation, path.join(root, "concurrent-scripted"))).status,
  "pass",
);
const single = await runConcurrent(preparation, path.join(root, "single-scripted"), { agents: 1 });
assert.equal(single.status, "pass");
assert.deepEqual(
  single.schedule.flatMap((round) => round.assignments.map((item) => item.task)),
  tasks.map((task) => task.id),
);

async function fixture(name, respond) {
  const directory = path.join(root, name);
  await mkdir(directory);
  const provider = await providerFixture(directory, (body) => {
    appendFileSync(path.join(directory, "provider-requests.jsonl"), JSON.stringify(body) + "\n");
    try {
      return respond(body);
    } catch (error) {
      appendFileSync(path.join(directory, "provider-errors.log"), error.stack + "\n");
      throw error;
    }
  });
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify(provider.config));
  return { provider, config, output: path.join(directory, "run") };
}
function delivered(body) {
  const content = body.messages.findLast((item) => item.role === "user").content;
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
  const target = rows.find((row) => row.mapping?.length && row.selectors?.length);
  const task = tasks.find(
    (item) =>
      JSON.stringify(item.operations[0].mapping) === JSON.stringify(target?.mapping) &&
      JSON.stringify(item.operations[0].selectors) === JSON.stringify(target?.selectors),
  );
  assert.ok(task, "The fixture received an unknown structured editing target");
  return { id: task.id, ...edits.get(task.id) };
}
function mutation(task, { barrier = false, regress = false } = {}) {
  return `python3 - <<'PY'
from pathlib import Path
import fcntl, time
p=Path('/workspace/main.cpp')
${
  barrier
    ? `Path('/workspace/.ready-${task.i}').touch()
end=time.monotonic()+15
while not all(Path('/workspace/.ready-'+str(i)).exists() for i in range(4)):
    assert time.monotonic()<end, 'Agents were not dispatched concurrently'
    time.sleep(0.01)`
    : ""
}
with open('/workspace/.fixture-lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    text=p.read_text()
    for old,new in ${JSON.stringify(task.changes)}:
        assert old in text, 'Current target missing'
        text=text.replace(old,new)
    p.write_text(text)
${!task.parameter ? `Path('/workspace/.named-${task.i}').touch()` : ""}
${
  regress
    ? `end=time.monotonic()+15
while not all(Path('/workspace/.named-'+str(i)).exists() for i in range(4)):
    assert time.monotonic()<end
    time.sleep(0.01)
with open('/workspace/.fixture-lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    text=p.read_text()
    assert 'int alpha(int p0) { return p0 +' in text
    p.write_text(text.replace('int alpha(int p0) { return p0 +', 'int alpha(int wrong) { return wrong +'))`
    : ""
}
PY`;
}

await test(
  "four real Pi sessions overlap, rotate owners, preserve peer edits and keep their own history",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture("success", (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const task = delivered(body);
      return { command: mutation(task, { barrier: task.parameter }) };
    });
    t.after(() => f.provider.close());
    const report = await runConcurrent(preparation, f.output, { configPath: f.config });
    assert.equal(report.status, "pass");
    const safe = multiAgentResult(report);
    assert.equal(safe.status, "pass");
    assert.equal(safe.progress.acceptedTasks, report.acceptedTasks);
    assert.equal(safe.configuration.runtime.version, "1.0.1");
    assert.equal(report.agents, 4);
    assert.equal(report.acceptedTasks, 8);
    assert.equal(report.acceptedRounds, 2);
    assert.equal(report.deliveries, 8);
    assert.equal(report.repairs, 0);
    assert.ok(report.agentsClosed.every(Boolean));
    assert.equal(
      await readFile(path.join(f.output, "workspace/main.cpp"), "utf8"),
      final["main.cpp"],
    );
    const first = report.executions.filter((item) => item.round === "round-001");
    assert.equal(new Set(first.map((item) => item.receipt.sessionId)).size, 4);
    assert.equal(new Set(first.map((item) => item.receipt.lifetime)).size, 4);
    assert.ok(
      Math.max(...first.map((item) => item.startedMs)) <
        Math.min(...first.map((item) => item.startedMs + item.elapsedMs)),
    );
    for (let agent = 0; agent < 4; agent++) {
      const history = report.executions.filter((item) => item.agent === agent);
      assert.equal(history.length, 2);
      assert.equal(history[0].receipt.sessionId, history[1].receipt.sessionId);
      assert.equal(history[0].receipt.lifetime, history[1].receipt.lifetime);
      assert.notEqual(edits.get(history[0].tasks[0]).i, edits.get(history[1].tasks[0]).i);
      await assert.rejects(access(path.join(f.output, `agent-${agent}/pi/auth.json`)), {
        code: "ENOENT",
      });
    }
  },
);

await test(
  "a peer regression remains visible through three coarse corrections and no reset or later delivery",
  { timeout: 120000 },
  async (t) => {
    const seen = new Set();
    const f = await fixture("regression", (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const task = delivered(body);
      if (seen.has(task.id)) return { command: "printf retained >> /workspace/corrections.txt" };
      seen.add(task.id);
      return {
        command: mutation(task, {
          barrier: task.parameter,
          regress: !task.parameter && task.i === 3,
        }),
      };
    });
    t.after(() => f.provider.close());
    const report = await runConcurrent(preparation, f.output, { configPath: f.config });
    assert.equal(report.status, "blocked");
    const safe = multiAgentResult(report);
    assert.equal(safe.status, "blocked");
    assert.equal(safe.progress.acceptedTasks, report.acceptedTasks);
    assert.equal(safe.configuration.runtime.version, "1.0.1");
    assert.equal(report.acceptedTasks, 4);
    assert.equal(report.acceptedRounds, 1);
    assert.equal(report.repairs, 12);
    assert.equal(report.deliveries, 20);
    assert.equal(
      report.checks.filter((check) => check.status === "fail" && check.category === "structure")
        .length,
      4,
    );
    assert.ok(report.agentsClosed.every(Boolean));
    assert.ok(
      (await readFile(path.join(f.output, "workspace/main.cpp"), "utf8")).includes(
        "int alpha(int wrong)",
      ),
    );
    assert.equal(
      (await readFile(path.join(f.output, "workspace/corrections.txt"), "utf8")).length,
      "retained".length * 12,
    );
    await assert.rejects(access(path.join(f.output, "verification.json")), { code: "ENOENT" });
  },
);

await test(
  "cancelling a shared run closes every Pi and its active shell children without late writes",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture("cancel", (body) => {
      const task = delivered(body);
      return {
        command: `(sleep 4; printf late > /workspace/.late-${task.i}) & touch /workspace/.started-${task.i}; wait`,
      };
    });
    t.after(() => f.provider.close());
    const controller = new AbortController();
    t.after(() => controller.abort());
    let settled = false;
    const running = runConcurrent(preparation, f.output, {
      configPath: f.config,
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 4; i++) {
      for (;;) {
        try {
          await access(path.join(f.output, `workspace/.started-${i}`));
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          assert.equal(settled, false);
          await delay(10);
        }
      }
    }
    controller.abort();
    const report = await running;
    assert.equal(report.status, "cancelled");
    const safe = multiAgentResult(report);
    assert.equal(safe.status, "cancelled");
    assert.equal(safe.progress.acceptedTasks, report.acceptedTasks);
    assert.equal(safe.configuration.runtime.version, "1.0.1");
    assert.equal(report.acceptedTasks, 0);
    assert.ok(report.agentsClosed.every(Boolean));
    await delay(4500);
    for (let i = 0; i < 4; i++) {
      await assert.rejects(access(path.join(f.output, `workspace/.late-${i}`)), { code: "ENOENT" });
      await assert.rejects(access(path.join(f.output, `agent-${i}/pi/auth.json`)), {
        code: "ENOENT",
      });
    }
  },
);
