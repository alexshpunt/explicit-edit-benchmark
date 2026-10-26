import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import * as protocol from "../../scripts/normalized-team-protocol.mjs";
import { runMultiAgentBatch, suiteVerifier } from "../../scripts/run-multi-agent-batch.mjs";
import {
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { tempDirectory } from "../helpers/temp.mjs";
import { atomicIdentity } from "../helpers/atomic-identity.mjs";
import {
  REFERENCE_EXECUTION_POLICY,
  referenceFirstPass,
} from "../../src/suites/explicit-edit-multi-agent/reference/execution-proof.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("atomic identities allow only the current dispatch contract and safe complete hashes", () => {
  const identity = atomicIdentity();
  assert.equal(typeof protocol.validateAtomicIdentity, "function");
  protocol.validateAtomicIdentity(identity);
  for (const [key, value] of Object.entries({
    version: "renderer-atomic-stream-v1",
    workloadSha256: "private file content",
    batchesSha256: "",
    dispatchPolicySha256: "a".repeat(64),
    edits: 0,
  })) {
    assert.throws(() => protocol.validateAtomicIdentity({ ...identity, [key]: value }));
  }
  assert.throws(() => protocol.validateAtomicIdentity({ ...identity, source: "private" }));
  assert.throws(() => protocol.validateAtomicIdentity(null));
});

