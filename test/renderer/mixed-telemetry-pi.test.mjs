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
    const provider = await providerFixture(root, (body) => ({
      command: body.messages.at(-1).role === "tool" ? undefined : "exit 7",
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
