import assert from "node:assert/strict";
import { test } from "node:test";
import { runRequestChain } from "../../src/suites/explicit-edit-multi-agent/execution/request-chain.mjs";
import { GradeFailure } from "../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import { inspectCandidate } from "../../scripts/multi-agent/experiments/candidate-grader.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

import { runIsolatedRequest } from "../../scripts/multi-agent/experiments/scripted-run.mjs";
import { mkdir, mkdtemp, readFile, writeFile, access, rm } from "node:fs/promises";
import {
  createEvidence,
  rebuildReport,
} from "../../scripts/multi-agent/experiments/chain-report.mjs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

await test("real isolated edits survive a compiler failure, repair it, then stop after three broken builds", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/chain-build-repair-"));
  try {
    const workspace = path.join(temporary, "workspace");
    const executor = path.join(temporary, "executor");
    await writeTree(workspace, {
      "main.cpp": `#include <fstream>
#include <string>
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int scene = 0; scene < 2; scene++) {
    std::ofstream out(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    for (int i = 0; i < 4096; i++) { float value = float(i % 13 + scene); out.write((char*)&value, 4); }
  }
}
`,
    });
    await mkdir(path.join(executor, "reference"), { recursive: true });
    await writeFile(
      path.join(executor, "reference/scripted-worker.mjs"),
      `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
let count = 0;
try { count = Number(await readFile("/workspace/count", "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
count++;
const file = "/workspace/main.cpp";
let source = await readFile(file, "utf8");
if (prompt.startsWith("first")) source += "\\nint first_marker;\\n";
else if (prompt.startsWith("repairable")) {
  if (count === 2) source += "\\nno_such_type failed;\\n";
  else { assert.ok(source.includes("no_such_type failed;")); source = source.replace("\\nno_such_type failed;\\n", ""); }
} else if (prompt.startsWith("blocked")) source += "\\nno_such_type failure_" + count + ";\\n";
else throw new Error("Future request was delivered");
await writeFile(file, source);
await writeFile("/workspace/count", String(count));
`,
    );
    const baseline = await inspectCandidate(workspace, path.join(temporary, "initial"));
    const evidence = await createEvidence(temporary);
    const result = await runRequestChain(
      ["first", "repairable", "blocked", "future"].map((prompt) => ({ id: prompt, prompt })),
      {
        identity: async () => evidence.checkpoint(await readTree(workspace)),
        save: evidence.save,
        execute: ({ prompt, signal }) =>
          runIsolatedRequest(workspace, executor, prompt, { signal }),
        grade: async ({ index, attempt, signal }) => {
          const current = await inspectCandidate(
            workspace,
            path.join(temporary, `grade-${index}-${attempt}`),
            { signal },
          );
          assert.deepEqual(current.pixels, baseline.pixels);
          return { status: "pass", pixels: current.pixels };
        },
      },
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.passedPrefix, 2);
    assert.deepEqual(
      result.steps.map((item) => item.status),
      ["pass", "pass", "blocked", "unattempted"],
    );
    assert.deepEqual(
      result.attempts.map((item) => item.status),
      ["pass", "fail", "pass", "fail", "fail", "fail"],
    );
    assert.ok(
      result.attempts
        .filter((item) => item.status === "fail")
        .every((item) => item.grade.category === "build"),
    );
    for (let i = 1; i < result.attempts.length; i++)
      assert.equal(result.attempts[i].before, result.attempts[i - 1].after);
    const final = await readTree(workspace);
    assert.equal(final.count, "6");
    assert.match(final["main.cpp"], /first_marker;/);
    assert.match(final["main.cpp"], /failure_4;[\s\S]*failure_5;[\s\S]*failure_6;/);
    assert.doesNotMatch(final["main.cpp"], /no_such_type failed;/);
    assert.deepEqual(
      result.attempts.map((item) => item.prompt.split("\n")[0]),
      ["first", "repairable", "repairable", "blocked", "blocked", "blocked"],
    );
    assert.match(result.attempts[2].prompt, /Previous attempt failed \[build\]/);
    const rebuilt = await rebuildReport(temporary);
    assert.equal(rebuilt.summary.status, "blocked");
    assert.equal(rebuilt.summary.counts.repairedPass, 1);
    assert.equal(rebuilt.summary.counts.failedAttempts, 4);
    for (const attempt of result.attempts) {
      assert.equal(
        treeIdentity(await readTree(path.join(temporary, "sources", attempt.after))),
        attempt.after,
      );
    }
    assert.match(await readFile(path.join(temporary, "timeline.md"), "utf8"), /no_such_type/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("a timed-out isolated worker cannot continue editing after the chain stops", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/chain-cancel-"));
  try {
    const workspace = path.join(temporary, "workspace");
    const executor = path.join(temporary, "executor");
    await mkdir(workspace);
    await mkdir(path.join(executor, "reference"), { recursive: true });
    await writeFile(
      path.join(executor, "reference/scripted-worker.mjs"),
      'import {writeFile} from "node:fs/promises"; setTimeout(async () => { await writeFile("/workspace/late-edit", "bad"); }, 2000);',
    );
    const result = await runRequestChain(
      [
        { id: "current", prompt: "current" },
        { id: "future", prompt: "future" },
      ],
      {
        identity: () => "unchanged",
        attemptTimeoutMs: 100,
        execute: ({ prompt, signal }) =>
          runIsolatedRequest(workspace, executor, prompt, { signal }),
        grade: async () => ({ status: "pass" }),
      },
    );
    assert.equal(result.status, "timeout");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.steps[1].status, "unattempted");
    await delay(2200);
    await assert.rejects(access(path.join(workspace, "late-edit")), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("a chain keeps failed edits, repairs a step, and stops after three failures without delivering the next request", async () => {
  const steps = ["first", "repair", "blocked", "future"].map((prompt, index) => ({
    id: `step-${index + 1}`,
    prompt,
  }));
  let state = 0;
  const delivered = [];
  const persisted = [];
  const result = await runRequestChain(steps, {
    identity: () => String(state),
    execute: async ({ prompt }) => {
      delivered.push(prompt);
      state++;
    },
    grade: async ({ index, attempt }) => {
      if ((index === 1 && attempt === 1) || index === 2)
        throw new GradeFailure("structure", "Current owner is missing");
      return { status: "pass" };
    },
    save: async (report) => persisted.push(structuredClone(report)),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.passedPrefix, 2);
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["pass", "pass", "blocked", "unattempted"],
  );
  assert.equal(delivered.length, 6);
  assert.ok(
    delivered
      .slice(0, 3)
      .every((prompt) => !prompt.includes("future") && !prompt.includes("blocked")),
  );
  assert.match(delivered[2], /Previous attempt failed \[structure\]/);
  assert.equal(result.attempts.at(-1).attempt, 3);
  assert.ok(
    result.attempts.every(
      (item, index) => item.before === String(index) && item.after === String(index + 1),
    ),
  );
  assert.equal(persisted.at(-1).status, "blocked");
  assert.equal(result.usage, null);
});

await test("infrastructure, executor exit, cancellation and timeout are terminal outcomes rather than exhausted editing attempts", async () => {
  for (const kind of ["infrastructure", "driver_exit", "cancelled", "timeout"]) {
    const controller = new AbortController();
    const result = await runRequestChain(
      [
        { id: "current", prompt: "current" },
        { id: "future", prompt: "future" },
      ],
      {
        identity: () => "unchanged",
        signal: controller.signal,
        attemptTimeoutMs: 10,
        execute: async ({ signal }) => {
          if (kind === "driver_exit") throw new Error("Worker exited");
          if (kind === "cancelled") controller.abort();
          if (["cancelled", "timeout"].includes(kind))
            await new Promise((resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        },
        grade: async () => {
          throw new GradeFailure("infrastructure", "Grader unavailable");
        },
      },
    );
    assert.equal(result.status, kind);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.steps[1].status, "unattempted");
    assert.equal(result.passedPrefix, 0);
  }
});
