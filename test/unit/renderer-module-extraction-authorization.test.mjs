import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/prepare.mjs";
import {
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  validateExtractionProof,
  runModelExtraction,
} from "../../src/suites/explicit-edit-multi-agent/extraction/case.mjs";
import {
  EXTRACTION_RECOVERY_POLICY,
  extractionScore,
} from "../../src/suites/explicit-edit-multi-agent/extraction/score.mjs";

const source = {
  sourceCommit: "a".repeat(40),
  sourceClean: true,
  verifierSha256: "b".repeat(64),
  runnerSha256: "c".repeat(64),
};
const manifest = {
  initial: "d".repeat(64),
  planSha256: "e".repeat(64),
  modules: ["bad.h"],
  pixels: ["0".repeat(64), "1".repeat(64)],
};
const report = {
  status: "complete",
  initial: manifest.initial,
  participants: [{ closed: true }],
  deliveries: [{}],
  extraction: { status: "pass" },
  integration: { buildPassed: true, resultMatched: true, pixels: manifest.pixels },
};
const proof = {
  version: "renderer-module-extraction-proof-v1",
  kind: "scripted-reference",
  status: "pass",
  planSha256: manifest.planSha256,
  sourceIdentity: source,
};

test("a saved closed run is refused before reading prepared source or authorizing native drivers", async () => {
  await assert.rejects(
    runModelExtraction(
      "missing-case",
      "unused-output",
      {},
      {
        fromRun: "closed-original-run",
        sourceReceipt: "closed-original-receipt",
        proofPath: "unread-proof",
      },
    ),
    { code: "EXTRACTION_LIVE_CONTEXT_REQUIRED" },
  );
});
test("only a passed reference with the same clean source and exact plan authorizes model execution", () => {
  assert.doesNotThrow(() => validateExtractionProof(manifest, proof, report, source));
  for (const mutation of [
    { ...proof, status: "fail" },
    { ...proof, kind: "diagnostic" },
    { ...proof, planSha256: "f".repeat(64) },
    { ...proof, sourceIdentity: { ...source, sourceCommit: "0".repeat(40) } },
  ])
    assert.throws(() => validateExtractionProof(manifest, mutation, report, source));
  assert.throws(() =>
    validateExtractionProof(manifest, proof, report, { ...source, sourceClean: false }),
  );
  assert.throws(() =>
    validateExtractionProof(
      manifest,
      proof,
      { ...report, participants: [{ closed: false }] },
      source,
    ),
  );
  assert.throws(() =>
    validateExtractionProof(
      manifest,
      proof,
      { ...report, integration: { buildPassed: false, resultMatched: false } },
      source,
    ),
  );
});

