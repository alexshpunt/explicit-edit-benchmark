import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeTree } from "../generation/generator.mjs";
import { measureExtractionCandidate } from "../grading/coherent-build.mjs";
import { compilerDiagnostics } from "../grading/repair-diagnostics.mjs";
import {
  STRUCTURAL_UNIT_POLICY,
  compareStructuralUnits,
  prepareStructuralUnits,
} from "../grading/structural-units.mjs";
import {
  STRUCTURAL_UNIT_SCORE_POLICY,
  structuralUnitScore,
} from "../grading/structural-unit-score.mjs";
import {
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../execution/candidate-evidence.mjs";
import { CHUNK_DELIVERY_DEADLINE_MS } from "../execution/chunk-delivery-deadline.mjs";
import { chunkModelDrivers } from "../execution/chunk-model-drivers.mjs";
import { runCorrectionSchedule } from "../execution/correction-schedule.mjs";
import { FRESH_AGENT_QUEUE_POLICY, runFreshAgentQueue } from "../execution/fresh-agent-queue.mjs";
import { restoringSourceIdentity } from "../execution/restoring-identity.mjs";
import {
  STRUCTURAL_UNIT_CORRECTION_POLICY,
  structuralUnitCorrections,
} from "../execution/structural-unit-corrections.mjs";
import {
  ASSEMBLY_ASSIGNMENT_BYTES,
  ASSEMBLY_ASSIGNMENT_UNITS,
  ASSEMBLY_CASE_VERSION,
  cleanupAssemblyMarkers,
  prepareAssemblyCase,
  scriptedAssemblyWriter,
} from "./assembly-case.mjs";
import { integrationPrompt, loadGeneralPrompt, physicalUnits } from "./chunk-run.mjs";
import { captureExtractionState } from "./run.mjs";

export const ASSEMBLY_RUN_VERSION = "renderer-assembly-run-v1";
export const ASSEMBLY_AGENTS = 20;
export const ASSEMBLY_RUN_POLICY = Object.freeze({
  version: "renderer-assembly-policy-v1",
  case: ASSEMBLY_CASE_VERSION,
  phases: Object.freeze(["assembly", "extraction"]),
  agents: ASSEMBLY_AGENTS,
  queue: FRESH_AGENT_QUEUE_POLICY,
  assemblyOrder: "regions-interleaved-round-robin",
  assignment: Object.freeze({ bytes: ASSEMBLY_ASSIGNMENT_BYTES, units: ASSEMBLY_ASSIGNMENT_UNITS }),
  delivery: Object.freeze({
    deadlineSeconds: CHUNK_DELIVERY_DEADLINE_MS / 1000,
    onTimeout: "close-and-continue",
    generalInstructions: "before-every-assignment",
  }),
  controller: "never-repairs-or-rewrites-assignments",
  schedule: "original-structural-build-result",
  units: STRUCTURAL_UNIT_POLICY,
  corrections: STRUCTURAL_UNIT_CORRECTION_POLICY,
  score: STRUCTURAL_UNIT_SCORE_POLICY,
});

const hash = (data) => createHash("sha256").update(data).digest("hex");

/** Model execution and its reference proof require the same clean committed source. */
export async function assemblyRunIdentity(setup, general, { requireClean = true } = {}) {
  const source = await restoringSourceIdentity();
  if (requireClean)
    assert.equal(source.sourceClean, true, "Assembly runs require clean committed source");
  return {
    source,
    planSha256: setup.manifest.planSha256,
    caseIdentities: setup.identities,
    generalSha256: hash(general),
    policy: ASSEMBLY_RUN_POLICY.version,
  };
}

async function readTextTree(root) {
  const tree = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        const text = bytes.toString("utf8");
        if (Buffer.from(text).equals(bytes)) tree[path.relative(root, full)] = text;
      }
    }
  }
  await walk(root);
  return tree;
}

