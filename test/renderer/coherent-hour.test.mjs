import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import { appendCoherentNamingTask } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import {
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { providerFixture } from "./provider-fixture.mjs";

await assert.rejects(
  runCoherent("unused", "unused", { profile: "unknown" }),
  /Unknown coherent profile/,
);
await assert.rejects(
  runCoherent("unused", "unused", { hourLimitMs: 1 }),
  /Untimed runs do not accept an hour limit/,
);
const root = process.env.RENDERER_COHERENT_OUTPUT;
assert.ok(root && process.env.RENDERER_PI_RUNTIME);
await mkdir(root);
const preparation = path.join(root, "preparation");
await mkdir(preparation);
await mkdir(path.join(preparation, "contracts"));
const source = `#include <fstream>
#include <string>
namespace frond { int Sample(int wrong) { return wrong + 1; } }
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int scene = 0; scene < 2; scene++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = float(i % 17 + frond::Sample(scene));
    std::ofstream file(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    file.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`;
const initial = { "main.cpp": source };
const first = {
  "main.cpp": source.replace(
    "int Sample(int wrong) { return wrong + 1; }",
    "int Sample(int index) { return index + 1; }",
  ),
};
const final = {
  "main.cpp": first["main.cpp"]
    .replace("int Sample(int index)", "int sample(int index)")
    .replace("frond::Sample(scene)", "frond::sample(scene)"),
};
const tasks = [];
appendCoherentNamingTask(tasks, "locals-parameters", "main.cpp", [
  {
    id: "parameter",
    phase: "names",
    category: "locals-parameters",
    mapping: [{ from: "wrong", to: "index" }],
    selectors: [
      { kind: "function", scope: "frond::Sample", signature: "int (int)", definition: true },
    ],
  },
]);
appendCoherentNamingTask(tasks, "free-functions", "main.cpp", [
  {
    id: "function",
    phase: "names",
    category: "free-functions",
    mapping: [{ from: "Sample", to: "sample" }],
    selectors: [
      { kind: "function", scope: "frond::Sample", signature: "int (int)", definition: true },
    ],
  },
]);
await writeTree(path.join(preparation, "initial"), initial);
const contractHashes = {};
for (const { id, tree } of [
  { id: "initial", tree: initial },
  { id: tasks[0].id, tree: first },
  { id: tasks[1].id, tree: final },
]) {
  const bytes = JSON.stringify(prepareCoherentContract(tree)) + "\n";
  contractHashes[id] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(preparation, "contracts", `${id}.json`), bytes);
}
const taskBytes = JSON.stringify(tasks) + "\n";
await writeFile(path.join(preparation, "tasks.json"), taskBytes);
const pixels = await buildCoherentCandidate(
  path.join(preparation, "initial"),
  path.join(root, "golden"),
  initial,
);
await writeFile(
  path.join(preparation, "manifest.json"),
  JSON.stringify({
    version: "renderer-coherent-v1",
    initial: treeIdentity(initial),
    final: treeIdentity(final),
    tasks: tasks.length,
    tasksSha256: createHash("sha256").update(taskBytes).digest("hex"),
    contractHashes,
    pixels,
  }),
);
const scripted = await runCoherent(preparation, path.join(root, "scripted"));
assert.equal(scripted.status, "pass");
assert.equal(scripted.acceptedTasks, 2);
assert.equal(scripted.checks.length, 3);
assert.equal(scripted.profile, "coherent");
assert.equal(scripted.policy.trialTimeoutMs, null);
assert.equal(scripted.policy.attemptTimeoutMs, null);
const proofBefore = await readFile(path.join(preparation, "verification.json"), "utf8");
const diagnosticScripted = await runCoherent(preparation, path.join(root, "diagnostic-scripted"), {
  profile: "coherent-diagnostic",
});
assert.equal(diagnosticScripted.status, "pass");
assert.equal(diagnosticScripted.profile, "coherent-diagnostic");
await assert.rejects(access(path.join(root, "diagnostic-scripted/verification.json")), {
  code: "ENOENT",
});
assert.equal(await readFile(path.join(preparation, "verification.json"), "utf8"), proofBefore);

