import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { RESTORING_MULTI_AGENT_POLICY } from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";
import {
  RESTORING_RUN_VERSION,
  restoringRunIdentity,
  createRestoringProof,
} from "../../src/suites/explicit-edit-multi-agent/execution/restoring-proof.mjs";
import {
  buildCanonicalCache,
  readCanonicalCache,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-preparation.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const source = (first, second) => ({
  "main.cpp": `int first() { return ${first}; }\nint second() { return ${second}; }\n`,
  "support/data.txt": "unchanged payload\n",
});

function fixture() {
  const initial = source(0, 0),
    middle = source(1, 0),
    final = source(1, 2);
  const initialContract = { version: "fixture-contract", files: Object.keys(initial).sort() };
  const nodes = [
    { id: "a", taskId: "first-task", dependencies: [] },
    { id: "b", taskId: "first-task", dependencies: [] },
    { id: "c", taskId: "second-task", dependencies: ["b"] },
  ];
  const loaded = {
    manifest: {
      initial: treeIdentity(initial),
      final: treeIdentity(final),
      tasks: 2,
      workloadSha256: hash("workload"),
      graphSha256: hash("graph"),
      atomic: { version: "fixture-atomic-v1" },
    },
    graph: { width: 2 },
    agents: 2,
    schedule: [
      { id: "round-001", assignments: [{ task: "first-task" }] },
      { id: "round-002", assignments: [{ task: "second-task" }] },
    ],
    scheduleSha256: hash("schedule"),
    contractHashes: { initial: hash(JSON.stringify(initialContract)) },
    initialContract,
    inputFingerprint: hash("immutable input files"),
    initial,
    atomicWorkload: { nodes },
    atomicIntervals: {
      rounds: new Map([
        ["round-001", { nodes: nodes.slice(0, 2), expectedTree: middle }],
        ["round-002", { nodes: [{ ...nodes[2], dependencies: [] }], expectedTree: final }],
      ]),
    },
    plannedAtoms: [
      { round: "round-001", totalAtoms: 2 },
      { round: "round-002", totalAtoms: 1 },
    ],
  };
  const identity = restoringRunIdentity(
    loaded,
    {
      sourceCommit: "a".repeat(40),
      sourceClean: true,
      verifierSha256: hash("reference verifier"),
      runnerSha256: hash("reference runner"),
    },
    { protocol: "fixture-reference", policy: RESTORING_MULTI_AGENT_POLICY, batchSize: 1 },
  );
  const execution = (id, agent, start) => ({
    round: id === "c" ? "round-002" : "round-001",
    attempt: 1,
    agent,
    atomicIds: [id],
    status: "settled",
    receipts: [
      {
        lifetime: `fixture-${agent}`,
        events: [
          { phase: "execute-start", at: start },
          { phase: "plan-start", at: start + 1 },
          { phase: "plan-end", at: start + 3 },
          { phase: "publish-start", at: start + 4, file: "main.cpp" },
          { phase: "publish-end", at: start + 5, file: "main.cpp" },
          { phase: "execute-end", at: start + 6 },
        ],
      },
    ],
  });
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
    deliveries: 3,
    agentsClosed: [true, true],
    executions: [execution("a", 0, 0), execution("b", 1, 1), execution("c", 0, 20)],
    rounds: identity.plannedAtoms.map(({ round, totalAtoms }, index) => ({
      round,
      firstAttempt: 1,
      finalAttempt: 1,
      attempts: [
        {
          attempt: 1,
          passedAtoms: totalAtoms,
          totalAtoms,
          buildPassed: true,
          resultMatched: true,
          integrityPassed: true,
        },
      ],
      restoration: { status: "pass", identity: identity.roundEndpoints[index].identity },
    })),
  };
  const proof = createRestoringProof(report, identity);
  return { loaded, proofBytes: Buffer.from(JSON.stringify(proof) + "\n"), proof };
}

async function setup(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "canonical-cache-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return { temporary, output: path.join(temporary, "cache"), ...fixture() };
}

