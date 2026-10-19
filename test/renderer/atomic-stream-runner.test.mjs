import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import { coherentTaskPrompt } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quiet = () => {};

function assertInputTrace(report) {
  for (const barrier of report.atomicBarriers) {
    assert.ok(Array.isArray(barrier.inputChecks), "Every barrier retains its actual input checks");
    for (const check of barrier.inputChecks) {
      assert.ok(typeof check.atomicId === "string");
      assert.ok(check.startedMs >= 0 && check.elapsedMs >= 0);
      assert.ok(["pass", "fail", "pending", "aborted", "error"].includes(check.decision));
      assert.ok(Array.isArray(check.observations));
      for (const observation of check.observations) {
        assert.deepEqual(Object.keys(observation).sort(), ["atomicId", "mode", "reason", "status"]);
        assert.ok(
          ["prerequisite-output", "current-output", "current-input", "continuation"].includes(
            observation.mode,
          ),
        );
        if (observation.mode === "continuation") {
          assert.equal(observation.status, "waived");
          assert.equal(observation.reason, "already-started");
        }
      }
    }
  }
}

async function prepareFixture(root) {
  const names = ["North", "South", "West"];
  const initial = {
    "main.cpp": `#include <fstream>
#include <string>
${names.map((name, index) => `#ifndef ${name.toUpperCase()}_H\n#define ${name.toUpperCase()}_H\ninline int ${name}(int value) { return value + ${index + 1}; }\n#endif`).join("\n")}
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int scene = 0; scene < 2; scene++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = float(i % 17 + North(scene) + South(scene) + West(scene));
    std::ofstream file(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    file.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`,
  };
  const operations = names.map((name) => ({
    id: `header-${name.toLowerCase()}`,
    phase: "structure",
    action: "header",
    file: `${name.toLowerCase()}.h`,
    guard: `${name.toUpperCase()}_H`,
    includes: [],
  }));
  const tasks = [operations.slice(0, 2), operations.slice(2)].map((selected, index) => {
    const goal = `Extract ${selected.map((operation) => operation.file).join(" and ")}`;
    return {
      id: `task-00${index + 1}`,
      phase: "structure",
      subsystem: `interfaces-${index}`,
      goal,
      operations: selected,
      prompt: coherentTaskPrompt(goal, selected),
    };
  });
  const coherent = path.join(root, "coherent");
  await mkdir(path.join(coherent, "contracts"), { recursive: true });
  await writeTree(path.join(coherent, "initial"), initial);
  const contractHashes = {};
  let expected = initial;
  async function checkpoint(id) {
    const bytes = JSON.stringify(prepareCoherentContract(expected)) + "\n";
    contractHashes[id] = digest(bytes);
    await writeFile(path.join(coherent, "contracts", `${id}.json`), bytes);
  }
  await checkpoint("initial");
  for (const task of tasks) {
    expected = task.operations.reduce(applyCoherentStructure, expected);
    await checkpoint(task.id);
  }
  const bytes = JSON.stringify(tasks) + "\n";
  await writeFile(path.join(coherent, "tasks.json"), bytes);
  const pixels = await buildCoherentCandidate(
    path.join(coherent, "initial"),
    path.join(root, "golden"),
    initial,
  );
  await writeFile(
    path.join(coherent, "manifest.json"),
    JSON.stringify({
      version: "renderer-coherent-v1",
      initial: treeIdentity(initial),
      final: treeIdentity(expected),
      tasks: tasks.length,
      tasksSha256: digest(bytes),
      contractHashes,
      pixels,
    }),
  );
  const sequential = await runCoherent(coherent, path.join(root, "sequential"), { log: quiet });
  assert.equal(sequential.status, "pass");
  const preparation = path.join(root, "prepared");
  const manifest = await prepareConcurrent(coherent, preparation);
  assert.equal(manifest.graphWidth, 2);
  assert.equal(manifest.atomic.edits, 3);
  return { preparation, expected, pixels };
}

function currentHeader(prompt) {
  const rows = prompt.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const targets = rows.filter((row) => typeof row.guard === "string");
  assert.equal(
    targets.length,
    1,
    "Each delivery must contain one current edit, not its parent batch",
  );
  assert.ok(!prompt.includes("bindingCertification") && !prompt.includes("naming-plans"));
  return { phase: "structure", action: "header", ...targets[0] };
}

async function waitForPeer(ready, signal) {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([ready, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function deterministicDrivers({ skipFirstNorth = false, breakBuild = false } = {}) {
  const histories = [];
  const calls = [];
  let writes = Promise.resolve();
  const both = Promise.withResolvers();
  const peer = Promise.withResolvers();
  const createDriver = async (workspace, _state, agent) => {
    const history = [];
    histories[agent] = history;
    let closed = false;
    return {
      get closed() {
        return closed;
      },
      async execute(prompt, options) {
        assert.equal(closed, false);
        history.push({ prompt, ...options });
        calls.push({ agent, prompt, ...options });
        if (options.deliveryKind === "barrier-repair") {
          assert.equal(options.atomicId, undefined);
          assert.ok(
            !prompt.includes("Target table"),
            "Global repair must not resend the atom inventory",
          );
          writes = writes.then(async () => {
            const file = path.join(workspace, "main.cpp");
            const text = await readFile(file, "utf8");
            assert.ok(!text.includes("#include <fstream>"));
            await writeFile(file, "#include <fstream>\n" + text);
          });
          await writes;
        } else {
          const operation = currentHeader(prompt);
          if (calls.length === 2) both.resolve();
          await waitForPeer(both.promise, options.signal);
          if (skipFirstNorth && operation.guard === "NORTH_H" && options.attempt === 1) {
            await waitForPeer(peer.promise, options.signal);
          } else {
            writes = writes.then(async () => {
              const edited = applyCoherentStructure(await readTree(workspace), operation);
              if (breakBuild && operation.guard === "WEST_H")
                edited["main.cpp"] = edited["main.cpp"].replace("#include <fstream>\n", "");
              for (const [file, source] of Object.entries(edited))
                await writeFile(path.join(workspace, file), source);
            });
            await writes;
            if (operation.guard !== "NORTH_H") peer.resolve();
          }
        }
        return { sessionId: `participant-${agent}`, sequence: history.length, status: "settled" };
      },
      async close() {
        closed = true;
      },
    };
  };
  return { createDriver, histories, calls };
}

await test(
  "partial atomic runner with three edits and two scoring groups",
  { timeout: 90_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/atomic-stream-runner-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { preparation, expected, pixels } = await prepareFixture(root);
    const caseEvents = [];
    const reference = await runConcurrent(preparation, path.join(root, "reference"), {
      log: quiet,
      onCase: (event) => caseEvents.push(event),
    });
    assert.equal(reference.status, "pass", JSON.stringify(reference.terminal));
    assert.equal(reference.deliveries, 3);
    assert.equal(reference.acceptedTasks, 2);
    assert.equal(reference.acceptedRounds, 1);
    assert.equal(caseEvents.length, 6);
    for (const execution of reference.executions)
      assert.deepEqual(
        caseEvents.filter((event) => event.id === execution.atomicId),
        [
          {
            event: "case-start",
            id: execution.atomicId,
            phase: "atomic",
            round: "round-001",
            attempt: 1,
          },
          {
            event: "case-end",
            id: execution.atomicId,
            phase: "atomic",
            status: "pass",
            round: "round-001",
            attempt: 1,
          },
        ],
      );
    assert.equal(new Set(reference.executions.map((row) => row.receipts[0].lifetime)).size, 2);
    assert.ok(reference.executions.some((row) => row.receipts[0].delivered === 2));
    const proofFile = path.join(preparation, "verification-2.json");
    const proof = JSON.parse(await readFile(proofFile, "utf8"));
    assert.deepEqual(proof.atomic, reference.atomic);
    assert.equal(proof.acceptedAtomicEdits, 3);
    assert.equal(proof.agents, 2);

    await t.test(
      "free persistent participants receive only the current atom and retain their histories",
      async () => {
        const drivers = deterministicDrivers();
        const report = await runConcurrent(preparation, path.join(root, "live"), {
          ...drivers,
          log: quiet,
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        assert.equal(report.deliveries, 3);
        assert.equal(report.acceptedTasks, 2);
        assert.equal(
          report.repairs,
          0,
          JSON.stringify({
            executions: report.executions,
            barriers: report.atomicBarriers,
            checks: report.checks,
          }),
        );
        assert.equal(new Set(drivers.calls.map((row) => row.atomicId)).size, 3);
        assert.equal(drivers.histories.filter((history) => history.length === 2).length, 1);
        assert.ok(report.agentsClosed.every(Boolean));
        assertInputTrace(report);
        assert.ok(
          report.atomicBarriers[0].inputChecks.some(
            (check) =>
              check.decision === "pass" &&
              check.observations.some(
                (row) => row.mode === "current-input" && row.status === "pass",
              ) &&
              check.observations.some(
                (row) => row.mode === "current-output" && row.status === "fail",
              ),
          ),
        );
        const saved = JSON.parse(await readFile(path.join(root, "live/report.json"), "utf8"));
        assert.deepEqual(saved.atomicBarriers[0].inputChecks, report.atomicBarriers[0].inputChecks);
        assert.deepEqual(await readTree(path.join(root, "live/workspace")), expected);
        assert.deepEqual(report.checks.at(-1).pixels, pixels);
      },
    );

    await t.test(
      "one failed atomic output receives a correction without repeating the verified peer",
      async () => {
        // An intermittent run recorded only one NORTH delivery. Repeat this tiny
        // filesystem scenario without repeating expensive fixture preparation.
        for (let repetition = 0; repetition < 6; repetition++) {
          const output = path.join(root, `corrected-${repetition}`);
          const drivers = deterministicDrivers({ skipFirstNorth: true });
          const report = await runConcurrent(preparation, output, {
            ...drivers,
            log: quiet,
          });
          assert.equal(report.status, "pass", JSON.stringify(report.terminal));
          const byGuard = (guard) =>
            drivers.calls.filter((row) => currentHeader(row.prompt).guard === guard);
          assert.equal(
            byGuard("NORTH_H").length,
            2,
            JSON.stringify({
              repetition,
              calls: drivers.calls.map(({ atomicId, attempt }) => ({ atomicId, attempt })),
              executions: report.executions,
              barriers: report.atomicBarriers,
              checks: report.checks,
            }),
          );
          assert.equal(byGuard("SOUTH_H").length, 1);
          assert.equal(byGuard("WEST_H").length, 1);
          assert.equal(report.deliveries, 4);
          assert.deepEqual(
            byGuard("NORTH_H").map((row) => row.attempt),
            [1, 2],
            "The failed atom must get its first opportunity before spending a correction",
          );
          assert.equal(report.repairs, drivers.calls.filter((row) => row.attempt > 1).length);
          assertInputTrace(report);
          const north = byGuard("NORTH_H")[0].atomicId;
          assert.ok(
            report.atomicBarriers[1].inputChecks.some(
              (check) =>
                check.atomicId === north &&
                check.decision === "pass" &&
                check.observations.some(
                  (row) => row.mode === "continuation" && row.status === "waived",
                ),
            ),
          );
          assert.equal(report.acceptedTasks, 2);
          assert.equal(
            report.checks.find((check) => check.status === "fail").category,
            "structure",
          );
          // Failure drains existing deliveries, but does not require WEST to
          // have started. Retain every verified peer, whichever finishes first.
          const verifiedPeers = report.executions.filter(
            (row) => row.attempt === 1 && row.atomicCheck?.status === "pass",
          );
          assert.ok(verifiedPeers.length > 0, "The correction must retain a verified peer");
          assert.deepEqual(
            [...report.atomicBarriers[1].retained].sort(),
            verifiedPeers.map((row) => row.atomicId).sort(),
            JSON.stringify({
              repetition,
              executions: report.executions,
              barriers: report.atomicBarriers,
            }),
          );
          assert.deepEqual(await readTree(path.join(output, "workspace")), expected);
        }
      },
    );

    await t.test(
      "a drained build failure gets one global repair without redispatching completed atoms",
      async () => {
        const drivers = deterministicDrivers({ breakBuild: true });
        const report = await runConcurrent(preparation, path.join(root, "barrier-repair"), {
          ...drivers,
          log: quiet,
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        assert.equal(report.deliveries, 4);
        assert.equal(report.repairs, 1);
        assert.equal(report.acceptedTasks, 2);
        assertInputTrace(report);
        assert.deepEqual(
          report.atomicBarriers[1].inputChecks,
          [],
          "Global repair must not fabricate atom eligibility checks",
        );
        const atoms = report.executions.filter((row) => row.atomicId);
        assert.equal(atoms.length, 3);
        assert.ok(atoms.every((row) => row.attempt === 1 && row.atomicCheck.status === "pass"));
        const repairs = report.executions.filter((row) => row.deliveryKind === "barrier-repair");
        assert.equal(repairs.length, 1);
        assert.equal(repairs[0].atomicId, undefined);
        assert.equal(repairs[0].attempt, 2);
        assert.deepEqual(repairs[0].tasks, ["task-001", "task-002"]);
        assert.equal(report.checks.find((check) => check.status === "fail").category, "build");
        assert.deepEqual(await readTree(path.join(root, "barrier-repair/workspace")), expected);
      },
    );

    await t.test(
      "saved input checks identify a controlled prerequisite before dependent dispatch",
      async () => {
        const selected = path.join(root, "dependent-prepared");
        await cp(preparation, selected, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: (file) => path.basename(file) !== "verification-2.json",
        });
        const taskFile = path.join(selected, "atomic/tasks.json");
        const workload = JSON.parse(await readFile(taskFile, "utf8"));
        const byGuard = (guard) =>
          workload.nodes.find((node) => node.operations[0].guard === guard);
        const north = byGuard("NORTH_H");
        const south = byGuard("SOUTH_H");
        // This controlled graph makes an input requirement explicit. Produce a
        // fresh real reference proof instead of relabelling the original proof.
        south.dependencies.push(north.id);
        workload.summary.dependencyEdges++;
        const bytes = JSON.stringify(workload) + "\n";
        await writeFile(taskFile, bytes);
        const manifestFile = path.join(selected, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
        manifest.atomic.workloadSha256 = digest(bytes);
        await writeFile(manifestFile, JSON.stringify(manifest));
        const reference = await runConcurrent(selected, path.join(root, "dependent-reference"), {
          log: quiet,
        });
        assert.equal(reference.status, "pass", JSON.stringify(reference.terminal));
        const drivers = deterministicDrivers();
        const output = path.join(root, "dependent-live");
        const report = await runConcurrent(selected, output, { ...drivers, log: quiet });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        assert.equal(report.deliveries, 3);
        assertInputTrace(report);
        const checks = report.atomicBarriers[0].inputChecks.filter(
          (check) => check.atomicId === south.id,
        );
        const passed = checks.find((check) => check.decision === "pass");
        assert.ok(passed);
        assert.deepEqual(passed.observations[0], {
          atomicId: north.id,
          mode: "prerequisite-output",
          status: "pass",
          reason: null,
        });
        const dependent = report.executions.find((row) => row.atomicId === south.id);
        assert.ok(passed.startedMs + passed.elapsedMs <= dependent.startedMs);
        assert.equal(
          report.executions.find((row) => row.atomicId === north.id).atomicCheck.status,
          "pass",
        );
        const saved = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
        assert.deepEqual(saved.atomicBarriers[0].inputChecks, report.atomicBarriers[0].inputChecks);
      },
    );

    await t.test(
      "wrong reference participant or atomic inventory counts reject before driver startup",
      async () => {
        for (const [field, value, message] of [
          ["agents", 1, /participant count/],
          ["acceptedAtomicEdits", 2, /inventory is incomplete/],
        ]) {
          const output = path.join(root, `invalid-${field}`);
          await writeFile(proofFile, JSON.stringify({ ...proof, [field]: value }));
          let opened = false;
          try {
            await assert.rejects(
              runConcurrent(preparation, output, {
                log: quiet,
                createDriver: async () => {
                  opened = true;
                  throw Error("Driver must not start");
                },
              }),
              message,
            );
            assert.equal(opened, false);
            await assert.rejects(access(output), { code: "ENOENT" });
          } finally {
            await writeFile(proofFile, JSON.stringify(proof));
          }
        }
      },
    );
  },
);