test("normalized readers keep coarse diagnostics readable and validate an optional atomic identity", () => {
  let id = 0;
  const schedule = Array.from({ length: 28 }, (_, index) => ({
    id: `round-${String(index + 1).padStart(3, "0")}`,
    assignments: Array.from({ length: index < 15 ? 3 : 2 }, (_, agent) => ({
      agent,
      task: `task-${String(++id).padStart(3, "0")}`,
    })),
  }));
  const suite = {
    id: "explicit-edit-multi-agent",
    protocol: MULTI_AGENT_PROTOCOL,
    agents: 15,
    graphWidth: 15,
    workloadSha256: hash("tasks"),
    graphSha256: hash("graph"),
    scheduleSha256: hash(JSON.stringify(schedule)),
    schedule,
    observations: [],
  };
  const policy = { oracleRecoveries: 5, retryFailures: 0, concurrency: 15, timeoutMs: null };
  protocol.validateTeamSuite(suite, MULTI_AGENT_PROTOCOL, policy);
  protocol.validateTeamSuite({ ...suite, atomic: atomicIdentity() }, MULTI_AGENT_PROTOCOL, policy);
  protocol.validateTeamSuite({ ...suite, batchSize: 75 }, MULTI_AGENT_PROTOCOL, policy);
  for (const batchSize of [0, -1, 1.5, "50", null])
    assert.throws(() =>
      protocol.validateTeamSuite({ ...suite, batchSize }, MULTI_AGENT_PROTOCOL, policy),
    );
  assert.throws(
    () =>
      protocol.validateTeamSuite(
        { ...suite, atomic: { ...atomicIdentity(), edits: -1 } },
        MULTI_AGENT_PROTOCOL,
        policy,
      ),
    /Invalid atomic edit count/,
  );
});
await test("the common batch binds its atomic proof and artifacts before creating measured metadata", async (t) => {
  const root = await tempDirectory("atomic-common-proof-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const preparation = path.join(root, "preparation");
  await mkdir(path.join(preparation, "atomic"), { recursive: true });
  const workload = JSON.stringify({
    version: "renderer-atomic-workload-v1",
    nodes: Array.from({ length: 71 }, (_, i) => ({
      id: `task-${String(i + 1).padStart(3, "0")}-edit-00001`,
    })),
  });
  const batches = "[]\n";
  const atomic = {
    ...atomicIdentity(),
    workloadSha256: hash(workload),
    batchesSha256: hash(batches),
  };
  const manifest = {
    policy: MULTI_AGENT_POLICY,
    tasks: 71,
    graphWidth: 15,
    initial: hash("fixture"),
    workloadSha256: hash("tasks"),
    graphSha256: hash("graph"),
    atomic,
  };
  const proof = {
    status: "pass",
    protocol: MULTI_AGENT_PROTOCOL,
    policy: MULTI_AGENT_POLICY,
    agents: 15,
    batchSize: 50,
    acceptedAtomicEdits: 71,
    acceptedRounds: 1,
    repairs: 0,
    referenceFirstPass: referenceFirstPass({
      acceptedRounds: 1,
      totalRounds: 1,
      repairs: 0,
      atomic: { edits: 71 },
      atomicBarriers: [{ round: "fixture-round", attempt: 1, status: "accepted" }],
      checks: [
        { contractId: "initial", status: "pass" },
        { contractId: "fixture-round", status: "pass" },
      ],
      executions: [
        {
          attempt: 1,
          status: "settled",
          atomicIds: Array.from({ length: 71 }, (_, i) => `fixture-atom-${i}`),
        },
      ],
    }),
    referenceExecution: REFERENCE_EXECUTION_POLICY,
    referenceSourceSha256: await suiteVerifier(),
    referenceConcurrency: {
      executors: 15,
      maxWorking: 15,
      maxPlanning: 15,
      maxPublishing: 2,
      workIntervals: 71,
      planningIntervals: 71,
      publicationIntervals: 71,
    },
    atomic,
    scheduleSha256: hash("schedule"),
  };
  await writeFile(
    path.join(preparation, "tasks.json"),
    JSON.stringify(
      Array.from({ length: 71 }, (_, i) => ({ id: `task-${String(i + 1).padStart(3, "0")}` })),
    ),
  );
  await writeFile(path.join(preparation, "atomic/tasks.json"), workload);
  await writeFile(path.join(preparation, "atomic/batches.json"), batches);
  const attempt = async (name, prepared, evidence) => {
    await writeFile(path.join(preparation, "manifest.json"), JSON.stringify(prepared));
    await writeFile(path.join(preparation, "verification-15.json"), JSON.stringify(evidence));
    const output = path.join(root, name);
    await mkdir(output);
    const run = () =>
      runMultiAgentBatch({
        root: output,
        preparation,
        profiles: {},
        safeAdapters: {},
        configSha256: hash("config"),
        log() {},
      });
    return { output, run };
  };
  for (const [name, prepared, evidence] of [
    ["missing", { ...manifest, atomic: undefined }, { ...proof, atomic: undefined }],
    ["unmatched", manifest, { ...proof, atomic: { ...atomic, workloadSha256: hash("wrong") } }],
    ["budget", manifest, { ...proof, acceptedAtomicEdits: 70 }],
    ["reference-source", manifest, { ...proof, referenceSourceSha256: hash("obsolete source") }],
    [
      "protected-reference",
      manifest,
      {
        ...proof,
        referenceExecution: { ...REFERENCE_EXECUTION_POLICY, publication: "locked-CAS" },
      },
    ],
    ["agents", manifest, { ...proof, agents: 14 }],
    ["delivery-size", manifest, { ...proof, batchSize: 75 }],
    ["missing-delivery-size", manifest, { ...proof, batchSize: undefined }],
    [
      "dispatch",
      { ...manifest, atomic: { ...atomic, dispatchPolicySha256: hash("wrong") } },
      proof,
    ],
  ]) {
    const { run, output } = await attempt(name, prepared, evidence);
    await assert.rejects(run);
    await assert.rejects(access(path.join(output, "manifest.json")), { code: "ENOENT" });
  }
  for (const file of ["tasks.json", "batches.json"]) {
    const target = path.join(preparation, "atomic", file);
    const original = await readFile(target);
    await writeFile(target, Buffer.concat([original, Buffer.from(" ")]));
    const { run, output } = await attempt(`changed-${file}`, manifest, proof);
    await assert.rejects(run, /Atomic.*changed|atomic.*hash/i);
    await assert.rejects(access(path.join(output, "manifest.json")), { code: "ENOENT" });
    await writeFile(target, original);
  }
  const { run, output } = await attempt("matched", manifest, proof);
  await run();
  const exported = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  assert.deepEqual(exported.suite.atomic, atomic);
});