async function changeManifest(output, change) {
  const file = path.join(output, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  change(manifest);
  await writeFile(file, JSON.stringify(manifest) + "\n");
}

test("a trusted cache retains complete canonical endpoints and common-baseline hunks", async (t) => {
  const f = await setup(t);
  const before = structuredClone(f.loaded.initial);
  const manifest = await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
  const result = await readCanonicalCache(f.loaded, f.output);
  assert.equal(manifest.version, "renderer-canonical-preparation-v2");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(f.output, manifest.initial.source.file), "utf8")),
    f.loaded.initial,
  );
  for (const [index, { id }] of f.loaded.schedule.entries()) {
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.output, manifest.rounds[index].source.file), "utf8")),
      f.loaded.atomicIntervals.rounds.get(id).expectedTree,
    );
    assert.equal(
      (await stat(path.join(f.output, manifest.rounds[index].source.file))).mode & 0o777,
      0o600,
    );
  }
  assert.deepEqual(result.atomicIntervals.rounds.get("round-002").nodes, [
    { ...f.loaded.atomicWorkload.nodes[2], dependencies: [] },
  ]);
  assert.deepEqual(
    result.atomicIntervals.rounds.get("round-002").expectedTree,
    f.loaded.atomicIntervals.rounds.get("round-002").expectedTree,
  );
  assert.equal(manifest.protocol, "shared-project-canonical-diff-v1");
  assert.equal(result.canonical.rounds.size, 2);
  assert.equal(result.canonical.rounds.get("round-001").preparedDiff.totalHunks, 1);
  assert.equal(result.canonical.rounds.get("round-002").preparedDiff.totalHunks, 1);
  assert.deepEqual(
    result.canonical.rounds.get("round-002").preparedDiff.start.files,
    result.canonical.rounds.get("round-001").expectedSnapshot.files,
  );
  assert.deepEqual(f.loaded.initial, before);
  assert.equal(result.authorization.kind, "retained-task-feasibility");
  assert.equal(result.authorization.proofSha256, hash(f.proofBytes));
  assert.equal(result.authorization.sourceCommit, f.proof.identity.sourceCommit);
  assert.deepEqual(await readFile(path.join(f.output, "feasibility.json")), f.proofBytes);
  assert.equal((await stat(f.output)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.output, "manifest.json"))).mode & 0o777, 0o600);
});

test("input-only loading restores exact endpoints and removes only completed dependencies", async (t) => {
  const f = await setup(t);
  await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
  const atomicIntervals = f.loaded.atomicIntervals;
  const inputs = {
    ...f.loaded,
    atomicIntervals: undefined,
    contractHashes: undefined,
    plannedAtoms: undefined,
  };
  const result = await readCanonicalCache(inputs, f.output);
  assert.deepEqual(result.plannedAtoms, f.loaded.plannedAtoms);
  assert.deepEqual(result.contractHashes, f.loaded.contractHashes);
  for (const { id } of f.loaded.schedule) {
    assert.deepEqual(
      result.atomicIntervals.rounds.get(id).nodes,
      atomicIntervals.rounds.get(id).nodes,
    );
    assert.deepEqual(
      result.atomicIntervals.rounds.get(id).expectedTree,
      atomicIntervals.rounds.get(id).expectedTree,
    );
  }
});

test("cached function bodies retain meaningful runtime changes", async (t) => {
  const f = await setup(t);
  await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
  const { canonical } = await readCanonicalCache(f.loaded, f.output);
  const first = canonical.rounds.get("round-001");
  assert.notEqual(
    first.expectedSnapshot.files["source/main.cpp"],
    canonical.initial.files["source/main.cpp"],
  );
  assert.ok(first.preparedDiff.expectedHunks[0].lines.some((line) => line.startsWith("+")));
  assert.ok(first.preparedDiff.expectedHunks[0].lines.some((line) => line.startsWith("-")));
});

test("an existing cache is never overwritten", async (t) => {
  const f = await setup(t);
  await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
  const original = await readFile(path.join(f.output, "manifest.json"));
  await assert.rejects(buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes }), {
    code: "EEXIST",
  });
  assert.deepEqual(await readFile(path.join(f.output, "manifest.json")), original);
});

test("a reference with a changed task scope is rejected before cache creation", async (t) => {
  const f = await setup(t);
  f.loaded.manifest.workloadSha256 = hash("different workload");
  await assert.rejects(buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes }), {
    code: "ERR_ASSERTION",
  });
  await assert.rejects(stat(f.output), { code: "ENOENT" });
});

test("invalid retained reference evidence cannot authorize a cache", async (t) => {
  const f = await setup(t);
  f.proof.rounds[0].attempts[0].buildPassed = false;
  await assert.rejects(
    buildCanonicalCache(f.loaded, f.output, { proofBytes: Buffer.from(JSON.stringify(f.proof)) }),
  );
  await assert.rejects(stat(f.output), { code: "ENOENT" });
});

test("a round without observable canonical changes reports its identity and leaves no complete manifest", async (t) => {
  const f = await setup(t);
  const first = f.loaded.atomicIntervals.rounds.get("round-001");
  // Placement and comments normalize while the trusted byte identity changes.
  first.expectedTree["main.cpp"] =
    "// comment\nint second() { return 0; }\nint first() { return 0; }\n";
  const scopeProof = structuredClone(f.proof);
  scopeProof.identity.roundEndpoints[0].identity = treeIdentity(first.expectedTree);
  scopeProof.rounds[0].restoration.identity = scopeProof.identity.roundEndpoints[0].identity;
  await assert.rejects(
    buildCanonicalCache(f.loaded, f.output, {
      proofBytes: Buffer.from(JSON.stringify(scopeProof)),
    }),
    (error) => error.code === "CANONICAL_DIFF_EMPTY_REFERENCE" && error.round === "round-001",
  );
  await assert.rejects(stat(path.join(f.output, "manifest.json")), { code: "ENOENT" });
});

