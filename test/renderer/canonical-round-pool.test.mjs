import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { runRoundPool } from "../../src/suites/explicit-edit-multi-agent/execution/round-pool.mjs";
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

async function setup(t, respond) {
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
    createDriver: async (agent, session, { signal }) => {
      const driver = await startPiParticipant(
        workspace,
        path.join(root, `session-${drivers.length}-${agent}-${session}`),
        { ...provider.config, runtime, harness: "pi-agent-ide-codemode" },
        { signal, enforceProcessBoundary: true },
      );
      drivers.push(driver);
      return driver;
    },
  };
}

test(
  "the round-ready pool fills exactly thirty real IDE namespaces and reuses history for later ready packets",
  options,
  async (t) => {
    const participants = [];
    const gate = Promise.withResolvers();
    let arrivals = 0,
      nativePeak = 0;
    const counts = [];
    const f = await setup(t, async (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const { value } = latest(body);
      counts.push(body.messages.filter(({ role }) => role === "user").length);
      arrivals++;
      if (arrivals === 30) {
        try {
          assert.equal(participants.length, 30);
          assert.equal(new Set(participants.map(({ process }) => process.agentHostPid)).size, 30);
          assert.equal(new Set(participants.map(({ process }) => process.namespace)).size, 30);
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
    });
    const nodes = Array.from({ length: 32 }, (_, value) => ({
      id: `packet-${value}`,
      value,
      dependencies: [],
    }));
    const result = await runRoundPool(nodes, {
      maxAgents: 30,
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
    assert.equal(nativePeak, 30);
    assert.equal(result.records.length, 30);
    assert.ok(result.records.every(({ created, closed }) => created && closed));
    assert.equal(new Set(participants.map(({ sessionId }) => sessionId)).size, 30);
    assert.equal(counts.length, 32);
    assert.ok(counts.some((count) => count > 1));
    assert.equal(counts.filter((count) => count === 1).length, 30);
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
