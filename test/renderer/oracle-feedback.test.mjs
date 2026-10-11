import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runFullLive } from "../../scripts/multi-agent/experiments/full-live-run.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const proof = process.env.RENDERER_FULL_PROOF;
const output = process.env.RENDERER_ORACLE_OUTPUT;
assert.ok(
  proof && output && process.env.RENDERER_PI_RUNTIME,
  "Set the proven full workload, fresh output and pinned Pi runtime",
);

test(
  "one real Pi session receives only three coarse corrections, keeps edits and stops before the next batch",
  { timeout: 300000 },
  async (t) => {
    const root = path.resolve(output);
    await mkdir(root);
    const requests = JSON.parse(await readFile(path.join(proof, "requests.json"), "utf8"));
    const prompts = [];
    const provider = await providerFixture(root, (body) => {
      assert.deepEqual(
        body.tools.map((tool) => tool.function.name),
        ["bash"],
      );
      assert.ok(!body.messages.some((message) => message.role === "system" && message.content));
      if (body.messages.at(-1).role === "tool") return {};
      const current = body.messages.findLast((message) => message.role === "user").content;
      const prompt =
        typeof current === "string" ? current : current.map((part) => part.text ?? "").join("");
      if (prompts.length < 20) assert.equal(prompt, requests[prompts.length].prompt);
      else {
        assert.match(prompt, /The batch requirements are not met\./);
        assert.match(prompt, /Repair the current workspace for batch-001/);
        assert.doesNotMatch(
          prompt,
          /Unclosed|differs|Missing|compiler|\/trusted|\/checks|line \d+/i,
        );
      }
      assert.ok(prompts.length < 23, "No fourth correction or future task");
      prompts.push(prompt);
      return { command: "printf 'delivery\\n' >> /workspace/deliveries.txt" };
    });
    t.after(() => provider.close());
    const config = path.join(root, "config.json");
    await writeFile(config, JSON.stringify(provider.config));
    const report = await runFullLive(proof, config, path.join(root, "run"));
    assert.equal(report.status, "blocked");
    assert.equal(report.policy.trialTimeoutMs, null);
    assert.equal(report.policy.batchAttemptTimeoutMs, 1800000);
    assert.equal(report.passedRequests, 0);
    assert.equal(report.passedBatches, 0);
    assert.equal(report.deliveredRequests, 20);
    assert.equal(report.agentClosed, true);
    assert.equal(report.chain.batchReport.attempts.length, 4);
    assert.equal(report.chain.requests[20].status, "unattempted");
    assert.equal(report.final, report.initial);
    assert.equal(prompts.length, 23);
    assert.equal(
      await readFile(path.join(root, "run/workspace/deliveries.txt"), "utf8"),
      "delivery\n".repeat(23),
    );
    assert.equal(report.checks.filter((check) => check.status === "fail").length, 4);
    assert.ok(
      report.checks.filter((check) => check.status === "fail").every((check) => check.error),
    );
    for (const key of ["sessionId", "lifetime", "agentPid"])
      assert.equal(new Set(report.deliveries.map((delivery) => delivery.execution[key])).size, 1);
    console.log(
      "VERIFIED ORACLES: 20 original deliveries, 3 coarse corrections, 4 failed batch checks; one real Pi session, retained edits, no future task, zero model calls",
    );
  },
);
