import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  runMixedProbe,
  verifyMixedProbe,
} from "../../src/suites/explicit-edit-multi-agent/extraction/assembly-run.mjs";
import { rescoreMixedRun } from "../../src/suites/explicit-edit-multi-agent/extraction/mixed-telemetry.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_RUNTIME;
const flatCase = process.env.RENDERER_FLAT_CASE;

test(
  "mixed run records host memory and native Pi activity with a localhost provider",
  { skip: process.platform !== "linux" || !runtime || !flatCase, timeout: 240000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/mixed-telemetry-pi-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = await providerFixture(root, (body, request) => ({
      command:
        body.messages.at(-1).role === "tool"
          ? undefined
          : request === 1
            ? "printf '// unrelated Pi test edit\\n' >> main.cpp; exit 7"
            : "exit 7",
      usage: {
        prompt_tokens: 20,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens: 10,
        total_tokens: 30,
      },
    }));
    t.after(() => provider.close());
    const counts = { moves: 25, unique: 0, shared: 0, parameters: 0 };
    const reference = path.join(root, "reference");
    const proof = await verifyMixedProbe(flatCase, reference, { counts });
    assert.equal(proof.status, "pass");
    const output = path.join(root, "run");
    const summary = await runMixedProbe(flatCase, output, provider.config, {
      proofPath: path.join(reference, "summary.json"),
      counts,
      agents: 2,
      sandbox: "shared",
    });
    assert.equal(summary.status, "complete");
    assert.equal(summary.verdict, "integrity-failed");
    assert.equal(summary.checks.integrity.passed, false);
    assert.equal(summary.checks.integrity.lines.added, 1);
    assert.equal(summary.checks.integrity.affectedLines, 1);
    assert.deepEqual(summary.integrityRelatedDeliveries, []);
    assert.ok(summary.deliveries > 0);
    assert.equal(summary.timedOut, 0);
    assert.equal(summary.behavior.deliveriesWithEvents, summary.deliveries);
    assert.equal(provider.requests.length, 2 * summary.deliveries);
    assert.deepEqual(provider.errors, []);
    assert.deepEqual(summary.behavior.perDelivery, {
      turns: 2,
      toolCalls: 1,
      toolErrors: 1,
      guideReads: 0,
      input: 24,
      cacheRead: 16,
      output: 20,
      callsByTool: { bash: 1 },
      errorsByToolAndKind: { bash: { other: 1 } },
      readsByGuide: {},
    });
    assert.ok(summary.hostMemory.minAvailableMiB > 0);
    assert.ok(Number.isFinite(summary.hostMemory.swapGrowthMiB));
    if (/^oom_kill /m.test(await readFile("/proc/vmstat", "utf8")))
      assert.ok(Number.isSafeInteger(summary.hostMemory.oomKills));
    assert.deepEqual(await rescoreMixedRun(output), summary);
  },
);

test(
  "an oversized native RPC event fails one shared-sandbox delivery and the queue keeps grading",
  { skip: process.platform !== "linux" || !runtime || !flatCase, timeout: 240000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/mixed-oversized-pi-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = await providerFixture(
      root,
      (_body, request) => (request === 2 ? { text: "large-output-".repeat(3 * 1024 * 1024) } : {}),
      { retainRequests: false },
    );
    t.after(() => provider.close());

    const counts = { moves: 25, unique: 0, shared: 0, parameters: 0 };
    const reference = path.join(root, "reference");
    const proof = await verifyMixedProbe(flatCase, reference, { counts });
    assert.equal(proof.status, "pass");
    assert.ok(proof.deliveries >= 3);
    const output = path.join(root, "run");
    const summary = await runMixedProbe(flatCase, output, provider.config, {
      proofPath: path.join(reference, "summary.json"),
      counts,
      agents: 1,
      sandbox: "shared",
    });
    assert.equal(summary.status, "complete");
    assert.equal(summary.verdict, "incomplete");
    assert.equal(summary.buildPassed, true);
    assert.equal(summary.resultMatched, true);
    assert.deepEqual(summary.checks.all, proof.checks.start);
    assert.equal(summary.deliveries, proof.deliveries);
    assert.equal(summary.timedOut, 0);
    assert.deepEqual(provider.errors, []);

    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    const [before, failed, ...after] = report.deliveries;
    assert.equal(before.status, "settled");
    assert.equal(failed.status, "error");
    assert.equal(failed.error.code, "RPC_RECORD_OVERSIZED");
    assert.equal(failed.error.stream, "stdout");
    assert.ok(after.length > 0 && after.every((row) => row.status === "settled"));
    assert.equal(new Set(report.deliveries.map(({ session }) => session)).size, proof.deliveries);
    assert.deepEqual(summary.failedDeliveries, [
      { id: failed.id, session: failed.session, error: failed.error },
    ]);
    const events = (
      await readFile(path.join(output, "mixed", `session-${failed.session}-events.jsonl`), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const diagnostic = events.find(({ type }) => type === "rpc_record_oversized");
    const started = events.findIndex(({ type }) => type === "agent_start");
    assert.ok(started >= 0 && started < events.indexOf(diagnostic));
    assert.equal(diagnostic.recordType, "message_update");
    assert.equal(diagnostic.bytes, failed.error.bytes);
    assert.ok(diagnostic.bytes > 32 * 1024 * 1024);
    assert.ok(Buffer.byteLength(diagnostic.head) <= 4096);
    assert.ok(Buffer.byteLength(diagnostic.tail) <= 4096);
    assert.match(diagnostic.head, /large-output-/);
    assert.match(diagnostic.tail, /large-output-/);
    assert.deepEqual(await rescoreMixedRun(output), summary);
  },
);
