import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MULTI_AGENT_MAX_ATTEMPTS } from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { runCoherent } from "../../src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { independentPiFactory } from "./pi-independent-reference.mjs";
import { prepareConcurrentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import { prepareConcurrent } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import {
  applyCoherentStructure,
  applyCurrentStructure,
} from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
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
    row.atomicIds.map((atomicId, index) => ({
      ...row,
      atomicId,
      receipts: row.receipts ? [row.receipts[index]] : undefined,
    })),
  );
}
function assertBarrierOnly(report) {
  for (const barrier of report.atomicBarriers) {
    assert.equal(Object.hasOwn(barrier, "inputChecks"), false);
    assert.equal(Object.hasOwn(barrier, "retained"), false);
  }
  for (const row of report.executions) {
    assert.equal(Object.hasOwn(row, "atomicCheck"), false);
    assert.equal(Object.hasOwn(row, "atomicChecks"), false);
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

function headerDelivery(prompt, options) {
  if (options.deliveryKind !== "barrier-repair") return currentHeader(prompt);
  assert.deepEqual(options.atomicIds, []);
  assert.ok(options.repairTasks?.length > 0);
  return options.repairTasks.flatMap((task) =>
    task.operations.flatMap((operation) => {
      assert.equal(operation.phase, "repair");
      if (
        !["create-module", "remove-source-module"].includes(operation.action) ||
        operation.required?.kind !== "header"
      )
        return [];
      return [
        {
          phase: "structure",
          action: "header",
          file: operation.required.file,
          guard: operation.required.guard,
          includes: operation.setup?.includes ?? [],
        },
      ];
    }),
  );
}

async function waitForPeer(promise, signal) {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function deterministicDrivers({
  skipFirstNorth = false,
  noEdits = false,
  breakBuild = false,
} = {}) {
  const histories = [],
    calls = [];
  const firstWave = Promise.withResolvers();
  let writes = Promise.resolve(),
    deliveries = 0;
  return {
    histories,
    calls,
    createDriver: async (workspace, _state, agent) => {
      const history = [];
      histories[agent] = history;
      let closed = false;
      return {
        get closed() {
          return closed;
        },
        async execute(prompt, options) {
          assert.equal(closed, false);
          const operations = headerDelivery(prompt, options);
          history.push({ prompt, ...options });
          calls.push({ agent, operations, ...options });
          if (++deliveries >= 2) firstWave.resolve();
          await waitForPeer(firstWave.promise, options.signal);
          // This fixture fixes a source interleaving to test barrier decisions.
          // The real reference proof above uses ordinary independent editors.
          writes = writes.then(async () => {
            if (noEdits) return;
            let tree = await readTree(workspace);
            for (const operation of operations) {
              if (skipFirstNorth && operation.guard === "NORTH_H" && options.attempt === 1)
                continue;
              if (tree["main.cpp"].includes("#ifndef " + operation.guard))
                tree = applyCurrentStructure(tree, operation);
            }
            if (breakBuild && options.attempt === 1)
              tree["main.cpp"] = tree["main.cpp"].replace("#include <fstream>\n", "");
            if (
              breakBuild &&
              options.attempt > 1 &&
              !tree["main.cpp"].includes("#include <fstream>")
            )
              tree["main.cpp"] = "#include <fstream>\n" + tree["main.cpp"];
            for (const [file, source] of Object.entries(tree))
              await writeFile(path.join(workspace, file), source);
          });
          await writes;
          return {
            sessionId: "participant-" + agent,
            sequence: history.length,
            status: "settled",
            reply: "Edits are still unfinished.",
          };
        },
        async close() {
          closed = true;
        },
      };
    },
  };
}

await test(
  "shared-source atomic queues are checked only at retained full barriers",
  { timeout: 240_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/barrier-stream-runner-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { preparation, expected, pixels } = await prepareFixture(root);
    const caseEvents = [];
    const reference = await runConcurrent(preparation, path.join(root, "reference"), {
      log: quiet,
      onCase: (event) => caseEvents.push(event),
    });
    assert.equal(reference.status, "pass", JSON.stringify(reference.terminal));
    assert.equal(reference.acceptedTasks, 2);
    assert.equal(reference.acceptedRounds, 1);
    assert.equal(new Set(atomicRows(reference).map((row) => row.atomicId)).size, 3);
    assert.equal(new Set(atomicRows(reference).map((row) => row.receipts[0].lifetime)).size, 2);
    assert.equal(caseEvents.length, atomicRows(reference).length * 2);
    assert.ok(
      caseEvents
        .filter((event) => event.event === "case-end")
        .every((event) => event.phase === "delivery" && event.status === "settled"),
    );
    assertBarrierOnly(reference);
    const proofFile = path.join(preparation, "verification-2.json");
    const proof = JSON.parse(await readFile(proofFile, "utf8"));
    assert.equal(proof.acceptedAtomicEdits, 3);
    assert.deepEqual(proof.atomic, reference.atomic);
    assert.equal(proof.repairs, 0);
    assert.equal(proof.referenceFirstPass.repairs, 0);
    assert.ok(proof.referenceFirstPass.barriers.every((barrier) => barrier.attempt === 1));
    assert.ok(proof.referenceFirstPass.checks.every((check) => check.status === "pass"));

    await t.test(
      "an explicit scripted driver stops at its first failed drained barrier",
      async () => {
        const beforeProof = await readFile(proofFile, "utf8");
        const drivers = deterministicDrivers({ skipFirstNorth: true });
        const output = path.join(root, "reference-first-failure");
        const report = await runConcurrent(preparation, output, {
          ...drivers,
          reference: true,
          log: quiet,
        });
        assert.equal(report.mode, "scripted");
        assert.equal(report.status, "blocked");
        assert.equal(report.repairs, 0);
        assert.equal(report.acceptedRounds, 0);
        assert.equal(report.acceptedTasks, 0);
        assert.equal(report.atomicBarriers.length, 1);
        assert.deepEqual(
          report.checks.map((check) => check.status),
          ["pass", "fail"],
        );
        assert.ok(drivers.calls.length > 0 && drivers.calls.every((call) => call.attempt === 1));
        assert.ok(
          report.executions.every(
            (row) => row.attempt === 1 && row.atomicIds.length > 0 && !row.repairIds,
          ),
        );
        assert.ok(report.agentsClosed.every(Boolean));
        assert.equal(await readFile(proofFile, "utf8"), beforeProof);
        await assert.rejects(access(path.join(output, "verification.json")), { code: "ENOENT" });
        assertBarrierOnly(report);
      },
    );

    await t.test(
      "a real native scripted driver receives no repair turns after a failed barrier",
      async (t) => {
        const calls = [],
          providers = [];
        const output = path.join(root, "native-reference-first-failure");
        const report = await runConcurrent(preparation, output, {
          reference: true,
          log: quiet,
          createDriver: async (workspace, state, agent) => {
            const providerRoot = state + "-provider";
            await mkdir(providerRoot, { recursive: true });
            const provider = await providerFixture(providerRoot, (body) =>
              body.messages.at(-1).role === "tool" ? {} : { command: "true" },
            );
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
        assert.equal(report.status, "blocked");
        assert.equal(report.repairs, 0);
        assert.equal(report.atomicBarriers.length, 1);
        assert.deepEqual(
          report.checks.map((check) => check.status),
          ["pass", "fail"],
        );
        assert.equal(calls.length, report.deliveries);
        assert.equal(new Set(calls.map((call) => call.agent)).size, 2);
        assert.ok(
          calls.every(
            (call) =>
              call.attempt === 1 &&
              call.atomicIds.length > 0 &&
              call.receipt.toolCalls === 1 &&
              call.receipt.failedToolCalls === 0,
          ),
        );
        assert.equal(providers.length, 2);
        assert.ok(report.agentsClosed.every(Boolean));
        await assert.rejects(access(path.join(output, "verification.json")), { code: "ENOENT" });
        assertBarrierOnly(report);
      },
    );
    await t.test(
      "a successful native scripted proof does not overwrite the Node prerequisite",
      async () => {
        const beforeProof = await readFile(proofFile, "utf8");
        const output = path.join(root, "native-reference-success");
        const tools = path.join(root, "native-reference-tools");
        await prepareConcurrentExecutor(tools);
        const workload = JSON.parse(
          await readFile(path.join(preparation, "atomic/tasks.json"), "utf8"),
        );
        const report = await runConcurrent(preparation, output, {
          reference: true,
          log: quiet,
          createDriver: independentPiFactory({
            runtime: process.env.RENDERER_PI_RUNTIME,
            tools,
            tasks: new Map(workload.nodes.map((node) => [node.id, node])),
            artifacts: path.join(root, "native-reference-artifacts"),
          }),
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        assert.equal(report.mode, "scripted");
        assert.equal(report.repairs, 0);
        assert.equal(report.atomicBarriers.length, 1);
        const nativeProof = JSON.parse(
          await readFile(path.join(output, "verification.json"), "utf8"),
        );
        assert.deepEqual(nativeProof.referenceFirstPass, report.referenceFirstPass);
        assert.equal(nativeProof.referenceFirstPass.originalAtomicEdits, 3);
        assert.equal(await readFile(proofFile, "utf8"), beforeProof);
        assert.ok(
          report.executions.every(
            (row) => row.receipt.toolCalls === 1 && row.receipt.failedToolCalls === 0,
          ),
        );
        assert.ok(report.agentsClosed.every(Boolean));
        assert.deepEqual(await readTree(path.join(output, "workspace")), expected);
        assert.deepEqual(report.checks.at(-1).pixels, pixels);
        assertBarrierOnly(report);
      },
    );
    await t.test("both histories drain before the combined build and pixel check", async () => {
      const drivers = deterministicDrivers();
      const report = await runConcurrent(preparation, path.join(root, "live"), {
        ...drivers,
        log: quiet,
      });
      assert.equal(report.status, "pass", JSON.stringify(report.terminal));
      assert.equal(atomicRows(report).length, 3);
      assert.equal(report.repairs, 0);
      assert.equal(report.acceptedTasks, 2);
      assert.equal(
        drivers.histories.reduce((sum, history) => sum + history.length, 0),
        report.deliveries,
      );
      assert.equal(new Set(report.executions.map((row) => row.agent)).size, 2);
      const first = report.executions.filter((row) => row.attempt === 1);
      assert.ok(
        Math.max(...first.map((row) => row.startedMs)) <
          Math.min(...first.map((row) => row.startedMs + row.elapsedMs)),
      );
      assert.ok(
        report.checks.at(-1).startedMs >=
          Math.max(...first.map((row) => row.startedMs + row.elapsedMs)),
      );
      assertBarrierOnly(report);
      assert.deepEqual(await readTree(path.join(root, "live/workspace")), expected);
      assert.deepEqual(report.checks.at(-1).pixels, pixels);
      assert.ok(report.agentsClosed.every(Boolean));
    });

    await t.test(
      "a missing edit waits for the barrier and repairs on another participant",
      async () => {
        const drivers = deterministicDrivers({ skipFirstNorth: true });
        const report = await runConcurrent(preparation, path.join(root, "repair"), {
          ...drivers,
          log: quiet,
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        const original = drivers.calls.find(
          (call) =>
            call.attempt === 1 &&
            call.operations.some((operation) => operation.guard === "NORTH_H"),
        );
        const corrections = drivers.calls.filter((call) => call.attempt > 1);
        assert.ok(corrections.length);
        const corrected = corrections.find((call) =>
          call.operations.some((operation) => operation.guard === "NORTH_H"),
        );
        assert.ok(corrected);
        assert.notEqual(corrected.agent, original.agent);
        assert.equal(corrected.attempt, 2);
        assert.deepEqual(corrected.atomicIds, []);
        assert.ok(
          corrected.repairTasks.every(
            (task) =>
              task.id.startsWith("repair-round-001-attempt-2-") &&
              task.operations.every((operation) => operation.phase === "repair"),
          ),
        );
        assert.ok(
          report.executions
            .filter((row) => row.attempt > 1)
            .every(
              (row) =>
                row.tasks.length === 0 &&
                row.atomicIds.length === 0 &&
                row.repairIds.length > 0 &&
                row.repairIds.length <= report.batchSize,
            ),
        );
        const rejected = report.checks.find((check) => check.status === "fail");
        const first = report.executions.filter((row) => row.attempt === 1);
        assert.ok(first.every((row) => row.startedMs + row.elapsedMs <= rejected.startedMs));
        assert.equal(rejected.category, "structure");
        assert.equal(
          new Set(
            atomicRows(report)
              .filter((row) => row.attempt === 1)
              .map((row) => row.atomicId),
          ).size,
          3,
        );
        assertBarrierOnly(report);
        assert.deepEqual(await readTree(path.join(root, "repair/workspace")), expected);
        assert.deepEqual(report.checks.at(-1).pixels, pixels);
      },
    );

    await t.test("compiler failures without an original executor remain team repairs", async () => {
      const drivers = deterministicDrivers({ breakBuild: true });
      const report = await runConcurrent(preparation, path.join(root, "compiler-repair"), {
        ...drivers,
        log: quiet,
      });
      assert.equal(report.status, "pass", JSON.stringify(report.terminal));
      const rejected = report.checks.find((check) => check.status === "fail");
      assert.ok(rejected);
      assert.ok(report.executions.some((row) => row.attempt > 1));
      assert.equal(report.acceptedTasks, 2);
      assertBarrierOnly(report);
      assert.deepEqual(report.checks.at(-1).pixels, pixels);
    });

    await t.test(
      "settled turns without edits exhaust the fixed barrier budget without credit",
      async () => {
        const drivers = deterministicDrivers({ noEdits: true });
        const report = await runConcurrent(preparation, path.join(root, "exhausted"), {
          ...drivers,
          log: quiet,
        });
        assert.equal(report.status, "blocked");
        assert.equal(report.acceptedTasks, 0);
        assert.equal(report.acceptedRounds, 0);
        assert.equal(report.atomicBarriers.length, MULTI_AGENT_MAX_ATTEMPTS);
        assert.equal(
          report.checks.filter((check) => check.status === "fail").length,
          MULTI_AGENT_MAX_ATTEMPTS,
        );
        assert.ok(report.agentsClosed.every(Boolean));
        assertBarrierOnly(report);
      },
    );

    await t.test(
      "cancellation waits for active harness turns and closes persistent histories",
      async () => {
        const controller = new AbortController();
        const active = new Set(),
          closed = new Set();
        let entered = 0;
        const report = await runConcurrent(preparation, path.join(root, "cancelled"), {
          signal: controller.signal,
          log: quiet,
          createDriver: async (_workspace, _state, agent) => ({
            get closed() {
              return closed.has(agent);
            },
            async execute(_prompt, options) {
              active.add(agent);
              if (++entered === 2) controller.abort(new Error("cancel fixture"));
              try {
                await waitForPeer(new Promise(() => {}), options.signal);
              } finally {
                active.delete(agent);
              }
            },
            async close() {
              assert.equal(active.has(agent), false);
              closed.add(agent);
            },
          }),
        });
        assert.equal(report.status, "cancelled");
        assert.equal(active.size, 0);
        assert.equal(closed.size, 2);
        assert.equal(report.acceptedTasks, 0);
      },
    );

    await t.test(
      "real Pi Bash repairs retained source in the newly assigned native history",
      async (t) => {
        const calls = [],
          providers = [];
        const output = path.join(root, "native-repair");
        const report = await runConcurrent(preparation, output, {
          log: quiet,
          createDriver: async (workspace, state, agent) => {
            const providerRoot = state + "-provider";
            await mkdir(providerRoot, { recursive: true });
            let current;
            const provider = await providerFixture(providerRoot, (body) => {
              if (body.messages.at(-1).role === "tool") return {};
              const operations = headerDelivery(current.prompt, current.options).filter(
                (operation) => operation.guard !== "NORTH_H" || current.options.attempt > 1,
              );
              const program = [
                "import json, pathlib",
                "operations = json.loads(" + JSON.stringify(JSON.stringify(operations)) + ")",
                "for operation in operations:",
                " source = pathlib.Path('main.cpp')",
                " text = source.read_text()",
                " marker = '#ifndef ' + operation['guard'] + '\\n'",
                " if marker not in text: continue",
                " start = text.index(marker)",
                " end = text.index('#endif', start) + len('#endif')",
                " pathlib.Path(operation['file']).write_text(text[start:end])",
                " source.write_text(text[:start] + '#include ' + chr(34) + operation['file'] + chr(34) + '\\n' + text[end:].lstrip('\\n'))",
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
                current = { prompt, options };
                try {
                  const receipt = await driver.execute(prompt, options);
                  calls.push({
                    agent,
                    ...options,
                    operations: headerDelivery(prompt, options),
                    receipt,
                  });
                  return receipt;
                } finally {
                  current = undefined;
                }
              },
              close: () => driver.close(),
            };
          },
        });
        assert.equal(report.status, "pass", JSON.stringify(report.terminal));
        const correction = calls.find(
          (call) =>
            call.attempt > 1 && call.operations.some((operation) => operation.guard === "NORTH_H"),
        );
        const original = calls.find(
          (call) =>
            call.attempt === 1 &&
            call.operations.some((operation) => operation.guard === "NORTH_H"),
        );
        assert.ok(correction && original);
        assert.deepEqual(correction.atomicIds, []);
        assert.ok(
          correction.repairTasks.every((task) =>
            task.operations.every((operation) => operation.phase === "repair"),
          ),
        );
        assert.notEqual(correction.agent, original.agent);
        const ownFirst = calls.find(
          (call) => call.agent === correction.agent && call.attempt === 1,
        );
        assert.equal(correction.receipt.sessionId, ownFirst.receipt.sessionId);
        assert.equal(correction.receipt.lifetime, ownFirst.receipt.lifetime);
        assert.ok(correction.receipt.messageCount > ownFirst.receipt.messageCount);
        assert.ok(
          calls.every((call) => call.receipt.toolCalls === 1 && call.receipt.failedToolCalls === 0),
        );
        assert.deepEqual(await readTree(path.join(output, "workspace")), expected);
        assert.deepEqual(report.checks.at(-1).pixels, pixels);
        assert.equal(providers.length, 2);
        assertBarrierOnly(report);
      },
    );

    await t.test(
      "mismatched dispatch or inventory proofs reject before driver startup",
      async () => {
        const manifestFile = path.join(preparation, "manifest.json");
        const originalManifest = await readFile(manifestFile, "utf8");
        const manifest = JSON.parse(originalManifest);
        for (const [kind, field, value] of [
          ["manifest", "dispatchPolicySha256", "0".repeat(64)],
          ["proof", "agents", 1],
          ["proof", "acceptedAtomicEdits", 2],
          ["proof", "repairs", 1],
          ["proof", "referenceFirstPass", undefined],
          [
            "proof",
            "referenceFirstPass",
            {
              ...proof.referenceFirstPass,
              barriers: proof.referenceFirstPass.barriers.map((barrier) => ({
                ...barrier,
                attempt: 2,
              })),
            },
          ],
        ]) {
          const output = path.join(root, "invalid-" + field);
          let opened = false;
          try {
            if (kind === "manifest")
              await writeFile(
                manifestFile,
                JSON.stringify({ ...manifest, atomic: { ...manifest.atomic, [field]: value } }),
              );
            else await writeFile(proofFile, JSON.stringify({ ...proof, [field]: value }));
            await assert.rejects(
              runConcurrent(preparation, output, {
                log: quiet,
                createDriver: async () => {
                  opened = true;
                  throw new Error("unexpected driver");
                },
              }),
            );
            assert.equal(opened, false);
            await assert.rejects(access(output), { code: "ENOENT" });
          } finally {
            await writeFile(manifestFile, originalManifest);
            await writeFile(proofFile, JSON.stringify(proof));
          }
        }
      },
    );
  },
);
