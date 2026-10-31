import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { runRoundPool } from "../../src/suites/explicit-edit-multi-agent/execution/round-pool.mjs";
import { createProviderRecovery } from "../../src/suites/explicit-edit-multi-agent/execution/provider-recovery.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_IDE_RUNTIME;
const options = { skip: !runtime || process.platform !== "linux", timeout: 180000 };

async function live(identity) {
  const stat = await readFile(`/proc/${identity.agentHostPid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  assert.equal(fields[19], identity.agentStart);
  assert.equal(await readlink(`/proc/${identity.agentHostPid}/ns/pid`), identity.namespace);
  assert.ok(!["Z", "X"].includes(fields[0]));
}

async function noNamespaceProcesses(identities) {
  const namespaces = new Set(identities.map(({ namespace }) => namespace));
  const remaining = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!namespaces.has(await readlink(`/proc/${pid}/ns/pid`))) continue;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (
        !["Z", "X"].includes(
          stat
            .slice(stat.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/)[0],
        )
      )
        remaining.push(pid);
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  assert.deepEqual(remaining, []);
}

function latest(body) {
  const content = body.messages.findLast(({ role }) => role === "user").content;
  return JSON.parse(
    typeof content === "string" ? content : content.map(({ text }) => text ?? "").join(""),
  );
}

async function setup(t, respond, { onRecovery, onProviderFailure } = {}) {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/canonical-pool-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const provider = await providerFixture(root, respond, { retainRequests: false });
  const drivers = [];
  t.after(async () => {
    const outcomes = await Promise.allSettled(drivers.map((driver) => driver.terminate()));
    provider.close();
    await rm(root, { recursive: true, force: true });
    for (const result of outcomes) if (result.status === "rejected") throw result.reason;
  });
  return {
    root,
    workspace,
    provider,
    drivers,
    createDriver: async (agent, session, { signal }) => {
      const driver = await startPiParticipant(
        workspace,
        path.join(root, `session-${drivers.length}-${agent}-${session}`),
        { ...provider.config, runtime, harness: "pi-agent-ide-codemode" },
        { signal, enforceProcessBoundary: true, onRecovery, onProviderFailure },
      );
      drivers.push(driver);
      return driver;
    },
  };
}

test(
  "the round-ready pool fills the configured real IDE namespace capacity and reuses history",
  options,
  async (t) => {
    const capacity = Number(process.env.RENDERER_NATIVE_CAPACITY ?? 30);
    assert.ok(Number.isSafeInteger(capacity) && capacity > 0 && capacity <= 50);
    const participants = [];
    const gate = Promise.withResolvers();
    let arrivals = 0,
      nativePeak = 0;
    const counts = [];
    const f = await setup(
      t,
      async (body) => {
        if (body.messages.at(-1).role === "tool") return {};
        const { value } = latest(body);
        counts.push(body.messages.filter(({ role }) => role === "user").length);
        arrivals++;
        if (arrivals === capacity) {
          try {
            assert.equal(participants.length, capacity);
            assert.equal(
              new Set(participants.map(({ process }) => process.agentHostPid)).size,
              capacity,
            );
            assert.equal(
              new Set(participants.map(({ process }) => process.namespace)).size,
              capacity,
            );
            await Promise.all(participants.map(({ process }) => live(process)));
            nativePeak = participants.length;
            gate.resolve();
          } catch (error) {
            gate.reject(error);
            throw error;
          }
        }
        await gate.promise;
        return { command: `printf '%s' '${value}' > /workspace/packet-${value}.txt` };
      },
      {
        onRecovery() {
          throw Error("Capacity fixture unexpectedly entered recovery");
        },
      },
    );
    const nodes = Array.from({ length: capacity + 2 }, (_, value) => ({
      id: `packet-${value}`,
      value,
      dependencies: [],
    }));
    const result = await runRoundPool(nodes, {
      maxAgents: capacity,
      batchSize: 1,
      signal: t.signal,
      createDriver: f.createDriver,
      onParticipant: ({ participant }) => participants.push(participant),
      executeBatch: (driver, [node], { signal }) =>
        driver.execute(JSON.stringify({ value: node.value }), { completion: "turn", signal }),
    });
    assert.equal(result.status, "drained");
    assert.deepEqual(
      result.delivered,
      nodes.map(({ id }) => id),
    );
    assert.equal(nativePeak, capacity);
    assert.equal(result.records.length, capacity);
    assert.ok(result.records.every(({ created, closed }) => created && closed));
    assert.equal(new Set(participants.map(({ sessionId }) => sessionId)).size, capacity);
    assert.equal(counts.length, capacity + 2);
    assert.ok(counts.some((count) => count > 1));
    assert.equal(counts.filter((count) => count === 1).length, capacity);
    assert.equal(f.provider.errors.length, 0);
    for (const { value } of nodes)
      assert.equal(
        await readFile(path.join(f.workspace, `packet-${value}.txt`), "utf8"),
        String(value),
      );
    await noNamespaceProcesses(participants.map(({ process }) => process));
    if (process.env.RENDERER_CANONICAL_POOL_EVIDENCE)
      await writeFile(
        process.env.RENDERER_CANONICAL_POOL_EVIDENCE,
        JSON.stringify({
          nativePeak,
          participants,
          closed: result.records.map(({ closed }) => closed),
          userCounts: counts,
          remainingNamespaceProcesses: [],
          sources: Object.fromEntries(
            await Promise.all(
              ["round-pool.mjs", "pi-baseline.mjs", "pi-baseline-observer.mjs"].map(
                async (file) => [
                  file,
                  createHash("sha256")
                    .update(
                      await readFile(
                        new URL(
                          "../../src/suites/explicit-edit-multi-agent/execution/" + file,
                          import.meta.url,
                        ),
                      ),
                    )
                    .digest("hex"),
                ],
              ),
            ),
          ),
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
  },
);

test(
  "separate correction waves start fresh native identities and close every namespace between cohorts",
  options,
  async (t) => {
    const counts = [];
    const f = await setup(t, (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      counts.push(body.messages.filter(({ role }) => role === "user").length);
      return { command: "true" };
    });
    const participants = [];
    for (const stage of ["original", "structural-correction"]) {
      const result = await runRoundPool([{ id: stage, dependencies: [] }], {
        maxAgents: 2,
        signal: t.signal,
        createDriver: f.createDriver,
        onParticipant: ({ participant }) => participants.push(participant),
        executeBatch: (driver, [node], { signal }) =>
          driver.execute(JSON.stringify({ stage: node.id }), { completion: "turn", signal }),
      });
      assert.ok(result.records.every(({ closed }) => closed));
      await noNamespaceProcesses(participants.map(({ process }) => process));
    }
    assert.deepEqual(counts, [1, 1]);
    for (const field of ["sessionId", "lifetime"])
      assert.equal(new Set(participants.map((row) => row[field])).size, 2);
    assert.equal(new Set(participants.map(({ process }) => JSON.stringify(process))).size, 2);
    assert.equal(f.provider.errors.length, 0);
  },
);

test(
  "a finished native worker closes before a peer can release dependent work",
  options,
  async (t) => {
    const retired = Promise.withResolvers();
    let closedFirst = false;
    const counts = new Map();
    const participants = [];
    const f = await setup(t, async (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const { value } = latest(body);
      counts.set(value, body.messages.filter(({ role }) => role === "user").length);
      if (value === "B") {
        await retired.promise;
        assert.equal(closedFirst, true);
        await noNamespaceProcesses([participants[0].process]);
      }
      return { command: "true" };
    });
    t.after(() => retired.resolve());
    const result = await runRoundPool(
      [
        { id: "A", dependencies: [] },
        { id: "B", dependencies: [] },
        { id: "C", dependencies: ["A", "B"] },
      ],
      {
        maxAgents: 2,
        batchSize: 1,
        signal: t.signal,
        createDriver: f.createDriver,
        onParticipant: ({ agent, participant }) => {
          participants[agent] = participant;
        },
        onClosed: async ({ agent, closed }) => {
          if (agent === 0) {
            assert.equal(closed, true);
            closedFirst = true;
            retired.resolve();
          }
        },
        executeBatch: (driver, [node], { signal }) =>
          driver.execute(JSON.stringify({ value: node.id }), { completion: "turn", signal }),
      },
    );
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.delivered, ["A", "B", "C"]);
    assert.deepEqual(Object.fromEntries(counts), { A: 1, B: 1, C: 2 });
    assert.ok(result.records.every(({ closed }) => closed));
    await noNamespaceProcesses(participants.map(({ process }) => process));
    assert.equal(f.provider.errors.length, 0);
  },
);

test(
  "a native provider failure drains a healthy peer without cancelling or starting new work",
  options,
  async (t) => {
    const peerStarted = Promise.withResolvers();
    const refused = Promise.withResolvers();
    t.after(() => {
      peerStarted.resolve();
      refused.resolve();
    });
    const f = await setup(t, async (body) => {
      const { value } = latest(body);
      if (value === "A") {
        await peerStarted.promise;
        return { status: 401, error: "fixture-access-denied" };
      }
      if (body.messages.at(-1).role === "tool") return {};
      if (value === "B") {
        peerStarted.resolve();
        await refused.promise;
      }
      return { command: `printf '%s\\n' '${value}' >> /workspace/completed-${value}.txt` };
    });
    const participants = [];
    const running = runRoundPool(
      [
        { id: "A", dependencies: [] },
        { id: "B", dependencies: [] },
        { id: "C", dependencies: ["B"] },
        { id: "blocked", dependencies: ["A"] },
      ],
      {
        maxAgents: 2,
        batchSize: 1,
        signal: t.signal,
        createDriver: f.createDriver,
        onParticipant: ({ participant }) => participants.push(participant),
        onDelivery: (event) => {
          if (event.event === "end" && event.ids.includes("A")) refused.resolve();
        },
        executeBatch: (driver, [node], { signal }) =>
          driver.execute(JSON.stringify({ value: node.id }), { completion: "turn", signal }),
      },
    );
    await assert.rejects(running, (error) => {
      assert.equal(error.category, "provider_failure");
      assert.deepEqual(
        error.roundPool.deliveries
          .map(({ ids, status }) => ({ ids, status }))
          .sort((a, b) => a.ids[0].localeCompare(b.ids[0])),
        [
          { ids: ["A"], status: "error" },
          { ids: ["B"], status: "settled" },
        ],
      );
      assert.ok(error.roundPool.records.every(({ closed }) => closed));
      return true;
    });
    for (const id of ["B"])
      assert.equal(
        await readFile(path.join(f.workspace, `completed-${id}.txt`), "utf8"),
        `${id}\n`,
      );
    await noNamespaceProcesses(participants.map(({ process }) => process));
    assert.equal(f.provider.errors.length, 0);
  },
);

test(
  "a terminal refusal stops held recovery probes but drains a healthy native peer",
  options,
  async (t) => {
    const recovery = createProviderRecovery({ cooldownMs: 25 });
    const held = Promise.withResolvers();
    const terminal = Promise.withResolvers();
    t.after(() => {
      held.resolve();
      terminal.resolve();
    });
    let afterTool = 0;
    const seen = [];
    const f = await setup(
      t,
      async (body) => {
        const { value } = latest(body);
        seen.push(value);
        if (value === "B") {
          await held.promise;
          return { status: 429, error: "GoUsageLimitError" };
        }
        if (value === "C") await terminal.promise;
        if (body.messages.at(-1).role === "tool")
          return value === "A" && ++afterTool <= 4 ? { streamError: "WebSocket error" } : {};
        return { command: `printf '%s\\n' '${value}' >> /workspace/completed-${value}.txt` };
      },
      {
        async onRecovery(request) {
          held.resolve();
          await terminal.promise;
          return recovery.wait(request);
        },
        onProviderFailure: (error) => recovery.stop(error),
      },
    );
    const participants = [];
    const running = runRoundPool(
      [
        { id: "A", dependencies: [] },
        { id: "B", dependencies: [] },
        { id: "C", dependencies: [] },
        { id: "D", dependencies: ["A", "C"] },
      ],
      {
        maxAgents: 3,
        batchSize: 1,
        signal: t.signal,
        createDriver: f.createDriver,
        onParticipant: ({ participant }) => participants.push(participant),
        onDelivery(event) {
          if (event.event === "end" && event.ids.includes("B")) terminal.resolve();
        },
        async executeBatch(driver, [node], { signal }) {
          await recovery.admit({ signal });
          return driver.execute(JSON.stringify({ value: node.id }), { completion: "turn", signal });
        },
      },
    );
    await assert.rejects(running, (error) => {
      assert.equal(error.category, "provider_failure");
      const failedA = error.roundPool.deliveries.find(({ ids }) => ids.includes("A")).receipt;
      const failedB = error.roundPool.deliveries.find(({ ids }) => ids.includes("B")).receipt;
      assert.notEqual(failedA.sessionId, failedB.sessionId);
      assert.equal(error.execution.sessionId, failedB.sessionId);
      assert.deepEqual(
        error.roundPool.deliveries
          .map(({ ids, status }) => ({ ids, status }))
          .sort((a, b) => a.ids[0].localeCompare(b.ids[0])),
        [
          { ids: ["A"], status: "error" },
          { ids: ["B"], status: "error" },
          { ids: ["C"], status: "settled" },
        ],
      );
      assert.ok(error.roundPool.records.every(({ closed }) => closed));
      return true;
    });
    assert.equal(afterTool, 4);
    assert.equal(seen.includes("D"), false);
    assert.equal(await readFile(path.join(f.workspace, "completed-A.txt"), "utf8"), "A\n");
    assert.equal(await readFile(path.join(f.workspace, "completed-C.txt"), "utf8"), "C\n");
    await noNamespaceProcesses(participants.map(({ process }) => process));
    assert.equal(f.provider.errors.length, 0);
  },
);

test(
  "cancelling a held native recovery closes its namespace without waiting for the controller callback",
  options,
  async (t) => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const held = Promise.withResolvers();
    const reason = new Error("fixture-cancel-held-recovery");
    let calls = 0;
    const f = await setup(
      t,
      async (body) => {
        calls++;
        return body.messages.at(-1).role === "tool"
          ? { streamError: "WebSocket error" }
          : { command: "printf 'once\\n' >> /workspace/completed-A.txt" };
      },
      {
        onRecovery(request) {
          held.resolve(request);
          return new Promise(() => {});
        },
      },
    );
    const participants = [];
    const running = runRoundPool([{ id: "A", dependencies: [] }], {
      maxAgents: 1,
      batchSize: 1,
      signal: controller.signal,
      createDriver: f.createDriver,
      onParticipant: ({ participant }) => participants.push(participant),
      executeBatch: (driver, [node], { signal }) =>
        driver.execute(JSON.stringify({ value: node.id }), { completion: "turn", signal }),
    });
    const rejected = assert.rejects(running, (error) => {
      assert.equal(error, reason);
      assert.ok(error.roundPool.records.every(({ closed }) => closed));
      assert.equal(error.roundPool.deliveries[0].status, "cancelled");
      return true;
    });
    const request = await held.promise;
    assert.equal(request.signal.aborted, false);
    await live(participants[0].process);
    controller.abort(reason);
    await rejected;
    assert.equal(request.signal.aborted, true);
    assert.equal(calls, 5);
    assert.equal(await readFile(path.join(f.workspace, "completed-A.txt"), "utf8"), "once\n");
    await noNamespaceProcesses(participants.map(({ process }) => process));
    assert.equal(f.provider.errors.length, 0);
  },
);

for (const refusal of [
  { name: "authentication", status: 401, error: "invalid credential" },
  { name: "quota", status: 429, error: "GoUsageLimitError" },
  { name: "billing", status: 429, error: "insufficient_quota" },
]) {
  test(`controller recovery does not retry native ${refusal.name} refusal`, options, async (t) => {
    let calls = 0;
    let recoveries = 0;
    const f = await setup(
      t,
      async () => {
        calls++;
        return { status: refusal.status, error: refusal.error };
      },
      {
        onRecovery() {
          recoveries++;
          throw Error("Nonretryable refusal entered controller recovery");
        },
      },
    );
    const participants = [];
    await assert.rejects(
      runRoundPool([{ id: "A", dependencies: [] }], {
        maxAgents: 1,
        batchSize: 1,
        signal: t.signal,
        createDriver: f.createDriver,
        onParticipant: ({ participant }) => participants.push(participant),
        executeBatch: (driver, [node], { signal }) =>
          driver.execute(JSON.stringify({ value: node.id }), { completion: "turn", signal }),
      }),
      (error) => {
        assert.equal(error.category, "provider_failure");
        assert.ok(error.roundPool.records.every(({ closed }) => closed));
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(recoveries, 0);
    await noNamespaceProcesses(participants.map(({ process }) => process));
    assert.equal(f.provider.errors.length, 0);
  });
}

test(
  "exhausted native retries hold one delivery while peers finish, then continue without replay",
  options,
  async (t) => {
    const recovery = createProviderRecovery({ cooldownMs: 25 });
    const held = Promise.withResolvers();
    const admissionWaiting = Promise.withResolvers();
    t.after(() => {
      held.resolve();
      admissionWaiting.resolve();
    });
    const requests = [];
    const recoveries = [];
    const completions = [];
    let afterTool = 0;
    const f = await setup(
      t,
      async (body) => {
        const { value } = latest(body);
        const users = body.messages
          .filter(({ role }) => role === "user")
          .map(
            ({ content }) =>
              JSON.parse(
                typeof content === "string"
                  ? content
                  : content.map(({ text }) => text ?? "").join(""),
              ).value,
          );
        requests.push({ value, users, lastRole: body.messages.at(-1).role });
        if (value === "B" && body.messages.at(-1).role !== "tool") await held.promise;
        if (body.messages.at(-1).role === "tool") {
          if (value === "A") {
            if (++afterTool <= 4) return { streamError: '{"detail":"Rate limit exceeded"}' };
            await admissionWaiting.promise;
            assert.equal(
              requests.some(({ value }) => value === "C"),
              false,
            );
          }
          return {};
        }
        return { command: `printf '%s\\n' '${value}' >> /workspace/completed-${value}.txt` };
      },
      {
        async onRecovery(request) {
          recoveries.push(request);
          const pending = recovery.wait(request);
          held.resolve();
          const lease = await pending;
          return {
            complete(success) {
              completions.push(success);
              lease.complete(success);
            },
          };
        },
      },
    );
    const participants = [];
    const result = await runRoundPool(
      [
        { id: "A", dependencies: [] },
        { id: "B", dependencies: [] },
        { id: "C", dependencies: ["B"] },
        { id: "D", dependencies: ["A"] },
      ],
      {
        maxAgents: 2,
        batchSize: 1,
        signal: t.signal,
        createDriver: f.createDriver,
        onParticipant: ({ participant }) => participants.push(participant),
        onDelivery(event) {
          if (event.event !== "end") return;
          if (event.ids.includes("A") && event.status !== "settled") held.resolve();
          if (event.ids.includes("D")) assert.equal(completions[0], true);
        },
        async executeBatch(driver, [node], { signal }) {
          if (node.id === "C") admissionWaiting.resolve();
          await recovery.admit({ signal });
          return driver.execute(JSON.stringify({ value: node.id }), { completion: "turn", signal });
        },
      },
    );
    assert.equal(recoveries.length, 1);
    assert.deepEqual(completions, [true]);
    assert.equal(afterTool, 5);
    assert.deepEqual(
      result.deliveries
        .map(({ ids, status }) => ({ ids, status }))
        .sort((a, b) => a.ids[0].localeCompare(b.ids[0])),
      [
        { ids: ["A"], status: "settled" },
        { ids: ["B"], status: "settled" },
        { ids: ["C"], status: "settled" },
        { ids: ["D"], status: "settled" },
      ],
    );
    const receipt = result.deliveries.find(({ ids }) => ids.includes("A")).receipt;
    assert.equal(receipt.sessionId, recoveries[0].sessionId);
    assert.equal(receipt.lifetime, recoveries[0].lifetime);
    assert.equal(receipt.toolCalls, 1);
    const recoveredDriver = f.drivers.find(({ events }) =>
      events.some(
        (event) => event.type === "baseline_observation" && event.sessionId === receipt.sessionId,
      ),
    );
    assert.equal(
      recoveredDriver.events.filter(
        (event) => event.type === "message_end" && event.message?.stopReason === "error",
      ).length,
      4,
    );
    assert.equal(
      receipt.lifecycle.filter(
        ({ type, success }) => type === "auto_retry_end" && success === false,
      ).length,
      1,
    );
    assert.equal(
      receipt.lifecycle.filter(
        ({ type, success }) => type === "provider_recovery_end" && success === true,
      ).length,
      1,
    );
    assert.ok(
      requests
        .filter(({ value }) => value === "A")
        .every(({ users }) => JSON.stringify(users) === '["A"]'),
    );
    for (const id of ["A", "B", "C", "D"])
      assert.equal(
        await readFile(path.join(f.workspace, `completed-${id}.txt`), "utf8"),
        `${id}\n`,
      );
    assert.ok(result.records.every(({ closed }) => closed));
    await noNamespaceProcesses(participants.map(({ process }) => process));
    assert.equal(f.provider.errors.length, 0);
  },
);

test(
  "repeated exhausted cycles keep one native delivery and do not reopen admission between probes",
  options,
  async (t) => {
    const events = [];
    const recovery = createProviderRecovery({
      cooldownMs: 25,
      onEvent: (event) => events.push(event),
    });
    const completions = [];
    let afterTool = 0;
    const f = await setup(
      t,
      async (body) => {
        assert.equal(body.messages.filter(({ role }) => role === "user").length, 1);
        if (body.messages.at(-1).role !== "tool")
          return { command: "printf 'once\\n' >> /workspace/once.txt" };
        return ++afterTool <= 8 ? { streamError: "Connection error." } : {};
      },
      {
        async onRecovery(request) {
          const lease = await recovery.wait(request);
          return {
            complete(success) {
              completions.push(success);
              lease.complete(success);
            },
          };
        },
      },
    );
    const participants = [];
    const result = await runRoundPool([{ id: "A", dependencies: [] }], {
      maxAgents: 1,
      batchSize: 1,
      signal: t.signal,
      createDriver: f.createDriver,
      onParticipant: ({ participant }) => participants.push(participant),
      executeBatch: (driver, [node], { signal }) =>
        driver.execute(JSON.stringify({ value: node.id }), { completion: "turn", signal }),
    });
    assert.deepEqual(completions, [false, true]);
    assert.deepEqual(
      events.map(({ type }) => type),
      [
        "provider_recovery_cooldown",
        "provider_recovery_probe",
        "provider_recovery_cooldown",
        "provider_recovery_probe",
        "provider_recovery_ready",
      ],
    );
    assert.equal(result.records.length, 1);
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0].status, "settled");
    assert.equal(result.deliveries[0].receipt.toolCalls, 1);
    assert.equal(afterTool, 9);
    assert.equal(await readFile(path.join(f.workspace, "once.txt"), "utf8"), "once\n");
    assert.ok(result.records.every(({ closed }) => closed));
    await noNamespaceProcesses(participants.map(({ process }) => process));
    assert.equal(f.provider.errors.length, 0);
  },
);

test(
  "native recovery keeps peers and dependent deliveries in the same round",
  options,
  async (t) => {
    const started = new Set();
    const bothStarted = Promise.withResolvers();
    const retryInjected = Promise.withResolvers();
    t.after(() => {
      bothStarted.resolve();
      retryInjected.resolve();
    });
    let failed = false;
    const f = await setup(t, async (body) => {
      const { value } = latest(body);
      if (body.messages.at(-1).role === "tool") {
        if (value === "A" && !failed) {
          failed = true;
          retryInjected.resolve();
          return { streamError: "WebSocket error" };
        }
        if (value === "B") await retryInjected.promise;
        return {};
      }
      if (value !== "C") {
        started.add(value);
        if (started.size === 2) bothStarted.resolve();
        await bothStarted.promise;
      }
      return { command: `printf '%s\\n' '${value}' >> /workspace/packet-${value}.txt` };
    });
    const participants = [];
    const nodes = [
      { id: "A", dependencies: [] },
      { id: "B", dependencies: [] },
      { id: "C", dependencies: ["A", "B"] },
    ];
    const result = await runRoundPool(nodes, {
      maxAgents: 2,
      batchSize: 1,
      signal: t.signal,
      createDriver: f.createDriver,
      onParticipant: ({ participant }) => participants.push(participant),
      executeBatch: (driver, [node], { signal }) =>
        driver.execute(JSON.stringify({ value: node.id }), { completion: "turn", signal }),
    });
    assert.equal(result.status, "drained");
    assert.deepEqual(result.delivered, ["A", "B", "C"]);
    assert.equal(result.records.length, 2);
    assert.ok(result.records.every(({ closed }) => closed));
    assert.equal(result.deliveries.length, 3);
    assert.ok(result.deliveries.every(({ status }) => status === "settled"));
    const a = result.deliveries.find(({ ids }) => ids.includes("A")).receipt;
    const c = result.deliveries.find(({ ids }) => ids.includes("C")).receipt;
    assert.equal(a.lifecycle.filter(({ type }) => type === "auto_retry_start").length, 1);
    assert.equal(
      a.lifecycle.filter(({ type, success }) => type === "auto_retry_end" && success).length,
      1,
    );
    assert.ok(
      participants.some(
        ({ sessionId, lifetime }) => c.sessionId === sessionId && c.lifetime === lifetime,
      ),
    );
    assert.ok(result.deliveries.every(({ receipt }) => receipt.toolCalls === 1));
    for (const { id } of nodes)
      assert.equal(await readFile(path.join(f.workspace, `packet-${id}.txt`), "utf8"), `${id}\n`);
    await noNamespaceProcesses(participants.map(({ process }) => process));
    assert.equal(f.provider.errors.length, 0);
  },
);