await test("the CLI is untimed by default and requires an explicit flag for the legacy deadline", async () => {
  const command = promisify(execFile);
  for (const { name, flags, profile, trialTimeoutMs, attemptTimeoutMs } of [
    {
      name: "cli-default",
      flags: [],
      profile: "coherent",
      trialTimeoutMs: null,
      attemptTimeoutMs: null,
    },
    {
      name: "cli-hour",
      flags: ["--hour-limited"],
      profile: "coherent-hour",
      trialTimeoutMs: 3600000,
      attemptTimeoutMs: 1800000,
    },
  ]) {
    const output = path.join(root, name);
    const result = await command(process.execPath, [
      "src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs",
      ...flags,
      preparation,
      output,
    ]);
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.status, "pass");
    assert.equal(report.acceptedTasks, 2);
    assert.equal(report.profile, profile);
    assert.equal(report.policy.trialTimeoutMs, trialTimeoutMs);
    assert.equal(report.policy.attemptTimeoutMs, attemptTimeoutMs);
    assert.ok(result.stdout.includes(`PROFILE ${profile}:`));
  }
  await assert.rejects(
    command(process.execPath, [
      "src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs",
      "--diagnostic",
      "--hour-limited",
      preparation,
      path.join(root, "conflicting-options"),
    ]),
    (error) => error.code === 1 && error.stderr.includes("Unknown coherent option"),
  );
  await assert.rejects(access(path.join(root, "conflicting-options")), { code: "ENOENT" });
});
async function fixture(name, respond) {
  const directory = path.join(root, name);
  await mkdir(directory);
  const provider = await providerFixture(directory, respond);
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify(provider.config));
  return { directory, provider, config, output: path.join(directory, "run") };
}

await test(
  "one real Pi accepts two whole goals in one session with fresh endpoint checks and no corrections",
  { timeout: 120000 },
  async (t) => {
    let turns = 0;
    const f = await fixture("success", (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const edits = [
        "from pathlib import Path; p=Path('/workspace/main.cpp'); p.write_text(p.read_text().replace('int Sample(int wrong) { return wrong + 1; }', 'int Sample(int index) { return index + 1; }'))",
        "from pathlib import Path; p=Path('/workspace/main.cpp'); p.write_text(p.read_text().replace('int Sample(int index)', 'int sample(int index)').replace('frond::Sample(scene)', 'frond::sample(scene)'))",
      ];
      const edit = edits[turns++];
      assert.ok(edit, "No later task may be delivered");
      return { command: `python3 -c ${JSON.stringify(edit)}` };
    });
    t.after(() => f.provider.close());
    const report = await runCoherent(preparation, f.output, {
      configPath: f.config,
    });
    assert.equal(report.profile, "coherent");
    assert.equal(report.policy.trialTimeoutMs, null);
    assert.equal(report.policy.attemptTimeoutMs, null);
    assert.equal(report.status, "pass");
    assert.equal(report.acceptedTasks, 2);
    assert.equal(report.deliveries, 2);
    assert.equal(report.repairs, 0);
    assert.equal(report.agentClosed, true);
    assert.equal(turns, 2);
    assert.equal(report.checks.length, 3);
    assert.ok(report.checks.every((check) => check.status === "pass"));
    assert.equal(
      await readFile(path.join(f.output, "workspace/main.cpp"), "utf8"),
      final["main.cpp"],
    );
    for (const key of ["agentPid", "sessionId", "lifetime"])
      assert.equal(new Set(report.chain.attempts.map((attempt) => attempt.execution[key])).size, 1);
    await assert.rejects(access(path.join(f.output, "agent-state/pi/auth.json")), {
      code: "ENOENT",
    });
  },
);