/** Remove issued marker lines left anywhere in the workspace; the count is evidence. */
async function cleanupWorkspaceMarkers(workspace, markers) {
  const tree = await readTextTree(workspace);
  const { tree: cleaned, remaining } = cleanupAssemblyMarkers(tree, markers);
  for (const [file, content] of Object.entries(cleaned))
    if (content !== tree[file]) await writeFile(path.join(workspace, file), content);
  return remaining;
}

/** Run phases, then optionally the common correction schedule, on one workspace.
 * Pools supply participants: native model sessions or the scripted reference.
 */
async function runAssemblyObservation({
  setup,
  output,
  pools,
  identity,
  general,
  phases,
  start,
  reference,
  corrections,
  signal,
}) {
  const workspace = path.join(output, "workspace");
  await mkdir(output, { mode: 0o700 });
  await writeTree(workspace, start);
  const prepared = await prepareStructuralUnits(
    cleanupAssemblyMarkers(start, setup.markers).tree,
    reference,
  );
  const report = {
    version: ASSEMBLY_RUN_VERSION,
    policy: ASSEMBLY_RUN_POLICY,
    mode: pools.mode,
    kind: corrections ? "observation" : "probe",
    identity,
    status: "running",
    started: new Date().toISOString(),
    totalUnits: prepared.totalUnits,
    startIdentity: prepared.startIdentity,
    referenceIdentity: prepared.referenceIdentity,
    generalSha256: hash(general),
    phases: /** @type {any[]} */ ([]),
    deliveries: /** @type {any[]} */ ([]),
    captures: /** @type {any[]} */ ([]),
    stages: /** @type {any[]} */ ([]),
    attempts: /** @type {any[]} */ ([]),
    remainingMarkers: null,
    score: null,
    passed: false,
  };
  let saving = Promise.resolve();
  const save = () => {
    const bytes = JSON.stringify(report, null, 2) + "\n";
    saving = saving.then(async () => {
      await writeFile(path.join(output, "report.pending.json"), bytes, { mode: 0o600 });
      await rename(path.join(output, "report.pending.json"), path.join(output, "report.json"));
    });
    return saving;
  };
  const event = (type, data) =>
    appendFileSync(
      path.join(output, "events.jsonl"),
      JSON.stringify({ time: new Date().toISOString(), type, ...data }) + "\n",
      { mode: 0o600 },
    );
  await save();

  /** Every entry gets a new agent; the controller issues prompts exactly as prepared. */
  async function runPhase(name, entries, promptOf, abort = signal) {
    const pool = pools.create(name);
    const phase = { name, status: "running", entries: entries.length };
    report.phases.push(phase);
    await save();
    const rows = new Map();
    let failure;
    try {
      const { results, maxLive } = await runFreshAgentQueue(entries, {
        maxAgents: ASSEMBLY_AGENTS,
        signal: abort,
        createDriver: (item, session, context) => pool.createDriver(item, session, context),
        async execute(driver, item, context) {
          const prompt = promptOf(item);
          const row = {
            phase: name,
            id: item.id,
            file: item.file ?? null,
            queueIndex: context.index,
            session: context.session,
            units: item.items?.length ?? null,
            bytes: Buffer.byteLength(prompt),
            status: "running",
            started: new Date().toISOString(),
          };
          rows.set(context.session, row);
          report.deliveries.push(row);
          event("delivery-start", row);
          void save();
          try {
            const outcome = await pool.execute(driver, prompt, { ...context, item });
            row.status = outcome.status;
            if (outcome.receipt !== undefined) row.receipt = outcome.receipt;
            return outcome;
          } catch (error) {
            row.status = "error";
            row.error = { name: error?.name, message: error?.message };
            throw error;
          } finally {
            row.ended = new Date().toISOString();
            event("delivery-end", row);
            void save();
          }
        },
        async onClosed(driver, _item, result) {
          const row = rows.get(result.session);
          if (row && driver) row.usage = pool.usage?.(driver) ?? null;
        },
      });
      phase.status = "complete";
      phase.maxLive = maxLive;
      phase.timedOut = results.filter((result) => result?.status === "timed-out").length;
      return results;
    } catch (error) {
      failure = error;
      phase.status = "interrupted";
      throw error;
    } finally {
      try {
        await pool.cleanup();
      } catch (error) {
        if (!failure) throw error;
        report.cleanupFailure = { name: error.name, message: error.message };
      }
      await save();
    }
  }

  let currentCandidate = null;
  async function releaseChecked(abort) {
    if (!currentCandidate) return;
    await assertCandidateUnchanged(workspace, currentCandidate, { signal: abort });
    releaseCandidateWorkspace(workspace);
    currentCandidate = null;
  }
  async function capture({ stage, assessStructure, measureIntegration, index, signal: abort }) {
    abort?.throwIfAborted();
    await releaseChecked(abort);
    const directory = path.join(output, "captures", `${String(index).padStart(4, "0")}-${stage}`);
    const row = {
      index,
      stage,
      assessStructure,
      measureIntegration,
      directory: path.relative(output, directory),
      status: "running",
    };
    report.captures.push(row);
    await save();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await captureExtractionState({ expected: reference }, workspace, directory, {
      signal: abort,
      gradeStrict: false,
    });
    currentCandidate = state.candidate;
    let structure, assignments;
    if (assessStructure) {
      structure = await compareStructuralUnits(prepared, state.completeTree, {
        extraUnits: physicalUnits(state.physicalDiagnostics),
      });
      assignments = structuralUnitCorrections(prepared, structure);
    }
    await assertCandidateUnchanged(workspace, state.candidate, { signal: abort });
    let integration,
      compiler = [];
    if (measureIntegration) {
      integration = await measureExtractionCandidate(
        state.candidate.source,
        path.join(directory, "integration"),
        state.candidate.tree,
        { expectedPixels: setup.manifest.pixels, signal: abort, completeInventory: true },
      );
      await assertCandidateUnchanged(workspace, state.candidate, { signal: abort });
      const log = await readFile(path.join(directory, "integration", "compile.log"), "utf8").catch(
        (error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        },
      );
      compiler = compilerDiagnostics(log, state.completeTree);
    }
    row.status = "complete";
    row.candidateIdentity = state.candidate.identity;
    if (structure) row.differenceIds = structure.differenceIds;
    await save();
    return {
      structure,
      corrections: assignments,
      integration,
      compiler,
      directory: row.directory,
      candidateIdentity: state.candidate.identity,
    };
  }

  try {
    for (const [index, { name, entries, prompt }] of phases.entries()) {
      await runPhase(name, entries, prompt);
      await cp(workspace, path.join(output, `after-${index + 1}-${name}`), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    report.remainingMarkers = await cleanupWorkspaceMarkers(workspace, setup.markers);
    await save();
    if (corrections) {
      const result = await runCorrectionSchedule({
        capture,
        signal,
        score: structuralUnitScore,
        async onUpdate({ stages, attempts }) {
          report.stages = stages.map(
            ({ stage, structure, integration, directory, candidateIdentity, compiler }) => ({
              stage,
              structure,
              integration,
              directory,
              candidateIdentity,
              compiler,
            }),
          );
          report.attempts = structuredClone(attempts);
          await save();
        },
        async correctStructure({ state, attempt }) {
          assert.ok(state.corrections.length > 0, "Differences have no correction assignment");
          await releaseChecked(signal);
          await runPhase("structural-correction", state.corrections, ({ prompt }) => prompt);
          for (const row of report.deliveries.filter(
            (item) => item.phase === "structural-correction",
          ))
            await attempt(row.id, async () =>
              row.status === "timed-out" ? { timedOut: true } : undefined,
            );
        },
        async correctIntegration({ stage, state }) {
          await releaseChecked(signal);
          const prompt = integrationPrompt(stage, state, setup.manifest.pixels);
          const [result] = await runPhase(stage, [{ id: stage }], () => prompt);
          return result.status === "timed-out" ? { timedOut: true } : undefined;
        },
      });
      report.score = result.score;
      const final = report.stages.at(-1);
      report.passed =
        final.structure.differenceIds.length === 0 &&
        final.integration.buildPassed &&
        final.integration.resultMatched;
    } else {
      const state = await capture({
        stage: "probe",
        assessStructure: true,
        measureIntegration: false,
        index: 0,
        signal,
      });
      report.stages = [{ stage: "probe", structure: state.structure }];
      report.passed = state.structure.differenceIds.length === 0;
    }
    report.status = "complete";
  } catch (error) {
    report.status = "interrupted";
    for (const row of report.captures) if (row.status === "running") row.status = "interrupted";
    report.failure = { name: error.name, message: error.message, category: error.category ?? null };
    event("failure", report.failure);
    throw error;
  } finally {
    releaseCandidateWorkspace(workspace);
    report.finished = new Date().toISOString();
    await save();
  }
  return report;
}

/** Scripted participants apply exactly their assignment and never correct anything. */
function referencePools(workspace, setup) {
  const writer = scriptedAssemblyWriter(setup);
  let serial = 0,
    active = 0,
    maxActive = 0,
    extracted = 0;
  const write = (file, content) => {
    const target = path.join(workspace, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target + ".reference-write", content);
    renameSync(target + ".reference-write", target);
  };
  return {
    mode: "scripted-reference",
    stats: () => ({ moved: writer.removed(), extracted, maxActive }),
    create: (phase) => ({
      async createDriver() {
        const id = ++serial;
        return {
          id,
          closed: false,
          async terminate() {
            this.closed = true;
          },
        };
      },
      async execute(_driver, _prompt, { item, index }) {
        assert.ok(
          ["assembly", "extraction"].includes(phase),
          "The reference received a correction",
        );
        active++;
        maxActive = Math.max(active, maxActive);
        try {
          await sleep(index % 7 === 0 ? 5 : index % 3);
          // Synchronous reads and writes keep each scripted delivery atomic in the event loop.
          const main = readFileSync(path.join(workspace, "main.cpp"), "utf8");
          if (phase === "assembly") write("main.cpp", writer.assemble(main, item.items));
          else {
            const tree = writer.extract({ "main.cpp": main }, item);
            write(item.file, tree[item.file]);
            write("main.cpp", tree["main.cpp"]);
            extracted++;
          }
          return { status: "settled", receipt: { scripted: true } };
        } finally {
          active--;
        }
      },
      async cleanup() {},
    }),
  };
}

function observationPhases(setup) {
  return [
    { name: "assembly", entries: setup.deliveries, prompt: (delivery) => delivery.prompt },
    { name: "extraction", entries: setup.extractions, prompt: (entry) => entry.prompt },
  ];
}

/** Model-free proof that the measured route reaches the trusted endpoint with Score 100. */
export async function verifyAssemblyCase(casePath, outputPath, { signal } = {}) {
  const output = path.resolve(outputPath);
  const setup = await prepareAssemblyCase(casePath);
  const general = await loadGeneralPrompt();
  const identity = await assemblyRunIdentity(setup, general);
  const pools = referencePools(path.join(output, "workspace"), setup);
  const report = await runAssemblyObservation({
    setup,
    output,
    pools,
    identity,
    general,
    phases: observationPhases(setup),
    start: setup.trees.scaffold,
    reference: setup.trees.final,
    corrections: true,
    signal,
  });
  const stats = pools.stats();
  assert.deepEqual(await assemblyRunIdentity(setup, general), identity);
  const final = report.stages.at(-1);
  const summary = {
    version: ASSEMBLY_RUN_VERSION,
    identity,
    status:
      report.passed &&
      report.score.score === 100 &&
      stats.moved === setup.items.length &&
      stats.extracted === setup.regions.length &&
      stats.maxActive === ASSEMBLY_AGENTS &&
      report.remainingMarkers === 0 &&
      report.attempts.length === 0
        ? "pass"
        : "fail",
    totalUnits: report.totalUnits,
    items: setup.items.length,
    deliveries: setup.deliveries.length,
    regions: setup.regions.length,
    moved: stats.moved,
    extracted: stats.extracted,
    maxActive: stats.maxActive,
    remainingMarkers: report.remainingMarkers,
    score: report.score.score,
    finalDifferences: final.structure.differenceIds.length,
    buildPassed: final.integration.buildPassed,
    resultMatched: final.integration.resultMatched,
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}

function modelPools(output, config, general) {
  const workspace = path.join(output, "workspace");
  return {
    mode: "model",
    create(phase) {
      const drivers = chunkModelDrivers(path.join(output, phase), workspace, config, general);
      // Each session is new, so the general instructions precede every assignment.
      return {
        usage: drivers.usage,
        cleanup: drivers.cleanup,
        createDriver: (_item, session, context) => drivers.createDriver(phase, session, context),
        execute: (driver, prompt, { signal, session }) =>
          drivers.execute(driver, prompt, { signal, session }),
      };
    },
  };
}

/** Spend model credit on one observation. The proof must come from the same clean source. */
export async function runAssemblyModel(casePath, outputPath, config, { proofPath, signal } = {}) {
  const output = path.resolve(outputPath);
  const setup = await prepareAssemblyCase(casePath);
  const general = await loadGeneralPrompt();
  const identity = await assemblyRunIdentity(setup, general);
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  assert.equal(proof.version, ASSEMBLY_RUN_VERSION, "The reference proof uses another runner");
  assert.equal(proof.status, "pass", "The reference proof did not pass");
  assert.deepEqual(proof.identity, identity, "The reference proof belongs to other source");
  return runAssemblyObservation({
    setup,
    output,
    pools: modelPools(output, config, general),
    identity,
    general,
    phases: observationPhases(setup),
    start: setup.trees.scaffold,
    reference: setup.trees.final,
    corrections: true,
    signal,
  });
}

/** A partial, unscored probe: the first assembly deliveries of the queue and/or the
 * extraction of chosen regions. Without assembly deliveries, extraction starts from
 * the assembled reference. The result is compared with the scripted outcome of the
 * same assignments; no corrections run and no observation score is produced.
 */
export async function probeAssembly(
  casePath,
  outputPath,
  config,
  { deliveries = 0, regions = [], scripted = false, signal } = {},
) {
  assert.ok(Number.isSafeInteger(deliveries) && deliveries >= 0);
  assert.ok(Array.isArray(regions));
  const output = path.resolve(outputPath);
  const setup = await prepareAssemblyCase(casePath);
  assert.ok(deliveries <= setup.deliveries.length, "Too many probe deliveries");
  const extractions = regions.map((file) => {
    const entry = setup.extractions.find((candidate) => candidate.file === file);
    assert.ok(entry, `Unknown region ${file}`);
    return entry;
  });
  assert.ok(deliveries || extractions.length, "The probe has no assignment");
  const general = await loadGeneralPrompt();
  const identity = await assemblyRunIdentity(setup, general, { requireClean: false });
  const start = deliveries ? setup.trees.scaffold : setup.trees.assembled;
  const writer = scriptedAssemblyWriter(setup);
  let expected = start;
  const selected = setup.deliveries.slice(0, deliveries);
  if (deliveries) {
    let main = expected["main.cpp"];
    for (const delivery of selected) main = writer.assemble(main, delivery.items);
    expected = { ...expected, "main.cpp": main };
  }
  for (const entry of extractions) expected = writer.extract(expected, entry);
  const phases = [];
  if (selected.length)
    phases.push({ name: "assembly", entries: selected, prompt: (delivery) => delivery.prompt });
  if (extractions.length)
    phases.push({ name: "extraction", entries: extractions, prompt: (entry) => entry.prompt });
  const pools = scripted
    ? referencePools(path.join(output, "workspace"), setup)
    : modelPools(output, config, general);
  return runAssemblyObservation({
    setup,
    output,
    pools,
    identity,
    general,
    phases,
    start,
    reference: cleanupAssemblyMarkers(expected, setup.markers).tree,
    corrections: false,
    signal,
  });
}
