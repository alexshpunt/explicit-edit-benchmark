import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, renameSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { runRestoring } from "../../src/suites/explicit-edit-multi-agent/execution/restoring-run.mjs";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import { appendCoherentNamingTask } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import {
  scopedNamingSession,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { coherentNamingPlans } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-naming-plans.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import { scoreRounds } from "../../src/suites/explicit-edit-multi-agent/grading/round-score.mjs";
import {
  treeIdentity,
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const root = process.env.RENDERER_RESTORING_OUTPUT;
assert.ok(root && process.env.RENDERER_PI_RUNTIME);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

// The first type rename produces every later signature. Its singleton attempts
// rotate the assigned participant while the other real participant remains idle.
async function prepareFixture() {
  await mkdir(root);
  const original = path.join(root, "original");
  await mkdir(path.join(original, "contracts"), { recursive: true });
  await mkdir(path.join(original, "naming-plans"));
  const names = ["Alpha", "Beta", "Gamma", "Delta"];
  const source = `#include <fstream>
#include <string>
namespace frond {
struct OldRecord { int member; };
${names.map((name, i) => `int ${name}(const OldRecord& wrong) { return wrong.member + ${i + 1}; }\nint Use${name}(int value) { return frond::${name}({value}); }`).join("\n")}
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
  const tasks = [],
    edits = new Map(),
    contractHashes = {},
    namingPlanHashes = {};
  let current = source;
  async function checkpoint(id) {
    const bytes = JSON.stringify(prepareCoherentContract({ "main.cpp": current })) + "\n";
    contractHashes[id] = digest(bytes);
    await writeFile(path.join(original, "contracts", `${id}.json`), bytes);
  }
  async function naming(category, mapping, selectors, changes) {
    const before = { "main.cpp": current };
    const analysis = path.join(root, `naming-analysis-${tasks.length}`);
    await mkdir(analysis);
    const session = await scopedNamingSession(before, analysis);
    let certification;
    try {
      certification = await session.atomicPlans({
        id: `fixture-${tasks.length}`,
        phase: "names",
        category,
        mapping,
        selectors,
      });
    } finally {
      session.close();
    }
    const plans = coherentNamingPlans(before, [certification.plan], [], [certification]);
    appendCoherentNamingTask(tasks, category, "main.cpp", [certification.operation]);
    const id = tasks.at(-1).id;
    const bytes = JSON.stringify(plans) + "\n";
    namingPlanHashes[id] = digest(bytes);
    await writeFile(path.join(original, "naming-plans", `${id}.json`), bytes);
    edits.set(JSON.stringify(mapping), changes);
    for (const [old, renamed] of changes) current = current.replaceAll(old, renamed);
    assert.deepEqual(applyScopedNamePlan(before, certification.plan), { "main.cpp": current });
    await checkpoint(id);
  }
  await checkpoint("initial");
  await naming(
    "functions-types",
    [{ from: "OldRecord", to: "Record" }],
    [{ kind: "type", scope: "frond::OldRecord" }],
    [["OldRecord", "Record"]],
  );
  for (const category of ["locals-parameters", "functions-types"]) {
    for (const [i, name] of names.entries()) {
      const parameter = category === "locals-parameters";
      const to = parameter ? `p${i}` : name.toLowerCase();
      await naming(
        category,
        [{ from: parameter ? "wrong" : name, to }],
        [
          {
            kind: "function",
            scope: `frond::${name}`,
            signature: "int (const Record &)",
            definition: true,
          },
        ],
        parameter
          ? [
              [
                `int ${name}(const Record& wrong) { return wrong.member`,
                `int ${name}(const Record& ${to}) { return ${to}.member`,
              ],
            ]
          : [
              [`int ${name}(`, `int ${to}(`],
              [`frond::${name}(`, `frond::${to}(`],
            ],
      );
    }
  }
  await writeTree(path.join(original, "initial"), { "main.cpp": source });
  const taskBytes = JSON.stringify(tasks) + "\n";
  await writeFile(path.join(original, "tasks.json"), taskBytes);
  const pixels = await buildCoherentCandidate(
    path.join(original, "initial"),
    path.join(root, "golden"),
    { "main.cpp": source },
  );
  const final = { "main.cpp": current };
  await writeFile(
    path.join(original, "manifest.json"),
    JSON.stringify({
      version: "renderer-coherent-v1",
      initial: treeIdentity({ "main.cpp": source }),
      final: treeIdentity(final),
      tasks: tasks.length,
      tasksSha256: digest(taskBytes),
      contractHashes,
      namingPlanHashes,
      pixels,
    }) + "\n",
  );
  assert.equal((await runCoherent(original, path.join(root, "coherent-proof"))).status, "pass");
  const preparation = path.join(root, "preparation");
  assert.equal((await prepareConcurrent(original, preparation)).graphWidth, names.length);
  return { preparation, final, edits };
}

function textOf(content) {
  return typeof content === "string"
    ? content
    : content
        .filter(({ type }) => type === "text")
        .map(({ text }) => text)
        .join("\n");
}
function rowsOf(message) {
  return textOf(message.content)
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}
function mutation(changes) {
  return `python3 - <<'PY'
from pathlib import Path
import fcntl
with open('/workspace/.fixture-lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    p=Path('/workspace/main.cpp')
    text=p.read_text()
    for before,after in ${JSON.stringify(changes)}:
        assert before in text
        text=text.replace(before,after)
    p.write_text(text)
PY`;
}

await test("the real restoring entry point keeps two Pi lifetimes through six editing failures, canonical healing and later success", async (t) => {
  const { preparation, final, edits } = await prepareFixture();
  const reference = path.join(root, "reference");
  const verified = await runRestoring(preparation, reference, { agents: 2, batchSize: 1 });
  assert.equal(verified.status, "complete");
  assert.equal(verified.schedule[0].assignments.length, 1);
  assert.equal(verified.rounds.length, verified.totalRounds);
  assert.ok(
    verified.rounds.every(
      ({ attempts }) => attempts.length === 1 && attempts[0].passedAtoms === attempts[0].totalAtoms,
    ),
  );
  const proofPath = path.join(reference, "verification.json");
  assert.equal((await json(proofPath)).status, "pass");
  let displacing = false,
    commandOverride = null,
    inferenceHook = null;
  const provider = await providerFixture(root, (body) => {
    if (body.messages.at(-1).role === "tool") return {};
    inferenceHook?.();
    if (commandOverride) return { command: commandOverride };
    if (displacing) return { command: "true" };
    const users = body.messages.filter(({ role }) => role === "user");
    const restored = users
      .flatMap(rowsOf)
      .some((row) =>
        row.restoredRounds?.some(
          ({ round, reason }) =>
            round === verified.schedule[0].id && reason === "editing-exhausted",
        ),
      );
    if (!restored) return { command: "printf '\\n// failed-edit\\n' >> /workspace/main.cpp" };
    const target = rowsOf(users.at(-1)).find((row) => row.mapping?.length && row.selectors?.length);
    assert.ok(target);
    const changes = edits.get(JSON.stringify(target.mapping));
    assert.ok(changes);
    return { command: mutation(changes) };
  });
  t.after(() => provider.close());
  const configPath = path.join(root, "native-config.json");
  await writeFile(configPath, JSON.stringify(provider.config) + "\n");

  // A foreign proof must reject before opening either Pi process or inference.
  const foreign = await json(proofPath);
  foreign.identity.batchSize++;
  const foreignPath = path.join(root, "foreign-proof.json");
  await writeFile(foreignPath, JSON.stringify(foreign));
  await assert.rejects(
    runRestoring(preparation, path.join(root, "rejected"), {
      agents: 2,
      batchSize: 1,
      configPath,
      proofPath: foreignPath,
      allowModelCalls: true,
    }),
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(provider.errors.length, 0);

  const output = path.join(root, "measured");
  const dispatchTrace = [];
  const activity = (agent) => {
    const text = readFileSync(path.join(output, `agent-${agent}-events.jsonl`), "utf8");
    // Native writers may be active; inspect complete records here. The complete
    // saved stream is parsed and checked again after all deliveries below.
    const events = text
      .split("\n")
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    return {
      contexts: events.filter(
        (event) => event.type === "baseline_observation" && event.event === "context",
      ).length,
      tools: events.filter(({ type }) => type === "tool_execution_start").length,
    };
  };
  const report = await runRestoring(preparation, output, {
    agents: 2,
    batchSize: 1,
    configPath,
    proofPath,
    allowModelCalls: true,
    onCase(event) {
      dispatchTrace.push({ ...event, activity: [activity(0), activity(1)] });
    },
  });
  assert.equal(report.status, "complete");
  assert.deepEqual(report.agentsClosed, [true, true]);
  assert.deepEqual(await readTree(path.join(output, "workspace")), final);
  assert.equal(report.final, report.expectedFinal);
  assert.equal(provider.errors.length, 0);
  const first = report.rounds[0];
  assert.equal(first.attempts.length, 6);
  assert.equal(first.firstAttempt, 1);
  assert.equal(first.finalAttempt, 6);
  assert.equal(first.restoration.reason, "editing-exhausted");
  let priorComments = 0;
  for (const outcome of first.attempts) {
    assert.equal(outcome.passedAtoms, 0);
    assert.equal(outcome.buildPassed, true);
    assert.equal(outcome.resultMatched, true);
    assert.equal(outcome.integrityPassed, false);
    const source = await readFile(
      path.join(
        output,
        "checks",
        `${first.round}-attempt-${outcome.attempt}`,
        "candidate/source/main.cpp",
      ),
      "utf8",
    );
    const count = source.split("// failed-edit").length - 1;
    assert.ok(count > priorComments);
    assert.equal(
      count,
      report.executions.filter((row) => row.round === first.round && row.attempt <= outcome.attempt)
        .length,
    );
    priorComments = count;
  }
  assert.equal(
    (
      await readFile(path.join(output, "restorations", first.round, "source/main.cpp"), "utf8")
    ).includes("failed-edit"),
    false,
  );
  assert.equal(report.rounds.length, report.totalRounds);
  for (const row of report.rounds.slice(1)) {
    assert.equal(row.attempts.length, 1);
    assert.equal(row.attempts[0].passedAtoms, row.attempts[0].totalAtoms);
    for (const key of ["buildPassed", "resultMatched", "integrityPassed"])
      assert.equal(row.attempts[0][key], true);
    assert.equal(row.restoration.reason, "passed");
  }
  const scored = scoreRounds(
    report.rounds.map((row) => ({ round: row.round, ...row.attempts.at(-1) })),
    report.totalRounds,
    report.policy,
  );
  assert.equal(scored.score, (100 * (report.totalRounds - 1)) / report.totalRounds);
  const originals = report.executions.flatMap(({ atomicIds }) => atomicIds);
  assert.equal(originals.length, report.totalAtoms);
  assert.equal(new Set(originals).size, report.totalAtoms);
  assert.ok(report.repairs >= 5);

  const participants = report.participants;
  assert.equal(new Set(participants.map(({ lifetime }) => lifetime)).size, 2);
  assert.equal(new Set(participants.map(({ sessionId }) => sessionId)).size, 2);
  assert.equal(new Set(participants.map(({ process }) => process.agentHostPid)).size, 2);
  assert.equal(new Set(participants.map(({ process }) => process.namespace)).size, 2);
  for (const [agent, participant] of participants.entries()) {
    const deliveries = report.executions.filter((row) => row.agent === agent);
    assert.ok(deliveries.length);
    assert.ok(
      deliveries.every(
        ({ receipt }) =>
          receipt.lifetime === participant.lifetime && receipt.sessionId === participant.sessionId,
      ),
    );
    for (const restored of report.rounds) {
      const roundIndex = report.rounds.indexOf(restored);
      const next = deliveries.find(
        (row) => report.rounds.findIndex(({ round }) => round === row.round) > roundIndex,
      );
      const carrying = deliveries.filter((row) =>
        row.restorationNotices.some(({ round }) => round === restored.round),
      );
      assert.deepEqual(carrying, next ? [next] : []);
      if (next)
        assert.deepEqual(
          next.restorationNotices.find(({ round }) => round === restored.round),
          { round: restored.round, ...restored.restoration },
        );
    }
  }
  const firstBarriers = report.atomicBarriers.filter(({ round }) => round === first.round);
  assert.equal(firstBarriers.length, 6);
  for (const state of report.atomicBarriers) {
    const deliveries = report.executions.filter(
      (row) => row.round === state.round && row.attempt === state.attempt,
    );
    const trace = dispatchTrace.filter(
      (row) => row.round === state.round && row.attempt === state.attempt,
    );
    assert.ok(trace.length > 0);
    for (const [agent, queue] of state.queues.entries()) {
      const assigned = deliveries.filter((row) => row.agent === agent);
      assert.deepEqual(
        assigned.flatMap((row) => (state.attempt === 1 ? row.atomicIds : row.repairIds)),
        queue,
      );
      if (queue.length === 0) {
        assert.equal(assigned.length, 0);
        for (const observed of trace)
          assert.deepEqual(observed.activity[agent], trace[0].activity[agent]);
      }
    }
  }
  assert.deepEqual(
    firstBarriers.map(({ queues }) => {
      assert.equal(queues.filter((queue) => queue.length).length, 1);
      return queues.findIndex((queue) => queue.length);
    }),
    Array.from({ length: 6 }, (_, attempt) => (report.executions[0].agent + attempt) % 2),
  );
  assert.equal(provider.requests.length, report.executions.length * 2);
  assert.ok(
    report.executions
      .filter(({ deliveryKind }) => deliveryKind === "barrier-repair")
      .every(({ atomicIds }) => atomicIds.length === 0),
  );
  for (const agent of [0, 1]) {
    const events = (await readFile(path.join(output, `agent-${agent}-events.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const observations = events.filter(({ type }) => type === "baseline_observation");
    assert.ok(observations.length > 1);
    assert.ok(
      observations.every(
        ({ lifetime, sessionId }) =>
          lifetime === participants[agent].lifetime && sessionId === participants[agent].sessionId,
      ),
    );
    assert.equal(
      events.filter(({ type }) => type === "tool_execution_start").length,
      report.executions.filter((row) => row.agent === agent).length,
    );
    assert.equal(
      events.filter(({ type, isError }) => type === "tool_execution_end" && isError).length,
      0,
    );
  }
  const nativeOptions = { agents: 2, batchSize: 1, configPath, proofPath, allowModelCalls: true };
  const stopped = (result, category) => {
    assert.equal(result.status, category);
    assert.equal(result.terminal.category, category);
    assert.deepEqual(result.agentsClosed, [true, true]);
    assert.equal(result.rounds.length, 0);
    assert.equal(result.repairs, 0);
    assert.equal(result.finalEvidence.status, "captured");
  };
  await t.test(
    "a real idle participant death terminates the run without restarting or healing",
    async () => {
      displacing = true;
      const destination = path.join(root, "dead-participant");
      let killed = false;
      const result = await runRestoring(preparation, destination, {
        ...nativeOptions,
        onCase({ event }) {
          if (event !== "case-end" || killed) return;
          const saved = JSON.parse(readFileSync(path.join(destination, "report.json"), "utf8"));
          const participant = saved.participants[1].process;
          const pid = participant.agentHostPid;
          assert.ok(Number.isSafeInteger(pid) && pid > 1);
          assert.equal(readlinkSync(`/proc/${pid}/ns/pid`), participant.namespace);
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          assert.equal(
            stat
              .slice(stat.lastIndexOf(")") + 2)
              .trim()
              .split(/\s+/)[19],
            participant.agentStart,
          );
          process.kill(pid, "SIGKILL");
          killed = true;
        },
      });
      assert.equal(killed, true);
      stopped(result, "driver_exit");
      assert.equal(result.participants.length, 2);
    },
  );
  await t.test(
    "cancellation during an actual native inference is not editing exhaustion",
    async () => {
      const controller = new AbortController();
      let cancelled = false;
      inferenceHook = () => {
        inferenceHook = null;
        cancelled = true;
        controller.abort(new Error("Fixture cancellation"));
      };
      try {
        const result = await runRestoring(preparation, path.join(root, "cancelled"), {
          ...nativeOptions,
          signal: controller.signal,
        });
        assert.equal(cancelled, true);
        stopped(result, "cancelled");
      } finally {
        inferenceHook = null;
      }
    },
  );
  await t.test(
    "a real detached native writer is infrastructure and is drained without canonical healing",
    async () => {
      const destination = path.join(root, "late-writer");
      commandOverride =
        "(sleep 5; printf late > /workspace/late) >/tmp/fixture-background.log 2>&1 </dev/null &";
      try {
        const result = await runRestoring(preparation, destination, nativeOptions);
        stopped(result, "infrastructure");
        await delay(5100);
        await assert.rejects(
          access(path.join(destination, "workspace/late")),
          (error) => error.code === "ENOENT",
        );
      } finally {
        commandOverride = null;
      }
    },
  );
  await t.test(
    "actual filesystem restoration failure preserves six failures without a restored-round score",
    async () => {
      assert.notEqual(process.geteuid(), 0);
      const destination = path.join(root, "restore-denied");
      const blocker = path.join(destination, "workspace/blocker");
      commandOverride =
        "mkdir -p /workspace/blocker; printf fixture > /workspace/blocker/note.txt; chmod 0500 /workspace/blocker";
      t.after(async () => {
        try {
          await chmod(blocker, 0o700);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      });
      let result;
      try {
        result = await runRestoring(preparation, destination, nativeOptions);
      } finally {
        commandOverride = null;
      }
      assert.equal(result.status, "infrastructure");
      assert.equal(result.terminal.category, "infrastructure");
      assert.deepEqual(result.agentsClosed, [true, true]);
      assert.equal(result.rounds.length, 0);
      assert.ok(result.repairs >= 5);
      for (let attempt = 1; attempt <= 6; attempt++) {
        const outcome = await json(
          path.join(
            destination,
            "checks",
            `${verified.schedule[0].id}-attempt-${attempt}`,
            "outcome.json",
          ),
        );
        assert.equal(outcome.attempt, attempt);
        assert.equal(outcome.passedAtoms, 0);
        assert.equal(outcome.buildPassed, true);
        assert.equal(outcome.resultMatched, true);
      }
      await assert.rejects(
        access(path.join(destination, "restorations", verified.schedule[0].id, "restoration.json")),
        (error) => error.code === "ENOENT",
      );
    },
  );
  await t.test(
    "loss of the workspace preserves the operational failure when final capture also fails",
    async () => {
      displacing = true;
      const interruptedOutput = path.join(root, "workspace-lost");
      let displaced = false;
      const interrupted = await runRestoring(preparation, interruptedOutput, {
        agents: 2,
        batchSize: 1,
        configPath,
        proofPath,
        allowModelCalls: true,
        onCase({ event }) {
          if (event !== "case-end" || displaced) return;
          renameSync(
            path.join(interruptedOutput, "workspace"),
            path.join(interruptedOutput, "displaced-workspace"),
          );
          displaced = true;
        },
      });
      assert.equal(displaced, true);
      assert.equal(interrupted.status, "infrastructure");
      assert.equal(interrupted.terminal.category, "infrastructure");
      assert.equal(interrupted.terminal.code, "ENOENT");
      assert.equal(interrupted.final, null);
      assert.equal(interrupted.finalEvidence.status, "error");
      assert.equal(interrupted.finalEvidence.code, "ENOENT");
      assert.deepEqual(interrupted.agentsClosed, [true, true]);
      assert.equal(interrupted.rounds.length, 0);
      assert.equal(interrupted.repairs, 0);
      assert.equal(
        (await json(path.join(interruptedOutput, "report.json"))).status,
        "infrastructure",
      );
    },
  );
});