await test(
  "one real Pi retains failed edits, repairs one complete goal, then exhausts three corrections without accepting partial progress",
  { timeout: 120000 },
  async (t) => {
    let turns = 0;
    const f = await fixture("repair-block", (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      turns++;
      const edit =
        turns === 1
          ? "printf retained > /workspace/retained.txt"
          : turns === 2
            ? `test -f /workspace/retained.txt && python3 -c ${JSON.stringify("from pathlib import Path; p=Path('/workspace/main.cpp'); p.write_text(p.read_text().replace('int Sample(int wrong) { return wrong + 1; }', 'int Sample(int index) { return index + 1; }'))")}`
            : "printf failed-goal\\n >> /workspace/attempts.txt";
      return { command: edit };
    });
    t.after(() => f.provider.close());
    const report = await runCoherent(preparation, f.output, { configPath: f.config });
    assert.equal(report.status, "blocked");
    assert.equal(report.acceptedTasks, 1);
    assert.equal(report.deliveries, 6);
    assert.equal(report.repairs, 4);
    assert.equal(report.agentClosed, true);
    assert.equal(
      await readFile(path.join(f.output, "workspace/main.cpp"), "utf8"),
      first["main.cpp"],
    );
    assert.equal(await readFile(path.join(f.output, "workspace/retained.txt"), "utf8"), "retained");
    for (const key of ["agentPid", "sessionId", "lifetime"])
      assert.equal(new Set(report.chain.attempts.map((attempt) => attempt.execution[key])).size, 1);
    const failed = report.checks.find((check) => check.contractId === tasks[1].id);
    assert.ok(failed.obligations.passed < failed.obligations.total);
    assert.equal(report.chain.steps[1].status, "blocked");
    await assert.rejects(access(path.join(f.output, "agent-state/pi/auth.json")), {
      code: "ENOENT",
    });
  },
);

await test(
  "the untimed default closes real Pi and active shell children on user cancellation without publishing a proof",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture("diagnostic-cancel", () => ({
      command:
        "(sleep 3; printf late > /workspace/late.txt) & printf retained > /workspace/started.txt; wait",
    }));
    t.after(() => f.provider.close());
    const user = new AbortController();
    let settled = false;
    const running = runCoherent(preparation, f.output, {
      configPath: f.config,
      signal: user.signal,
    }).finally(() => {
      settled = true;
    });
    t.after(() => user.abort());
    for (;;) {
      try {
        await access(path.join(f.output, "workspace/started.txt"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        assert.equal(settled, false, "Untimed run stopped before user cancellation");
        await delay(20);
      }
    }
    user.abort();
    const report = await running;
    assert.equal(report.profile, "coherent");
    assert.equal(report.policy.trialTimeoutMs, null);
    assert.equal(report.policy.attemptTimeoutMs, null);
    assert.equal(report.status, "cancelled");
    assert.equal(report.agentClosed, true);
    assert.equal(report.chain.attempts[0].after, report.chain.attempts[0].before);
    assert.equal(await readFile(path.join(f.output, "workspace/started.txt"), "utf8"), "retained");
    await delay(3500);
    await assert.rejects(access(path.join(f.output, "workspace/late.txt")), { code: "ENOENT" });
    await assert.rejects(access(path.join(f.output, "agent-state/pi/auth.json")), {
      code: "ENOENT",
    });
    await assert.rejects(access(path.join(f.output, "verification.json")), { code: "ENOENT" });
  },
);
await test(
  "the total deadline stops initial grading before any real Pi inference",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture("initial-timeout", () => {
      throw Error("No inference allowed");
    });
    t.after(() => f.provider.close());
    const report = await runCoherent(preparation, f.output, {
      configPath: f.config,
      profile: "coherent-hour",
      hourLimitMs: 1,
    });
    assert.equal(report.status, "timeout");
    assert.equal(report.acceptedTasks, 0);
    assert.equal(report.deliveries, 0);
    assert.equal(f.provider.requests.length, 0);
  },
);

await test(
  "a real deadline closes the same Pi and shell children while retaining completed edits",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture("active-timeout", () => ({
      command:
        "(sleep 20; printf late > /workspace/late.txt) & printf started > /workspace/started.txt; wait",
    }));
    t.after(() => f.provider.close());
    const report = await runCoherent(preparation, f.output, {
      configPath: f.config,
      profile: "coherent-hour",
      hourLimitMs: 10000,
    });
    assert.equal(report.status, "timeout");
    assert.equal(report.agentClosed, true);
    assert.equal(report.acceptedTasks, 0);
    assert.equal(report.deliveries, 1);
    assert.equal(await readFile(path.join(f.output, "workspace/started.txt"), "utf8"), "started");
    assert.ok(report.elapsedMs < 15000);
    await delay(21000);
    await assert.rejects(access(path.join(f.output, "workspace/late.txt")), { code: "ENOENT" });
    await assert.rejects(access(path.join(f.output, "agent-state/pi/auth.json")), {
      code: "ENOENT",
    });
  },
);
