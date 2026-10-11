import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { test } from "node:test";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { runRequestChain } from "../../src/suites/explicit-edit-multi-agent/execution/request-chain.mjs";
import { GradeFailure } from "../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import { providerFixture } from "./provider-fixture.mjs";

assert.ok(
  process.env.RENDERER_PI_RUNTIME,
  "Set RENDERER_PI_RUNTIME to the separate installed Pi runtime",
);

async function fixture(t, respond) {
  const root = await mkdtemp(path.resolve(".tmp/pi-baseline-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const provider = await providerFixture(root, respond);
  t.after(() => provider.close());
  const driver = await startBaseline(workspace, path.join(root, "state"), provider.config, {
    eventsFile: path.join(root, "events.jsonl"),
  });
  t.after(() => driver.close());
  return { driver, requests: provider.requests, workspace, root };
}

function checkProvider(requests) {
  for (const request of requests) {
    assert.deepEqual(
      request.tools.map((tool) => tool.function.name),
      ["bash"],
    );
    assert.ok(!request.messages.some((message) => message.role === "system" && message.content));
  }
}

test("real Pi keeps its process, conversation and bash-only baseline across edits and a correction", async (t) => {
  const { driver, requests, workspace } = await fixture(t, (body) => {
    if (body.messages.at(-1).role === "tool") return {};
    return {
      command:
        "printf 'edit\\n' >> edits.txt; test ! -e /root/.ssh; test ! -e /etc/shadow; test ! -w /state/observer/baseline.mjs",
    };
  });
  const results = [];
  for (const prompt of [
    "First edit \u2028 intact",
    "Correction: keep the first edit",
    "Second request",
  ])
    results.push(await driver.execute(prompt));
  assert.equal(await readFile(path.join(workspace, "edits.txt"), "utf8"), "edit\nedit\nedit\n");
  assert.equal(new Set(results.map((r) => r.sessionId)).size, 1);
  assert.equal(new Set(results.map((r) => r.lifetime)).size, 1);
  assert.equal(new Set(results.map((r) => r.agentPid)).size, 1);
  assert.ok(results[0].agentPid > 0);
  assert.ok(results[2].messageCount > results[0].messageCount);
  checkProvider(requests);
  assert.ok(JSON.stringify(requests.at(-1)).includes("First edit"));
  assert.ok(JSON.stringify(requests.at(-1)).includes("Correction:"));
  assert.deepEqual(
    results.map((r) => r.usage.totalTokens),
    [60, 60, 60],
  );
  assert.deepEqual(
    results.map((r) => r.toolCalls),
    [1, 1, 1],
  );
  assert.deepEqual(
    results.map((r) => r.failedToolCalls),
    [0, 0, 0],
  );
  assert.ok(results.every((r) => r.agentMs > 0));
  await driver.close();
  assert.equal(driver.closed, true);
});

test("real provider retry finishes before the next request and retains retry evidence", async (t) => {
  const { driver, requests } = await fixture(t, (_body, number) =>
    number === 1 ? { error: "fixture temporary failure", status: 503 } : {},
  );
  const first = await driver.execute("Retry this request");
  assert.ok(requests.length >= 2);
  assert.ok(first.lifecycle.some((event) => event.type.startsWith("auto_retry")));
  const second = await driver.execute("Next request");
  assert.equal(second.lifetime, first.lifetime);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.usage.totalTokens, 30);
});
test("native compaction is retained without restarting Pi or replacing the workspace", async (t) => {
  const { driver, requests } = await fixture(t, (_body, number) =>
    number === 3
      ? { usage: { prompt_tokens: 99000, completion_tokens: 10, total_tokens: 99010 } }
      : {},
  );
  const first = await driver.execute("First context " + "word ".repeat(16000));
  await driver.execute("Second context " + "word ".repeat(16000));
  await driver.execute("Third context " + "word ".repeat(16000));
  const next = await driver.execute("Continue after native compaction");
  assert.ok(requests.length > 4);
  assert.ok(driver.events.some((event) => event.type === "compaction_end" && event.result));
  assert.equal(next.lifetime, first.lifetime);
  assert.equal(next.sessionId, first.sessionId);
  assert.equal(next.agentPid, first.agentPid);
  assert.ok(next.usage.totalTokens > 0);
});
test("a cancelled real provider request stops the process and cannot edit later", async (t) => {
  const { driver, workspace } = await fixture(t, () => null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  t.after(() => clearTimeout(timer));
  await assert.rejects(driver.execute("wait", { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(driver.closed, true);
  await assert.rejects(readFile(path.join(workspace, "edits.txt")));
});

test("real Pi repairs retained edits, then stops after three failed attempts without the next request", async (t) => {
  const { driver, requests, workspace } = await fixture(t, (body) => {
    if (body.messages.at(-1).role === "tool") return {};
    return { command: "printf 'edit\\n' >> edits.txt" };
  });
  let grades = 0;
  const report = await runRequestChain(
    [
      { id: "repair", prompt: "Repairable" },
      { id: "blocked", prompt: "Blocked" },
      { id: "future", prompt: "DO NOT DELIVER" },
    ],
    {
      execute: ({ prompt, signal }) => driver.execute(prompt, { signal }),
      identity: async () => {
        try {
          return await readFile(path.join(workspace, "edits.txt"), "utf8");
        } catch {
          return "";
        }
      },
      grade: async () => {
        grades++;
        if (grades !== 2) throw new GradeFailure("build", "Observed broken build");
        return { status: "pass" };
      },
    },
  );
  assert.equal(report.status, "blocked");
  assert.equal(report.passedPrefix, 1);
  assert.equal(report.attempts.length, 5);
  assert.equal(report.steps[2].status, "unattempted");
  assert.equal(report.attempts[0].after, report.attempts[1].before);
  assert.equal(new Set(report.attempts.map((a) => a.execution.lifetime)).size, 1);
  assert.ok(report.attempts.every((a) => a.graderMs >= 0 && a.execution.agentMs > 0));
  assert.ok(JSON.stringify(requests).includes("Observed broken build"));
  assert.ok(!JSON.stringify(requests).includes("DO NOT DELIVER"));
  checkProvider(requests);
});

test("provider failure and unexpected real agent exit are distinct terminal outcomes", async (t) => {
  for (const [expected, respond] of [
    ["provider_failure", () => ({ error: "fixture denied" })],
    [
      "driver_exit",
      (body) => (body.messages.at(-1).role === "tool" ? {} : { command: 'kill -KILL "$PPID"' }),
    ],
  ]) {
    await t.test(expected, async (sub) => {
      const { driver } = await fixture(sub, respond);
      const report = await runRequestChain(
        [
          { id: "stop", prompt: "Stop honestly" },
          { id: "future", prompt: "DO NOT DELIVER" },
        ],
        {
          execute: ({ prompt, signal }) => driver.execute(prompt, { signal }),
          grade: async () => {
            throw Error("must not grade");
          },
          identity: async () => "state",
        },
      );
      assert.equal(report.status, expected);
      assert.equal(report.attempts.length, 1);
      assert.equal(report.steps[1].status, "unattempted");
      assert.ok(report.attempts[0].execution.agentMs > 0);
      await driver.close();
      assert.equal(driver.closed, true);
    });
  }
});

test("a timed-out real bash call cannot leave a process editing after the chain stops", async (t) => {
  const { driver, workspace } = await fixture(t, () => ({
    command: "sleep 1; echo late > late.txt",
  }));
  const report = await runRequestChain([{ id: "timeout", prompt: "Wait" }], {
    attemptTimeoutMs: 150,
    execute: ({ prompt, signal }) => driver.execute(prompt, { signal }),
    grade: async () => {
      throw Error("must not grade");
    },
    identity: async () => "state",
  });
  assert.equal(report.status, "timeout");
  assert.equal(driver.closed, true);
  assert.ok(report.attempts[0].execution);
  await delay(1100);
  await assert.rejects(readFile(path.join(workspace, "late.txt")));
});
