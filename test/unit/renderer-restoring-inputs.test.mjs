import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { dependencyGraph } from "../../src/suites/explicit-edit-multi-agent/tasks/concurrent-schedule.mjs";
import { MULTI_AGENT_POLICY } from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { ATOMIC_DISPATCH_POLICY } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import { loadRestoringInputs } from "../../src/suites/explicit-edit-multi-agent/execution/restoring-preparation.mjs";
import {
  prepareCanonical,
  loadCanonicalPreparation,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-preparation.mjs";
import {
  RESTORING_RUN_VERSION,
  restoringRunIdentity,
  createRestoringProof,
} from "../../src/suites/explicit-edit-multi-agent/execution/restoring-proof.mjs";
import { RESTORING_MULTI_AGENT_POLICY } from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(JSON.stringify(value) + "\n");
const execute = promisify(execFile);

async function preparation(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "restoring-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tasks = [{ id: "tiny", phase: "names", subsystem: "main.cpp", operations: [] }];
  const transitions = [
    {
      id: "tiny",
      filesBefore: ["main.cpp"],
      filesAfter: ["main.cpp"],
      remove: [{ id: "old-owner", count: 1 }],
      add: [{ id: "new-owner", count: 1 }],
    },
  ];
  const initial = { "main.cpp": "int first() { return 0; }\n" };
  const files = {
    "tasks.json": tasks,
    "atomic/tasks.json": {
      version: "renderer-atomic-workload-v1",
      nodes: [{ id: "atom-1", taskId: "tiny", dependencies: [], operations: [] }],
    },
    "atomic/batches.json": [],
    "graph.json": dependencyGraph(tasks, transitions),
    "transitions/tiny.json": transitions[0],
    "contracts/initial.json": { version: "input-contract", files: ["main.cpp"] },
  };
  for (const [name, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes(value));
  }
  await writeTree(path.join(root, "initial"), initial);
  const manifest = {
    version: "renderer-concurrent-v2",
    policy: MULTI_AGENT_POLICY,
    tasks: 1,
    atomic: {
      version: ATOMIC_DISPATCH_POLICY.version,
      dispatchPolicySha256: hash(JSON.stringify(ATOMIC_DISPATCH_POLICY)),
      workloadSha256: hash(bytes(files["atomic/tasks.json"])),
      batchesSha256: hash(bytes(files["atomic/batches.json"])),
      edits: 1,
    },
    workloadSha256: hash(bytes(tasks)),
    graphSha256: hash(bytes(files["graph.json"])),
    transitionHashes: { tiny: hash(bytes(transitions[0])) },
    initialContractSha256: hash(bytes(files["contracts/initial.json"])),
    initial: treeIdentity(initial),
    final: treeIdentity({ "main.cpp": "int first() { return 1; }\n" }),
  };
  await writeFile(path.join(root, "manifest.json"), bytes(manifest));
  return { root, manifest };
}

async function retainedPreparation(t) {
  const fixture = await preparation(t);
  const inputs = await loadRestoringInputs(fixture.root, { agents: 1 });
  const round = inputs.schedule[0].id;
  const expectedTree = { "main.cpp": "int first() { return 1; }\n" };
  const loaded = {
    ...inputs,
    contractHashes: { initial: hash(JSON.stringify(inputs.initialContract)) },
    plannedAtoms: [{ round, totalAtoms: 1 }],
    atomicIntervals: {
      rounds: new Map([[round, { nodes: inputs.atomicWorkload.nodes, expectedTree }]]),
    },
  };
  const identity = restoringRunIdentity(
    loaded,
    {
      sourceCommit: "a".repeat(40),
      sourceClean: true,
      verifierSha256: hash("fixture reference verifier"),
      runnerSha256: hash("fixture reference runner"),
    },
    { protocol: "fixture-reference", policy: RESTORING_MULTI_AGENT_POLICY, batchSize: 1 },
  );
  const report = {
    ...identity,
    version: RESTORING_RUN_VERSION,
    mode: "reference",
    status: "complete",
    initialCheck: {
      identity: identity.initial,
      buildPassed: true,
      resultMatched: true,
      integrityPassed: true,
    },
    final: identity.expectedFinal,
    repairs: 0,
    deliveries: 1,
    agentsClosed: [true],
    executions: [
      {
        round,
        attempt: 1,
        agent: 0,
        atomicIds: ["atom-1"],
        status: "settled",
        receipts: [
          {
            lifetime: "fixture-0",
            events: [
              { phase: "execute-start", at: 0 },
              { phase: "plan-start", at: 1 },
              { phase: "plan-end", at: 3 },
              { phase: "publish-start", at: 4, file: "main.cpp" },
              { phase: "publish-end", at: 5, file: "main.cpp" },
              { phase: "execute-end", at: 6 },
            ],
          },
        ],
      },
    ],
    rounds: [
      {
        round,
        firstAttempt: 1,
        finalAttempt: 1,
        attempts: [
          {
            attempt: 1,
            passedAtoms: 1,
            totalAtoms: 1,
            buildPassed: true,
            resultMatched: true,
            integrityPassed: true,
          },
        ],
        restoration: { status: "pass", identity: treeIdentity(expectedTree) },
      },
    ],
  };
  const proof = createRestoringProof(report, identity);
  const proofBytes = bytes(proof);
  const proofPath = path.join(fixture.root, "reference.json");
  await writeFile(proofPath, proofBytes);
  const trustedEndpoints = {
    version: "renderer-retained-source-endpoints-v2",
    inputFingerprint: inputs.inputFingerprint,
    proofSha256: hash(proofBytes),
    initial: inputs.initial,
    rounds: [{ round, identity: treeIdentity(expectedTree), tree: expectedTree }],
  };
  return {
    ...fixture,
    inputs,
    round,
    expectedTree,
    proof,
    proofBytes,
    proofPath,
    trustedEndpoints,
  };
}

// This child uses real modules and filesystem APIs. Only replay entry points are
// guarded, so a regression cannot pass by returning cached substitute data.
const guardedPublicApi = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const input = JSON.parse(process.argv[1]);
const targets = new Map(input.targets);
const installed = new Set();
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const name = targets.get(url);
    if (!name) return loaded;
    assert.equal(loaded.format, "module");
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    installed.add(name);
    return { ...loaded, source: source + "\\n" + name + " = () => { const error = new Error(); error.code = \\"TRUSTED_WORKLOAD_REPLAY\\"; throw error; };\\n" };
  },
});
try {
  await Promise.all([...targets.keys()].map((url) => import(url)));
  const { prepareCanonical, loadCanonicalPreparation } = await import(input.module);
  const manifest = await prepareCanonical(input.preparation, input.cache, {
    agents: 1, proofPath: input.proofPath, trustedEndpoints: input.trustedEndpoints,
  });
  const loaded = await loadCanonicalPreparation(input.preparation, input.cache, { agents: 1 });
  assert.deepEqual([...installed].sort(), ["atomicCheckpoints", "checkpointContracts"]);
  const interval = loaded.atomicIntervals.rounds.get(input.round);
  console.log(JSON.stringify({ status: "passed", version: manifest.version, initial: loaded.initial,
    expectedTree: interval.expectedTree, nodes: interval.nodes, totalHunks: loaded.canonical.rounds.get(input.round).preparedDiff.totalHunks }));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", code: error?.code ?? null }));
  process.exitCode = 1;
}
`;

test("input fingerprints include exact manifest bytes even when parsed data stays unchanged", async (t) => {
  const { root, manifest } = await preparation(t);
  const before = await loadRestoringInputs(root, { agents: 1 });
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const after = await loadRestoringInputs(root, { agents: 1 });
  assert.deepEqual(after.manifest, before.manifest);
  assert.deepEqual(after.schedule, before.schedule);
  assert.notEqual(after.inputFingerprint, before.inputFingerprint);
  assert.equal(Object.hasOwn(after, "atomicIntervals"), false);
});

test("resealed transition bytes change the input fingerprint without replaying their edits", async (t) => {
  const { root, manifest } = await preparation(t);
  const before = await loadRestoringInputs(root, { agents: 1 });
  const file = path.join(root, "transitions/tiny.json");
  const original = JSON.parse(await readFile(file, "utf8"));
  const changed = Buffer.from(JSON.stringify(original, null, 2) + "\n");
  await writeFile(file, changed);
  manifest.transitionHashes.tiny = hash(changed);
  await writeFile(path.join(root, "manifest.json"), bytes(manifest));
  const after = await loadRestoringInputs(root, { agents: 1 });
  assert.deepEqual(after.graph, before.graph);
  assert.deepEqual(after.schedule, before.schedule);
  assert.notEqual(after.inputFingerprint, before.inputFingerprint);
  assert.equal(Object.hasOwn(after, "contracts"), false);
});

test("public canonical preparation and loading reuse retained sources without either replay entry point", async (t) => {
  const fixture = await retainedPreparation(t);
  const module = new URL(
    "../../src/suites/explicit-edit-multi-agent/execution/canonical-preparation.mjs",
    import.meta.url,
  ).href;
  const targets = [
    [
      new URL(
        "../../src/suites/explicit-edit-multi-agent/grading/concurrent-contracts.mjs",
        import.meta.url,
      ).href,
      "checkpointContracts",
    ],
    [
      new URL("../../src/suites/explicit-edit-multi-agent/tasks/atomic-bundle.mjs", import.meta.url)
        .href,
      "atomicCheckpoints",
    ],
  ];
  const input = {
    module,
    targets,
    preparation: fixture.root,
    cache: path.join(fixture.root, "cache"),
    proofPath: fixture.proofPath,
    trustedEndpoints: fixture.trustedEndpoints,
    round: fixture.round,
  };
  const { stdout } = await execute(process.execPath, [
    "--input-type=module",
    "-e",
    guardedPublicApi,
    JSON.stringify(input),
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.version, "renderer-canonical-preparation-v2");
  assert.deepEqual(result.initial, fixture.inputs.initial);
  assert.deepEqual(result.expectedTree, fixture.expectedTree);
  assert.deepEqual(result.nodes, fixture.inputs.atomicWorkload.nodes);
  assert.equal(result.totalHunks, 1);
});

test("retained source edits cannot be authorized by updating their declared endpoint identity", async (t) => {
  const fixture = await retainedPreparation(t);
  const retained = structuredClone(fixture.trustedEndpoints);
  retained.rounds[0].tree["main.cpp"] = "int first() { return 9; }\n";
  retained.rounds[0].identity = treeIdentity(retained.rounds[0].tree);
  await assert.rejects(
    prepareCanonical(fixture.root, path.join(fixture.root, "cache"), {
      agents: 1,
      proofPath: fixture.proofPath,
      trustedEndpoints: retained,
    }),
    { code: "ERR_ASSERTION" },
  );
});

test("manifest byte changes invalidate both retained preparation and an existing canonical cache", async (t) => {
  const fixture = await retainedPreparation(t);
  const cache = path.join(fixture.root, "cache");
  await prepareCanonical(fixture.root, cache, {
    agents: 1,
    proofPath: fixture.proofPath,
    trustedEndpoints: fixture.trustedEndpoints,
  });
  await writeFile(
    path.join(fixture.root, "manifest.json"),
    JSON.stringify(fixture.manifest, null, 2) + "\n",
  );
  assert.deepEqual(
    (await loadRestoringInputs(fixture.root, { agents: 1 })).manifest,
    fixture.manifest,
  );
  await assert.rejects(
    prepareCanonical(fixture.root, path.join(fixture.root, "changed-cache"), {
      agents: 1,
      proofPath: fixture.proofPath,
      trustedEndpoints: fixture.trustedEndpoints,
    }),
    { code: "ERR_ASSERTION" },
  );
  await assert.rejects(loadCanonicalPreparation(fixture.root, cache, { agents: 1 }), {
    code: "ERR_ASSERTION",
  });
});

test("retained preparation rejects different proof bytes, resealed proof scope and participant count", async (t) => {
  const fixture = await retainedPreparation(t);
  const reformattedProof = path.join(fixture.root, "reformatted-reference.json");
  await writeFile(reformattedProof, JSON.stringify(fixture.proof, null, 2) + "\n");
  await assert.rejects(
    prepareCanonical(fixture.root, path.join(fixture.root, "different-proof-cache"), {
      agents: 1,
      proofPath: reformattedProof,
      trustedEndpoints: fixture.trustedEndpoints,
    }),
    { code: "ERR_ASSERTION" },
  );
  const alteredProof = structuredClone(fixture.proof);
  alteredProof.identity.workloadSha256 = hash("different workload");
  const alteredBytes = bytes(alteredProof);
  const alteredProofPath = path.join(fixture.root, "different-scope-reference.json");
  await writeFile(alteredProofPath, alteredBytes);
  const retained = structuredClone(fixture.trustedEndpoints);
  retained.proofSha256 = hash(alteredBytes);
  await assert.rejects(
    prepareCanonical(fixture.root, path.join(fixture.root, "different-scope-cache"), {
      agents: 1,
      proofPath: alteredProofPath,
      trustedEndpoints: retained,
    }),
    { code: "ERR_ASSERTION" },
  );
  await assert.rejects(
    prepareCanonical(fixture.root, path.join(fixture.root, "different-agents-cache"), {
      agents: 2,
      proofPath: fixture.proofPath,
      trustedEndpoints: fixture.trustedEndpoints,
    }),
    { name: "Error" },
  );
});

test("unsealed immutable input changes are rejected by the cheap reader", async (t) => {
  const { root } = await preparation(t);
  await writeFile(path.join(root, "atomic/batches.json"), "[{}]\n");
  await assert.rejects(loadRestoringInputs(root, { agents: 1 }), { code: "ERR_ASSERTION" });
});
