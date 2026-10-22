import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
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
function atomicRows(report) {
  return report.executions.flatMap((row) =>
    row.atomicIds
      ? row.atomicIds.map((atomicId, index) => ({
          ...row,
          atomicId,
          atomicCheck: row.atomicChecks[atomicId],
          receipts: row.receipts ? [row.receipts[index]] : undefined,
        }))
      : [row],
  );
}

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
    "main.cpp": `#include <array>
#include <fstream>
#include <string>
${names.map((name, index) => `#ifndef ${name.toUpperCase()}_H\n#define ${name.toUpperCase()}_H\ninline int ${name}(int value) { return ${index === 0 ? "std::array<int, 1>{value + 1}[0]" : `value + ${index + 1}`}; }\n#endif`).join("\n")}
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
  return prompt.split("\n").flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return typeof row.guard === "string"
        ? [{ phase: "structure", action: "header", ...row }]
        : [];
    } catch {
      return [];
    }
  });
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
function deterministicDrivers({
  skipFirstNorth = false,
  breakBuild = false,
  breakOwnBuild = false,
  precompletedSouth = false,
} = {}) {
  const histories = [],
    calls = [];
  let writes = Promise.resolve(),
    deliveries = 0;
  const both = Promise.withResolvers(),
    peer = Promise.withResolvers();
  const createDriver = async (workspace, _state, agent) => {
    if (precompletedSouth && agent === 0) {
      const edited = applyCoherentStructure(await readTree(workspace), {
        phase: "structure",
        action: "header",
        file: "south.h",
        guard: "SOUTH_H",
        includes: [],
      });
      for (const [file, source] of Object.entries(edited))
        await writeFile(path.join(workspace, file), source);
    }
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
        assert.equal(options.deliveryKind, undefined);
        const operations = currentHeader(prompt);
        assert.equal(operations.length, options.atomicIds.length);
        for (const [index, operation] of operations.entries())
          calls.push({
            agent,
            prompt,
            ...options,
            atomicId: options.atomicIds[index],
            operation,
          });
        if (++deliveries >= 2) both.resolve();
        await waitForPeer(both.promise, options.signal);
        for (const operation of operations) {
          if (skipFirstNorth && operation.guard === "NORTH_H" && options.attempt === 1) {
            await waitForPeer(peer.promise, options.signal);
            continue;
          }
          writes = writes.then(async () => {
            const tree = await readTree(workspace);
            const edited =
              (precompletedSouth && operation.guard === "SOUTH_H" && tree["south.h"]) ||
              (breakOwnBuild && operation.guard === "NORTH_H" && options.attempt > 1)
                ? tree
                : applyCoherentStructure(tree, operation);
            if (breakOwnBuild && operation.guard === "NORTH_H") {
              if (options.attempt === 1)
                edited["main.cpp"] = edited["main.cpp"].replace("#include <array>\n", "");
              else edited["north.h"] = "#include <array>\n" + edited["north.h"];
            }
            if (breakBuild && operation.guard === "WEST_H")
              edited["main.cpp"] = edited["main.cpp"].replace("#include <fstream>\n", "");
            for (const [file, source] of Object.entries(edited))
              await writeFile(path.join(workspace, file), source);
          });
          await writes;
          if (operation.guard !== "NORTH_H") peer.resolve();
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
    assert.equal(atomicRows(reference).length, 3);
    assert.equal(reference.acceptedTasks, 2);
    assert.equal(reference.acceptedRounds, 1);
    assert.equal(caseEvents.length, 6);
    for (const execution of atomicRows(reference))
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
    assert.equal(new Set(atomicRows(reference).map((row) => row.receipts[0].lifetime)).size, 2);
    assert.ok(atomicRows(reference).some((row) => row.receipts[0].delivered === 2));
    const proofFile = path.join(preparation, "verification-2.json");
    const proof = JSON.parse(await readFile(proofFile, "utf8"));
    assert.deepEqual(proof.atomic, reference.atomic);
    assert.equal(proof.acceptedAtomicEdits, 3);
    assert.equal(proof.agents, 2);

    await t.test(
      "free persistent participants receive only ready batch members in their retained histories",
      async () => {
        const drivers = deterministicDrivers();
        const report = await runConcurrent(preparation, path.join(root, "live"), {
          ...drivers,
          log: quiet,
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        assert.equal(atomicRows(report).length, 3);
        assert.equal(report.acceptedTasks, 2);
        assert.equal(
          report.repairs,
          0,
          JSON.stringify({
            executions: atomicRows(report),
            barriers: report.atomicBarriers,
            checks: report.checks,
          }),
        );
        assert.equal(new Set(drivers.calls.map((row) => row.atomicId)).size, 3);
        assert.equal(
          drivers.histories.reduce((sum, history) => sum + history.length, 0),
          report.deliveries,
        );
        assert.ok(report.agentsClosed.every(Boolean));
        assertInputTrace(report);
        assert.ok(
          report.atomicBarriers[0].inputChecks.some(
            (check) =>
              check.decision === "pass" &&
              check.observations.some(
                (row) => row.mode === "current-input" && row.status === "pass",
              ) &&
              !check.observations.some((row) => row.mode === "current-output"),
          ),
          "A valid structural input must not first materialize and grade its full output",
        );
        assert.ok(
          report.atomicBarriers[0].inputChecks.every(
            (check) =>
              check.observations.find(
                (row) => row.mode === "current-input" || row.mode === "current-output",
              )?.mode !== "current-output",
          ),
          "Structural input observation comes before the already-correct output fallback",
        );
        const saved = JSON.parse(await readFile(path.join(root, "live/report.json"), "utf8"));
        assert.deepEqual(saved.atomicBarriers[0].inputChecks, report.atomicBarriers[0].inputChecks);
        assert.deepEqual(await readTree(path.join(root, "live/workspace")), expected);
        assert.deepEqual(report.checks.at(-1).pixels, pixels);
      },
    );

    await t.test(
      "an already-correct structural output remains eligible after its input check",
      async () => {
        const drivers = deterministicDrivers({ precompletedSouth: true });
        const report = await runConcurrent(preparation, path.join(root, "already-correct"), {
          agents: 2,
          createDriver: drivers.createDriver,
          log: quiet,
        });
        assert.equal(report.status, "pass");
        assert.equal(report.acceptedTasks, 2);
        assert.equal(new Set(drivers.calls.map((row) => row.atomicId)).size, 3);
        const fallback = report.atomicBarriers[0].inputChecks.find((check) =>
          check.observations.some((row) => row.mode === "current-output" && row.status === "pass"),
        );
        assert.ok(fallback, "Already-correct output is checked, not silently waived");
        assert.equal(fallback.observations[0].mode, "current-input");
        assert.notEqual(fallback.observations[0].status, "pass");
        assert.ok(report.agentsClosed.every(Boolean));
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
          const byGuard = (guard) => drivers.calls.filter((row) => row.operation?.guard === guard);
          assert.equal(
            byGuard("NORTH_H").length,
            2,
            JSON.stringify({
              repetition,
              calls: drivers.calls.map(({ atomicId, attempt }) => ({ atomicId, attempt })),
              executions: atomicRows(report),
              barriers: report.atomicBarriers,
              checks: report.checks,
            }),
          );
          const [original, correction] = byGuard("NORTH_H");
          assert.equal(correction.agent, original.agent);
          const receipts = atomicRows(report).filter((row) => row.atomicId === original.atomicId);
          assert.equal(receipts[0].receipt.sessionId, receipts[1].receipt.sessionId);
          assert.deepEqual(Object.keys(correction.diagnostics), [correction.atomicId]);
          assert.ok(correction.diagnostics[correction.atomicId].length > 0);
          assert.ok(
            correction.diagnostics[correction.atomicId].every(
              (entry) =>
                !JSON.stringify(entry).includes("SOUTH") && !JSON.stringify(entry).includes("WEST"),
            ),
          );
          assert.ok(
            drivers.histories[original.agent].some(
              (entry) => entry.attempt === 1 && entry.atomicIds.includes(original.atomicId),
            ),
          );
          assert.equal(byGuard("SOUTH_H").length, 1);
          assert.equal(byGuard("WEST_H").length, 1);
          assert.equal(atomicRows(report).length, 4);
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
          const verifiedPeers = atomicRows(report).filter(
            (row) => row.attempt === 1 && row.atomicCheck?.status === "pass",
          );
          assert.ok(verifiedPeers.length > 0, "The correction must retain a verified peer");
          assert.deepEqual(
            [...report.atomicBarriers[1].retained].sort(),
            verifiedPeers.map((row) => row.atomicId).sort(),
            JSON.stringify({
              repetition,
              executions: atomicRows(report),
              barriers: report.atomicBarriers,
            }),
          );
          assert.deepEqual(await readTree(path.join(output, "workspace")), expected);
        }
      },
    );

    await t.test(
      "real Pi repairs only its own failed atom in the original native history",
      async (t) => {
        const calls = [];
        const providers = [];
        const output = path.join(root, "native-repair");
        const report = await runConcurrent(preparation, output, {
          log: quiet,
          createDriver: async (workspace, state, agent) => {
            const providerRoot = state + "-provider";
            await mkdir(providerRoot, { recursive: true });
            const provider = await providerFixture(providerRoot, (body) => {
              if (body.messages.at(-1).role === "tool") return {};
              const message = body.messages.findLast((item) => item.role === "user").content;
              const prompt =
                typeof message === "string"
                  ? message
                  : message
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("");
              const detail = prompt.split("\n").flatMap((line) => {
                try {
                  const parsed = JSON.parse(line);
                  return Array.isArray(parsed) ? parsed : [];
                } catch {
                  return [];
                }
              });
              const operations = currentHeader(prompt).filter(
                (operation) =>
                  operation.guard !== "NORTH_H" ||
                  detail.some((entry) => entry.file === operation.file),
              );
              const program = [
                "import fcntl, json, pathlib",
                "operations = json.loads(" + JSON.stringify(JSON.stringify(operations)) + ")",
                "with open('main.cpp', 'r+') as source:",
                " fcntl.flock(source, fcntl.LOCK_EX)",
                " text = source.read()",
                " for operation in operations:",
                "  marker = '#ifndef ' + operation['guard'] + '\\n'",
                "  if marker not in text: continue",
                "  start = text.index(marker)",
                "  end = text.index('#endif', start) + len('#endif')",
                "  pathlib.Path(operation['file']).write_text(text[start:end] + '\\n')",
                "  text = text[:start] + '#include ' + chr(34) + operation['file'] + chr(34) + '\\n' + text[end:]",
                " source.seek(0)",
                " source.write(text)",
                " source.truncate()",
              ].join("\n");
              return { command: "python3 -c '" + program.replaceAll("'", "'\\''") + "'" };
            });
            providers.push(provider);
            t.after(() => provider.close());
            const driver = await startBaseline(workspace, state, provider.config, {
              eventsFile: path.join(state, "events.jsonl"),
            });
            return {
              get closed() {
                return driver.closed;
              },
              async execute(prompt, options) {
                const receipt = await driver.execute(prompt, options);
                calls.push({ agent, ...options, receipt });
                return receipt;
              },
              close: () => driver.close(),
            };
          },
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        const correction = calls.find((call) => call.attempt === 2);
        assert.ok(correction);
        const first = calls.find(
          (call) => call.attempt === 1 && call.atomicIds.includes(correction.atomicId),
        );
        assert.equal(correction.agent, first.agent);
        assert.equal(correction.receipt.sessionId, first.receipt.sessionId);
        assert.equal(correction.receipt.lifetime, first.receipt.lifetime);
        assert.ok(correction.receipt.messageCount > first.receipt.messageCount);
        assert.deepEqual(Object.keys(correction.diagnostics), [correction.atomicId]);
        assert.ok(correction.diagnostics[correction.atomicId].length);
        assert.equal(
          evaluateCoherentContract(
            await readTree(path.join(output, "workspace")),
            prepareCoherentContract(expected),
          ).status,
          "pass",
        );
        assert.equal(calls.filter((call) => call.attempt > 1).length, 1);
        assert.equal(providers.length, 2);
      },
    );

    await t.test(
      "a uniquely located build error returns only to its task's original executor",
      async () => {
        const drivers = deterministicDrivers({ breakOwnBuild: true });
        const report = await runConcurrent(preparation, path.join(root, "owned-build-repair"), {
          ...drivers,
          log: quiet,
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        const corrections = drivers.calls.filter((call) => call.attempt > 1);
        assert.equal(corrections.length, 1);
        const correction = corrections[0];
        const original = drivers.calls.find(
          (call) => call.atomicId === correction.atomicId && call.attempt === 1,
        );
        assert.equal(correction.agent, original.agent);
        assert.equal(correction.operation.guard, "NORTH_H");
        assert.deepEqual(Object.keys(correction.diagnostics), [correction.atomicId]);
        assert.ok(
          correction.diagnostics[correction.atomicId].some(
            (entry) =>
              entry.category === "build" &&
              entry.file === "north.h" &&
              entry.severity === "error" &&
              Number.isInteger(entry.line),
          ),
        );
        assert.ok(
          correction.diagnostics[correction.atomicId].every((entry) => entry.file === "north.h"),
        );
        assert.equal(report.acceptedTasks, 2);
        assert.equal(report.repairs, 1);
        assert.ok(
          atomicRows(report)
            .filter((row) => row.attempt === 1)
            .every((row) => row.atomicCheck.status === "pass"),
        );
      },
    );

    await t.test(
      "an unattributed build failure stops without guessing an executor or broadcasting",
      async () => {
        const drivers = deterministicDrivers({ breakBuild: true });
        const report = await runConcurrent(preparation, path.join(root, "barrier-repair"), {
          ...drivers,
          log: quiet,
        });
        assert.equal(report.status, "infrastructure", JSON.stringify(report.terminal));
        assert.match(report.terminal.message, /cannot be attributed/);
        assert.equal(atomicRows(report).length, 3);
        assert.equal(report.repairs, 0);
        assert.equal(report.acceptedTasks, 0);
        assertInputTrace(report);
        assert.ok(
          atomicRows(report).every((row) => row.attempt === 1 && row.atomicCheck.status === "pass"),
        );
        assert.ok(drivers.calls.every((row) => row.attempt === 1));
        const failure = report.checks.find((check) => check.status === "fail");
        assert.equal(failure.category, "build");
        assert.ok(
          failure.diagnostics.some(
            (entry) => entry.file === "main.cpp" && entry.severity === "error",
          ),
        );
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
        assert.equal(atomicRows(report).length, 3);
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
        const dependent = atomicRows(report).find((row) => row.atomicId === south.id);
        assert.ok(passed.startedMs + passed.elapsedMs <= dependent.startedMs);
        assert.equal(
          atomicRows(report).find((row) => row.atomicId === north.id).atomicCheck.status,
          "pass",
        );
        const saved = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
        assert.deepEqual(saved.atomicBarriers[0].inputChecks, report.atomicBarriers[0].inputChecks);
      },
    );

    await t.test(
      "a proof for an earlier dispatch contract rejects before driver startup",
      async () => {
        const manifestFile = path.join(preparation, "manifest.json");
        const original = await readFile(manifestFile, "utf8");
        const manifest = JSON.parse(original);
        const output = path.join(root, "invalid-dispatch-contract");
        manifest.atomic.dispatchPolicySha256 = "0".repeat(64);
        await writeFile(manifestFile, JSON.stringify(manifest));
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
            /Atomic dispatch policy changed/,
          );
          assert.equal(opened, false);
          await assert.rejects(access(output), { code: "ENOENT" });
        } finally {
          await writeFile(manifestFile, original);
        }
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