test("paired proofs bind file receipts and participant count separately", () => {
  const files = [
    { id: "extract-001", file: "pair.h" },
    { id: "extract-002", file: "dependency.h" },
    { id: "extract-003", file: "pair.cpp" },
  ];
  const pairedManifest = {
    ...manifest,
    version: "renderer-module-extraction-v2",
    scope: "experimental-module-pairs",
    modules: ["pair"],
    agents: 1,
    files,
  };
  const pairedProof = {
    ...proof,
    version: "renderer-module-extraction-proof-v4",
    scope: pairedManifest.scope,
    policy: EXTRACTION_RECOVERY_POLICY,
    agents: 1,
    files,
  };
  const structure = {
    version: "renderer-module-extraction-structure-v1",
    status: "pass",
    differenceIds: [],
    files: files.map((file) => ({ ...file, targetMatched: true, sourceMatched: true })),
    mainMatched: true,
    inventoryMatched: true,
    unrelatedMatched: true,
    diagnostics: [],
  };
  const stages = [
    { stage: "original", differenceIds: [], integration: report.integration, structure },
  ];
  const score = extractionScore({ totalFiles: files.length, stages });
  const pairedReport = {
    ...report,
    version: "renderer-module-extraction-run-v4",
    scope: pairedManifest.scope,
    policy: EXTRACTION_RECOVERY_POLICY,
    agents: 1,
    files,
    structure,
    stages,
    score,
    first: { ...stages[0], score },
    passed: true,
    waves: [{ stage: "original", agents: 1, ids: files.map(({ id }) => id), status: "complete" }],
    barriers: [
      {
        stage: "original",
        participants: [
          {
            agent: 0,
            session: 0,
            participant: { sessionId: "reference-session", messageCount: files.length },
          },
        ],
      },
    ],
    repairs: [],
    recoveryChecks: [],
    participants: [
      {
        agent: 0,
        session: 0,
        closed: true,
        stage: "original",
        participant: { sessionId: "reference-session", messageCount: 0 },
      },
    ],
    deliveries: files.map((file) => ({
      ids: [file.id],
      agent: 0,
      session: 0,
      status: "settled",
      stage: "original",
    })),
  };
  assert.doesNotThrow(() =>
    validateExtractionProof(pairedManifest, pairedProof, pairedReport, source),
  );
  for (const version of [
    "renderer-module-extraction-proof-v1",
    "renderer-module-extraction-proof-v2",
    "renderer-module-extraction-proof-v3",
  ])
    assert.throws(() =>
      validateExtractionProof(pairedManifest, { ...pairedProof, version }, pairedReport, source),
    );
  assert.throws(() =>
    validateExtractionProof(
      pairedManifest,
      { ...pairedProof, policy: { ...EXTRACTION_RECOVERY_POLICY, buildAgents: 2 } },
      pairedReport,
      source,
    ),
  );
  for (const mutate of [
    (value) => {
      value.barriers = [];
    },
    (value) => {
      value.barriers[0].participants[0].session = 1;
    },
    (value) => {
      value.barriers[0].participants[0].participant.sessionId = "replacement-session";
    },
    (value) => {
      value.repairs = [{ id: files[0].id, owner: 0, status: "settled" }];
    },
    (value) => {
      value.recoveryChecks = [{ ready: [files[0].id] }];
    },
    (value) => {
      value.agents = 2;
    },
    (value) => {
      value.deliveries[1].ids = value.deliveries[0].ids;
    },
    (value) => {
      value.deliveries[1].session = 2;
    },
    (value) => {
      value.deliveries[1].status = "error";
    },
    (value) => {
      value.files = value.files.slice(0, -1);
    },
    (value) => {
      value.score.score = 99;
    },
    (value) => {
      value.policy = { ...EXTRACTION_RECOVERY_POLICY, imageAttempts: 2 };
    },
    (value) => {
      value.waves.push({
        stage: "build-correction",
        agents: 1,
        ids: ["build-correction"],
        status: "complete",
      });
    },
    (value) => {
      value.stages[0].differenceIds = [files[0].id];
    },
  ]) {
    const changed = structuredClone(pairedReport);
    mutate(changed);
    assert.throws(() => validateExtractionProof(pairedManifest, pairedProof, changed, source));
  }
});

test(
  "the model entry refuses a legacy header-only case before reading its proof",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "extraction-scope-"));
    try {
      const input = path.join(root, "input"),
        prepared = path.join(root, "case"),
        output = path.join(root, "run");
      await mkdir(input);
      const initial = {
        "main.cpp": "#ifndef A_H\n#define A_H\nint current;\n#endif\nint main() { return 0; }\n",
      };
      const tasks = JSON.stringify([
        { operations: [{ action: "header", file: "a.h", guard: "A_H", includes: [] }] },
      ]);
      await writeTree(path.join(input, "initial"), initial);
      await writeFile(path.join(input, "tasks.json"), tasks);
      await writeFile(
        path.join(input, "manifest.json"),
        JSON.stringify({
          version: "renderer-concurrent-v2",
          initial: treeIdentity(initial),
          workloadSha256: createHash("sha256").update(tasks).digest("hex"),
          pixels: manifest.pixels,
        }),
      );
      await prepareExtraction(input, prepared, { modules: ["a.h"] });
      const fifo = path.join(root, "unopened-proof");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      const module = new URL(
        "../../src/suites/explicit-edit-multi-agent/extraction/case.mjs",
        import.meta.url,
      ).href;
      const script = `import {runModelExtraction} from ${JSON.stringify(module)}; await runModelExtraction(${JSON.stringify(prepared)},${JSON.stringify(output)},{},{proofPath:${JSON.stringify(fifo)}});`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 2000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(output), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
