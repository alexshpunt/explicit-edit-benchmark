import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRestoringRound } from "../../src/suites/explicit-edit-multi-agent/execution/restoring-boundary.mjs";
import { releaseCandidateWorkspace } from "../../src/suites/explicit-edit-multi-agent/execution/candidate-evidence.mjs";

async function fixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), "renderer-boundary-"));
  t.after(() => {
    releaseCandidateWorkspace(path.join(output, "workspace"));
    return rm(output, { recursive: true, force: true });
  });
  const workspace = path.join(output, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "main.cpp"), "int initial;\n");
  return {
    output,
    workspace,
    drivers: [
      { assertIdle: async () => ({ sessionId: "a" }) },
      { assertIdle: async () => ({ sessionId: "b" }) },
    ],
    notices: [[], []],
  };
}
const measured = (passedAtoms) => ({
  passedAtoms,
  totalAtoms: 1,
  buildPassed: true,
  resultMatched: true,
  integrityPassed: true,
});
const interval = {
  nodes: [{ id: "original-atom" }],
  expectedTree: { "main.cpp": "int canonical;\n" },
};

test("six ordinary editing failures keep one candidate, retain first and final evidence, restore and allow later work", async (t) => {
  const options = await fixture(t);
  const before = await stat(options.workspace);
  const mounted = await open(options.workspace, "r");
  t.after(() => mounted.close());
  const seen = [];
  const first = await runRestoringRound({
    ...options,
    round: "round-001",
    interval,
    executeAttempt: async ({ attempt }) => {
      seen.push(await readFile(path.join(options.workspace, "main.cpp"), "utf8"));
      await writeFile(path.join(options.workspace, "main.cpp"), `int wrong_${attempt};\n`);
      await writeFile(path.join(options.workspace, "debug.bin"), Buffer.from([255, attempt]));
    },
    measureCandidate: async () => measured(0),
  });
  assert.deepEqual(seen, ["int initial;\n", ...[1, 2, 3, 4, 5].map((n) => `int wrong_${n};\n`)]);
  assert.equal(first.attempts.length, 6);
  assert.equal(first.firstAttempt, 1);
  assert.equal(first.finalAttempt, 6);
  assert.equal(first.restoration.status, "pass");
  assert.equal((await stat(options.workspace)).ino, before.ino);
  assert.equal(await readFile(`/proc/self/fd/${mounted.fd}/main.cpp`, "utf8"), "int canonical;\n");
  await assert.rejects(readFile(path.join(options.workspace, "debug.bin")));
  assert.equal(
    await readFile(
      path.join(options.output, "checks/round-001-attempt-1/candidate/source/main.cpp"),
      "utf8",
    ),
    "int wrong_1;\n",
  );
  assert.equal(
    await readFile(
      path.join(options.output, "checks/round-001-attempt-6/candidate/source/main.cpp"),
      "utf8",
    ),
    "int wrong_6;\n",
  );
  assert.deepEqual(
    options.notices.map((entries) => entries.length),
    [1, 1],
  );
  const second = await runRestoringRound({
    ...options,
    round: "round-002",
    interval,
    priorBoundary: first.boundary,
    executeAttempt: async ({ attempt }) => {
      assert.equal(attempt, 1);
      assert.equal(
        await readFile(path.join(options.workspace, "main.cpp"), "utf8"),
        "int canonical;\n",
      );
      options.notices[0].length = 0;
    },
    measureCandidate: async () => measured(1),
  });
  assert.equal(second.attempts.length, 1);
  assert.deepEqual(
    options.notices.map((entries) => entries.length),
    [1, 2],
  );
});

