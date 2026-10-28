import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { createDeliveryPool } from "../../src/suites/explicit-edit-multi-agent/execution/delivery-pool.mjs";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { runRestoring } from "../../src/suites/explicit-edit-multi-agent/execution/restoring-run.mjs";
import { restoringMultiAgentResult } from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";

function publicRows(body) {
  return body.messages
    .filter(({ role }) => role === "user")
    .flatMap(({ content }) => {
      const text =
        typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
      return text.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    });
}
const root = process.env.RENDERER_FRESH_OUTPUT;
assert.ok(root && process.env.RENDERER_PI_RUNTIME);

await test(
  "thirty real isolated agents bound concurrent packets while every later packet starts a new session",
  { timeout: 180000 },
  async (t) => {
    await mkdir(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const gate = Promise.withResolvers();
    let arrivals = 0;
    const provider = await providerFixture(root, async (body) => {
      const last = body.messages.at(-1);
      if (last.role === "tool") return {};
      const content =
        typeof last.content === "string"
          ? last.content
          : last.content.map((item) => item.text ?? "").join("");
      const { value } = JSON.parse(content);
      assert.equal(body.messages.filter(({ role }) => role === "user").length, 1);
      arrivals++;
      if (arrivals === 30) gate.resolve();
      await gate.promise;
      return { command: `printf '%s' '${value}' > /workspace/packet-${value}` };
    });
    t.after(() => provider.close());
    const participants = [];
    const pool = createDeliveryPool({
      size: 30,
      agentLifecycle: "per-delivery",
      createDriver: (agent, session) =>
        startBaseline(workspace, path.join(root, `state-${session}`), provider.config, {
          signal: t.signal,
          enforceProcessBoundary: true,
        }),
      onParticipant: ({ session, participant }) => participants.push({ session, ...participant }),
    });
    const receipts = [];
    try {
      const nodes = Array.from({ length: 32 }, (_, value) => ({
        id: `atom-${value}`,
        taskId: `task-${value}`,
        dependencies: [],
        value,
      }));
      const result = await runAtomicStream(nodes, {
        agents: 30,
        batchSize: 1,
        signal: t.signal,
        executeBatch: ([node], agent, signal) =>
          pool.execute(agent, false, async (driver, record) => {
            receipts.push({
              value: node.value,
              session: record.session,
              receipt: await driver.execute(JSON.stringify({ value: node.value }), { signal }),
            });
          }),
      });
      assert.equal(result.queues.length, 30);
      assert.equal(arrivals, 32);
      assert.equal(participants.length, 32);
      assert.equal(new Set(participants.map(({ sessionId }) => sessionId)).size, 32);
      assert.equal(new Set(participants.map(({ lifetime }) => lifetime)).size, 32);
      assert.ok(
        participants.every(
          ({ messageCount, process }) => messageCount === 0 && process.agentHostPid > 0,
        ),
      );
      assert.equal(
        new Set(participants.slice(0, 30).map(({ process }) => process.namespace)).size,
        30,
      );
      for (const item of receipts) {
        assert.equal(
          await readFile(path.join(workspace, `packet-${item.value}`), "utf8"),
          String(item.value),
        );
        assert.equal(item.receipt.messageCount, 5);
        assert.equal(item.receipt.toolCalls, 1);
        assert.equal(item.receipt.failedToolCalls, 0);
      }
    } finally {
      await pool.close();
    }
    assert.equal(pool.records.length, 32);
    assert.ok(pool.records.every(({ closed, driver }) => closed && driver === undefined));
    assert.equal(provider.errors.length, 0);
    await writeFile(
      path.join(root, "evidence.json"),
      JSON.stringify(
        { participants, receipts, closed: pool.records.map(({ closed }) => closed) },
        null,
        2,
      ) + "\n",
    );
  },
);

await test(
  "the real restoring runner reuses a retained task proof, recovers in context and resets every next original packet",
  { timeout: 180000 },
  async (t) => {
    const preparation = process.env.RENDERER_FRESH_PREPARATION;
    const proofPath = process.env.RENDERER_FRESH_PROOF;
    assert.ok(preparation && proofPath);
    const providerRoot = path.join(root, "runner-provider");
    await mkdir(providerRoot);
    let first = true;
    const turns = [];
    const provider = await providerFixture(providerRoot, (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const users = body.messages.filter(({ role }) => role === "user");
      turns.push(users.length);
      const request = publicRows(body).find((row) => row.mapping?.length && row.selectors?.length);
      assert.ok(request);
      if (first) {
        first = false;
        return { command: "true" };
      }
      const { mapping, selectors } = request;
      const payload = JSON.stringify({ mapping, selectors });
      return {
        command: `python3 - <<'PY'
from pathlib import Path
import re,json,fcntl
request=json.loads(${JSON.stringify(payload)})
with open('/workspace/.fixture-lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    p=Path('/workspace/main.cpp')
    text=p.read_text()
    for item in request['mapping']:
        before,after=item['from'],item['to']
        if before=='wrong':
            name=request['selectors'][0]['owner']['scope'].split('::')[-1]
            pattern=r'\\bint\\s+'+re.escape(name)+r'\\([^)]*\\)\\s*\\{[^}]*\\}'
            matches=list(re.finditer(pattern,text))
            assert len(matches)==1
            match=matches[0]
            part=re.sub(r'\\b'+re.escape(before)+r'\\b',after,match.group())
            text=text[:match.start()]+part+text[match.end():]
        else:
            text=re.sub(r'\\b'+re.escape(before)+r'\\b',after,text)
    p.write_text(text)
PY`,
      };
    });
    t.after(() => provider.close());
    const configPath = path.join(providerRoot, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        ...provider.config,
        agentLifecycle: "per-delivery",
        maxConcurrentAgents: 1,
      }),
    );
    const report = await runRestoring(preparation, path.join(root, "runner"), {
      agents: 2,
      batchSize: 1,
      configPath,
      proofPath,
      allowModelCalls: true,
      signal: t.signal,
    });
    assert.equal(report.status, "complete");
    assert.equal(report.agentLifecycle, "per-delivery");
    assert.equal(report.agents, 2);
    assert.equal(report.maxConcurrentAgents, 1);
    assert.equal(report.authorization.kind, "retained-task-feasibility");
    assert.equal(report.rounds[0].attempts.length, 2);
    assert.equal(report.rounds[0].attempts[0].passedAtoms, 0);
    assert.ok(
      report.rounds.every(
        ({ attempts }) => attempts.at(-1).passedAtoms === attempts.at(-1).totalAtoms,
      ),
    );
    const originals = report.executions.filter(
      ({ deliveryKind }) => deliveryKind !== "barrier-repair",
    );
    assert.equal(new Set(originals.map(({ session }) => session)).size, originals.length);
    assert.equal(new Set(originals.map(({ receipt }) => receipt.lifetime)).size, originals.length);
    assert.equal(new Set(originals.map(({ receipt }) => receipt.sessionId)).size, originals.length);
    const repair = report.executions.find(({ deliveryKind }) => deliveryKind === "barrier-repair");
    assert.equal(repair.session, originals[0].session);
    assert.equal(repair.receipt.sessionId, originals[0].receipt.sessionId);
    assert.deepEqual(turns, [1, 2, ...Array.from({ length: originals.length - 1 }, () => 1)]);
    assert.ok(report.agentsClosed.every(Boolean));
    assert.equal(report.agentsClosed.length, report.participants.length);
    assert.equal(report.participants.length, originals.length);
    assert.equal(originals.length, report.totalAtoms);
    assert.equal(report.repairs, 1);
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
      assert.equal(
        report.usage[field],
        report.executions.reduce((sum, { receipt }) => sum + receipt.usage[field], 0),
      );
    assert.equal(report.usage.totalTokens, report.deliveries * 60);
    assert.ok(report.executions.every(({ receipt }) => receipt.failedToolCalls === 0));
    assert.equal(provider.errors.length, 0);
    const safe = restoringMultiAgentResult(report);
    assert.equal(safe.configuration.agentLifecycle, "per-delivery");
    assert.equal(safe.configuration.maxConcurrentAgents, 1);
    assert.equal(safe.score.final.score, 100);
    await writeFile(path.join(root, "runner-result.json"), JSON.stringify(safe, null, 2) + "\n");
  },
);