test("changed snapshot or diff bytes are rejected before use", async (t) => {
  for (const artifact of ["snapshot", "diff"]) {
    const f = await setup(t);
    const output = path.join(f.temporary, artifact);
    const manifest = await buildCanonicalCache(f.loaded, output, { proofBytes: f.proofBytes });
    await writeFile(path.join(output, manifest.rounds[0][artifact].file), "{}\n");
    await assert.rejects(readCanonicalCache(f.loaded, output), { code: "ERR_ASSERTION" });
  }
});

test("diff, inventory, parser and verifier identity changes invalidate preparation", async (t) => {
  for (const mutate of [
    (manifest) => {
      manifest.diffPolicy.context++;
    },
    (manifest) => {
      manifest.inventory.version = "different-inventory";
    },
    (manifest) => {
      manifest.canonicalizer.parser.version = "different-parser";
    },
    (manifest) => {
      manifest.verifierSha256 = hash("different verifier");
    },
  ]) {
    const f = await setup(t);
    await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
    await changeManifest(f.output, mutate);
    await assert.rejects(readCanonicalCache(f.loaded, f.output));
  }
});

test("manifest artifact paths cannot escape the cache", async (t) => {
  const f = await setup(t);
  await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
  await changeManifest(f.output, (manifest) => {
    manifest.rounds[0].snapshot.file = "../outside.json";
  });
  await assert.rejects(readCanonicalCache(f.loaded, f.output), { code: "ERR_ASSERTION" });
});

test("canonical baselines form the complete original round chain", async (t) => {
  const f = await setup(t);
  await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
  await changeManifest(f.output, (manifest) => {
    manifest.rounds[1].startCanonicalIdentity = manifest.rounds[1].endCanonicalIdentity;
  });
  await assert.rejects(readCanonicalCache(f.loaded, f.output), { code: "ERR_ASSERTION" });
});

test("raw endpoint tampering is rejected even after resealing its artifact digest", async (t) => {
  for (const endpoint of ["initial", "round"]) {
    const f = await setup(t);
    const manifest = await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
    const artifact = endpoint === "initial" ? manifest.initial.source : manifest.rounds[0].source;
    const file = path.join(f.output, artifact.file);
    const tree = JSON.parse(await readFile(file, "utf8"));
    tree["main.cpp"] += "\nint unrelated() { return 987; }\n";
    const bytes = Buffer.from(JSON.stringify(tree) + "\n");
    await writeFile(file, bytes);
    await changeManifest(f.output, (value) => {
      (endpoint === "initial" ? value.initial.source : value.rounds[0].source).sha256 = hash(bytes);
    });
    await assert.rejects(readCanonicalCache(f.loaded, f.output), { code: "ERR_ASSERTION" });
  }
});

test("missing raw source artifacts require explicit repreparation without replay fallback", async (t) => {
  for (const endpoint of ["initial", "round"]) {
    const f = await setup(t);
    const manifest = await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
    const artifact = endpoint === "initial" ? manifest.initial.source : manifest.rounds[0].source;
    await rm(path.join(f.output, artifact.file));
    await assert.rejects(readCanonicalCache(f.loaded, f.output), {
      code: "CANONICAL_CACHE_REPREPARE",
    });
  }
});

test("a cache without the raw-source format requires explicit repreparation", async (t) => {
  for (const mutate of [
    (value) => {
      value.version = "renderer-canonical-preparation-v1";
    },
    (value) => {
      delete value.rounds[0].source;
    },
  ]) {
    const f = await setup(t);
    await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
    await changeManifest(f.output, mutate);
    await assert.rejects(readCanonicalCache(f.loaded, f.output), {
      code: "CANONICAL_CACHE_REPREPARE",
    });
  }
});

test("a changed exact input fingerprint invalidates a cache with unchanged workload scope", async (t) => {
  const f = await setup(t);
  await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
  const changed = { ...f.loaded, inputFingerprint: hash("changed manifest bytes") };
  await assert.rejects(readCanonicalCache(changed, f.output), { code: "ERR_ASSERTION" });
});

test("cached raw source paths cannot escape or use invalid UTF-8 names", async (t) => {
  for (const name of ["../outside.cpp", "/absolute.cpp", "a/../outside.cpp", "bad\uD800.cpp"]) {
    const f = await setup(t);
    const manifest = await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
    const tree = { [name]: "int value() { return 1; }" };
    const bytes = Buffer.from(JSON.stringify(tree) + "\n");
    await writeFile(path.join(f.output, manifest.rounds[0].source.file), bytes);
    await changeManifest(f.output, (value) => {
      value.rounds[0].source.sha256 = hash(bytes);
    });
    await assert.rejects(readCanonicalCache(f.loaded, f.output), { code: "ERR_ASSERTION" });
  }
});

test("changing retained proof bytes invalidates authorization", async (t) => {
  const f = await setup(t);
  await buildCanonicalCache(f.loaded, f.output, { proofBytes: f.proofBytes });
  await writeFile(path.join(f.output, "feasibility.json"), "{}\n");
  await assert.rejects(readCanonicalCache(f.loaded, f.output), { code: "ERR_ASSERTION" });
});