test("a failed first-check reference stops without treating one failure as editing exhaustion", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    runRestoringRound({
      ...options,
      round: "round-001",
      interval,
      maxAttempts: 1,
      executeAttempt: async () =>
        writeFile(path.join(options.workspace, "main.cpp"), "int failed;\n"),
      measureCandidate: async () => measured(0),
    }),
    { code: "RESTORING_ATTEMPTS_INCOMPLETE", category: "infrastructure" },
  );
  assert.equal(await readFile(path.join(options.workspace, "main.cpp"), "utf8"), "int failed;\n");
  const outcome = JSON.parse(
    await readFile(path.join(options.output, "checks/round-001-attempt-1/outcome.json"), "utf8"),
  );
  assert.equal(outcome.passedAtoms, 0);
  assert.deepEqual(options.notices, [[], []]);
  await assert.rejects(stat(path.join(options.output, "restorations")), { code: "ENOENT" });
});
test("a successful candidate is preserved and then canonicalized without granting extra credit", async (t) => {
  const options = await fixture(t);
  const canonical = { nodes: [{ id: "one" }], expectedTree: { "main.cpp": "int a;\nint b;\n" } };
  const result = await runRestoringRound({
    ...options,
    round: "round-001",
    interval: canonical,
    executeAttempt: async () =>
      writeFile(path.join(options.workspace, "main.cpp"), "int b;\nint a;\n"),
    measureCandidate: async (candidate) => {
      assert.equal(candidate.tree["main.cpp"], "int b;\nint a;\n");
      return measured(1);
    },
  });
  assert.equal(result.attempts[0].passedAtoms, 1);
  assert.equal(result.attempts[0].score, 100);
  assert.equal(
    await readFile(path.join(options.workspace, "main.cpp"), "utf8"),
    canonical.expectedTree["main.cpp"],
  );
  assert.equal(
    await readFile(
      path.join(options.output, "checks/round-001-attempt-1/candidate/source/main.cpp"),
      "utf8",
    ),
    "int b;\nint a;\n",
  );
});

test("late writes are infrastructure failures, not extra model attempts or restoration", async (t) => {
  const options = await fixture(t);
  let deliveries = 0;
  await assert.rejects(
    runRestoringRound({
      ...options,
      round: "round-001",
      interval,
      executeAttempt: async () => {
        deliveries++;
      },
      measureCandidate: async () => {
        await writeFile(path.join(options.workspace, "main.cpp"), "int late;\n");
        return measured(1);
      },
    }),
    (error) => error.category === "infrastructure",
  );
  assert.equal(deliveries, 1);
  assert.equal(await readFile(path.join(options.workspace, "main.cpp"), "utf8"), "int late;\n");
  assert.deepEqual(options.notices, [[], []]);
});

test("an unsafe canonical endpoint fails restoration after retaining the measured candidate", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    runRestoringRound({
      ...options,
      round: "round-001",
      interval: { nodes: interval.nodes, expectedTree: { "../escape.cpp": "int invalid;\n" } },
      executeAttempt: async () => {},
      measureCandidate: async () => measured(1),
    }),
    (error) => error.category === "infrastructure",
  );
  assert.equal(
    await readFile(
      path.join(options.output, "checks/round-001-attempt-1/candidate/source/main.cpp"),
      "utf8",
    ),
    "int initial;\n",
  );
  assert.equal(await readFile(path.join(options.workspace, "main.cpp"), "utf8"), "int initial;\n");
});

test("invalid score weights fail before opening an editing delivery", async (t) => {
  const options = await fixture(t);
  let deliveries = 0;
  await assert.rejects(
    runRestoringRound({
      ...options,
      round: "round-001",
      interval,
      buildWeight: Infinity,
      executeAttempt: async () => {
        deliveries++;
      },
      measureCandidate: async () => measured(1),
    }),
  );
  assert.equal(deliveries, 0);
});

test("a participant that becomes busy after a check cannot receive the next repair", async (t) => {
  const options = await fixture(t);
  let busy = false,
    deliveries = 0;
  options.drivers[0].assertIdle = async () => {
    if (busy) throw Object.assign(new Error("busy"), { category: "driver_exit" });
  };
  await assert.rejects(
    runRestoringRound({
      ...options,
      round: "round-001",
      interval,
      executeAttempt: async () => {
        deliveries++;
      },
      measureCandidate: async () => measured(0),
      onAttempt: async () => {
        busy = true;
      },
    }),
    (error) => error.category === "driver_exit",
  );
  assert.equal(deliveries, 1);
});
test("a non-idle or dead participant stops the boundary without grading or healing", async (t) => {
  const options = await fixture(t);
  let measuredCount = 0;
  options.drivers[1].assertIdle = async () => {
    throw Object.assign(new Error("dead"), { category: "driver_exit" });
  };
  await assert.rejects(
    runRestoringRound({
      ...options,
      round: "round-001",
      interval,
      executeAttempt: async () => {},
      measureCandidate: async () => {
        measuredCount++;
        return measured(1);
      },
    }),
    (error) => error.category === "driver_exit",
  );
  assert.equal(measuredCount, 0);
  assert.equal(await readFile(path.join(options.workspace, "main.cpp"), "utf8"), "int initial;\n");
});
