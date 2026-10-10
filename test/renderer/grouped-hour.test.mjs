import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runFullLive } from "../../scripts/multi-agent/experiments/full-live-run.mjs";
import { groupedRequests } from "../../scripts/multi-agent/experiments/grouped-requests.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const proof = process.env.RENDERER_FULL_PROOF;
const root = process.env.RENDERER_GROUPED_OUTPUT;
assert.ok(proof && root && process.env.RENDERER_PI_RUNTIME);
await mkdir(root);
const requests = JSON.parse(await readFile(path.join(proof, "requests.json"), "utf8"));
const lists = groupedRequests(requests);
assert.deepEqual(
  lists.flatMap((list) => list.requests.map((request) => request.id)),
  requests.map((request) => request.id),
);

async function fixture(name, respond) {
  const directory = path.join(root, name);
  await mkdir(directory);
  const provider = await providerFixture(directory, respond);
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify(provider.config));
  return { directory, provider, config, output: path.join(directory, "run") };
}

test(
  "a real Pi receives one complete list and three coarse corrections, not hundreds of individual prompts",
  { timeout: 120000 },
  async (t) => {
    const prompts = [];
    const f = await fixture("delivery", (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const content = body.messages.findLast((message) => message.role === "user").content;
      const prompt =
        typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].function.name, "bash");
      if (!prompts.length) assert.equal(prompt, lists[0].prompt);
      else {
        assert.match(prompt, /The batch requirements are not met\./);
        assert.doesNotMatch(prompt, /Move owner|Unclosed|differs|\/checks|\/trusted/);
      }
      assert.ok(prompts.length < 4);
      prompts.push(prompt);
      return { command: "printf 'list-delivery\\n' >> /workspace/deliveries.txt" };
    });
    t.after(() => f.provider.close());
    const report = await runFullLive(proof, f.config, f.output, { profile: "grouped-hour" });
    assert.equal(report.status, "blocked");
    assert.equal(report.policy.trialTimeoutMs, 3600000);
    assert.equal(report.requests, 2930);
    assert.equal(report.lists, lists.length);
    assert.equal(report.deliveredRequests, lists[0].requests.length);
    assert.equal(report.modelDeliveries, 4);
    assert.equal(report.passedRequests, 0);
    assert.equal(report.agentClosed, true);
    assert.equal(
      await readFile(path.join(f.output, "workspace/deliveries.txt"), "utf8"),
      "list-delivery\n".repeat(4),
    );
    assert.ok(
      report.chain.requests
        .slice(lists[0].requests.length)
        .every((request) => request.status === "unattempted"),
    );
    for (const key of ["agentPid", "sessionId", "lifetime"])
      assert.equal(new Set(report.deliveries.map((delivery) => delivery.execution[key])).size, 1);
  },
);

test(
  "the overall cap stops initial grading before any model request",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture("initial-timeout", () => {
      throw Error("No inference is allowed");
    });
    t.after(() => f.provider.close());
    const report = await runFullLive(proof, f.config, f.output, {
      profile: "grouped-hour",
      hourLimitMs: 1,
    });
    assert.equal(report.status, "timeout");
    assert.equal(report.passedRequests, 0);
    assert.equal(report.deliveredRequests, 0);
    assert.equal(f.provider.requests.length, 0);
    assert.equal(report.checks[0].label, "initial");
    assert.equal(report.checks[0].status, "fail");
  },
);

test(
  "a real deadline kills Pi and its shell children, retains edits and delivers no suffix",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture("active-timeout", () => ({
      command:
        "(sleep 20; printf late > /workspace/late.txt) & printf started > /workspace/started.txt; wait",
    }));
    t.after(() => f.provider.close());
    const report = await runFullLive(proof, f.config, f.output, {
      profile: "grouped-hour",
      hourLimitMs: 15000,
    });
    assert.equal(report.status, "timeout");
    assert.equal(report.agentClosed, true);
    assert.equal(report.passedRequests, 0);
    assert.equal(report.modelDeliveries, 1);
    assert.equal(await readFile(path.join(f.output, "workspace/started.txt"), "utf8"), "started");
    assert.equal(report.deliveries[0].execution.toolCalls, 1);
    assert.ok(report.elapsedMs < 20000);
    await delay(21000);
    await assert.rejects(access(path.join(f.output, "workspace/late.txt")), { code: "ENOENT" });
    await assert.rejects(access(path.join(f.output, "agent-state/pi/auth.json")), {
      code: "ENOENT",
    });
    assert.equal(report.deliveries.length, 1);
  },
);
