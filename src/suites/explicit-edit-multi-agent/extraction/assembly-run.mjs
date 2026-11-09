import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeTree } from "../generation/generator.mjs";
import { measureExtractionCandidate } from "../grading/coherent-build.mjs";
import { compilerDiagnostics } from "../grading/repair-diagnostics.mjs";
import {
  LINE_DIFFERENCE_POLICY,
  compareLineDifferences,
  fileExactness,
  prepareLineDifferences,
} from "../grading/line-differences.mjs";
import {
  LINE_DIFFERENCE_SCORE_POLICY,
  structuralUnitScore,
} from "../grading/structural-unit-score.mjs";
import {
  assertCandidateUnchanged,
  captureCandidate,
  releaseCandidateWorkspace,
} from "../execution/candidate-evidence.mjs";
import { chunkModelDrivers } from "../execution/chunk-model-drivers.mjs";
import { SHARED_SANDBOX_POLICY, startSharedSandbox } from "../execution/shared-sandbox.mjs";
import { runCorrectionSchedule } from "../execution/correction-schedule.mjs";
import {
  AGENT_LIFECYCLES,
  AGENT_QUEUE_POLICIES,
  FRESH_AGENT_QUEUE_POLICY,
  runAgentQueue,
} from "../execution/fresh-agent-queue.mjs";
import { restoringSourceIdentity } from "../execution/restoring-identity.mjs";
import {
  ASSEMBLY_ASSIGNMENT_BYTES,
  ASSEMBLY_ASSIGNMENT_UNITS,
  ASSEMBLY_CASE_VERSION,
  cleanupAssemblyMarkers,
  prepareAssemblyCase,
  scriptedAssemblyWriter,
} from "./assembly-case.mjs";
import { ASSEMBLY_CORRECTION_POLICY, assemblyCorrections } from "./assembly-corrections.mjs";
import { ASSEMBLY_RENAME_VERSION, renameLeftovers } from "./assembly-renames.mjs";
import { integrationPrompt, loadGeneralPrompt, physicalUnits } from "./chunk-run.mjs";
import { captureExtractionState } from "./run.mjs";
import { MIXED_PROBE_VERSION, gradeMixedProbe, prepareMixedProbe } from "./mixed-probe.mjs";

export const ASSEMBLY_RUN_VERSION = "renderer-assembly-run-v3";
export const ASSEMBLY_AGENTS = 20;
/** Long enough that slower models are not cut off, short enough to bound a run. */
export const ASSEMBLY_DELIVERY_DEADLINE_MS = 300_000;
export const ASSEMBLY_AGENT_LIFECYCLES = AGENT_LIFECYCLES;
const ASSEMBLY_POLICY_VERSION = "renderer-assembly-policy-v7";

/** The lifecycle of assembly and extraction agents is part of the run policy, so
 * scores from per-delivery and persistent runs are never compared as one kind.
 * Corrections always start a new agent for every assignment.
 */
export function assemblyRunPolicy(lifecycle = "per-delivery") {
  assert.ok(AGENT_LIFECYCLES.includes(lifecycle), `Unknown agent lifecycle ${lifecycle}`);
  const persistent = lifecycle === "persistent";
  return Object.freeze({
    version: ASSEMBLY_POLICY_VERSION,
    case: ASSEMBLY_CASE_VERSION,
    // The rename phase runs only for a case with renames.
    phases: Object.freeze(["assembly", "rename", "extraction"]),
    renames: ASSEMBLY_RENAME_VERSION,
    agents: ASSEMBLY_AGENTS,
    lifecycle,
    queue: AGENT_QUEUE_POLICIES[lifecycle],
    correctionQueue: FRESH_AGENT_QUEUE_POLICY,
    assemblyOrder: "regions-interleaved-round-robin",
    assignment: Object.freeze({
      bytes: ASSEMBLY_ASSIGNMENT_BYTES,
      units: ASSEMBLY_ASSIGNMENT_UNITS,
    }),
    delivery: Object.freeze({
      deadlineSeconds: ASSEMBLY_DELIVERY_DEADLINE_MS / 1000,
      onTimeout: persistent ? "close-and-replace-agent" : "close-and-continue",
      generalInstructions: persistent
        ? "before-each-agent-first-assignment"
        : "before-every-assignment",
    }),
    controller: "never-repairs-or-rewrites-assignments",
    schedule: "original-structural-build-result",
    units: LINE_DIFFERENCE_POLICY,
    corrections: ASSEMBLY_CORRECTION_POLICY,
    score: LINE_DIFFERENCE_SCORE_POLICY,
  });
}
export const ASSEMBLY_RUN_POLICY = assemblyRunPolicy();

const hash = (data) => createHash("sha256").update(data).digest("hex");

/** Model execution and its reference proof require the same clean committed source. */
export async function assemblyRunIdentity(setup, general, { requireClean = true } = {}) {
  const source = await restoringSourceIdentity();
  if (requireClean)
    assert.equal(source.sourceClean, true, "Assembly runs require clean committed source");
  return {
    source,
    planSha256: setup.manifest.planSha256,
    traps: setup.traps,
    renames: renameSummary(setup),
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
  lifecycle = "per-delivery",
  signal,
}) {
  const policy = assemblyRunPolicy(lifecycle);
  const workspace = path.join(output, "workspace");
  await mkdir(output, { mode: 0o700 });
  await writeTree(workspace, start);
  const prepared = prepareLineDifferences(
    cleanupAssemblyMarkers(start, setup.markers).tree,
    reference,
  );
  const report = {
    version: ASSEMBLY_RUN_VERSION,
    policy,
    lifecycle,
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
    sessions: /** @type {any[]} */ ([]),
    captures: /** @type {any[]} */ ([]),
    stages: /** @type {any[]} */ ([]),
    attempts: /** @type {any[]} */ ([]),
    remainingMarkers: /** @type {number | null} */ (null),
    score: /** @type {any} */ (null),
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

  /** Agents follow the phase lifecycle; the controller issues prompts exactly as prepared. */
  async function runPhase(
    name,
    entries,
    promptOf,
    phaseLifecycle = "per-delivery",
    maxAgents = ASSEMBLY_AGENTS,
  ) {
    const pool = pools.create(name);
    const phase = { name, lifecycle: phaseLifecycle, status: "running", entries: entries.length };
    report.phases.push(phase);
    await save();
    /** @type {any} */
    let failure;
    /** @type {any[]} */
    let completed = [];
    try {
      const { results, maxLive, agents } = await runAgentQueue(entries, {
        lifecycle: phaseLifecycle,
        maxAgents,
        signal,
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
        async onClosed(driver, _item, result, deliveries) {
          // A persistent agent reports usage once for all of its deliveries.
          report.sessions.push({
            phase: name,
            session: result.session,
            deliveries,
            usage: driver ? (pool.usage?.(driver) ?? null) : null,
          });
        },
      });
      phase.status = "complete";
      phase.maxLive = maxLive;
      phase.agents = agents;
      phase.timedOut = results.filter((result) => result?.status === "timed-out").length;
      completed = results;
    } catch (error) {
      failure = error;
      phase.status = "interrupted";
    }
    try {
      await pool.cleanup();
    } catch (error) {
      if (failure) report.cleanupFailure = { name: error.name, message: error.message };
      else failure = error;
    }
    await save();
    if (failure) throw failure;
    return completed;
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
      structure = compareLineDifferences(prepared, state.completeTree, {
        extraUnits: physicalUnits(state.physicalDiagnostics),
      });
      // Probes compare with a partial reference and issue no corrections.
      if (corrections) {
        // Old names left in code get one rename instruction instead of a hunk per line.
        const { tree, leftovers } = renameLeftovers(
          state.completeTree,
          setup.renames.selected,
          reference,
        );
        assignments = assemblyCorrections(
          setup.reference,
          prepared,
          leftovers.size
            ? compareLineDifferences(prepared, tree, {
                extraUnits: physicalUnits(state.physicalDiagnostics),
              })
            : structure,
          tree,
          { leftovers },
        );
      } else assignments = [];
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
    for (const [index, { name, entries, prompt, agents }] of phases.entries()) {
      await runPhase(name, entries, prompt, lifecycle, agents);
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
              // Hunks repeat the differing lines; the differences keep them once.
              structure: structure && { ...structure, hunks: structure.hunks.length },
              exactness: structure ? fileExactness(prepared, structure) : null,
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
      report.stages = [
        {
          stage: "probe",
          structure: { ...state.structure, hunks: state.structure.hunks.length },
          exactness: fileExactness(prepared, state.structure),
        },
      ];
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
    extracted = 0,
    renamed = 0;
  const write = (file, content) => {
    const target = path.join(workspace, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target + ".reference-write", content);
    renameSync(target + ".reference-write", target);
  };
  return {
    mode: "scripted-reference",
    stats: () => ({ moved: writer.removed(), renamed, extracted, maxActive }),
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
          ["assembly", "rename", "extraction"].includes(phase),
          "The reference received a correction",
        );
        active++;
        maxActive = Math.max(active, maxActive);
        try {
          await sleep(index % 7 === 0 ? 5 : index % 3);
          // Synchronous reads and writes keep each scripted delivery atomic in the event loop.
          const main = readFileSync(path.join(workspace, "main.cpp"), "utf8");
          if (phase === "assembly") write("main.cpp", writer.assemble(main, item.items));
          else if (phase === "rename") {
            write("main.cpp", writer.rename(main, item));
            renamed++;
          } else {
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
    ...(setup.renameDeliveries.length
      ? [
          {
            name: "rename",
            entries: setup.renameDeliveries,
            prompt: (entry) => entry.prompt,
            agents: setup.renames.agents,
          },
        ]
      : []),
    { name: "extraction", entries: setup.extractions, prompt: (entry) => entry.prompt },
  ];
}

/** The rename share and selection are part of the case identity. */
function renameSummary(setup) {
  const { version, percent, agents, eligible, selected } = setup.renames;
  return { version, percent, agents, eligible, selected: selected.length };
}

/** Model-free proof that the measured route reaches the trusted endpoint with Score 100. */
export async function verifyAssemblyCase(
  casePath,
  outputPath,
  { lifecycle = "per-delivery", traps = 0, renames = 0, renameAgents = 20, signal } = {},
) {
  const output = path.resolve(outputPath);
  const setup = await prepareAssemblyCase(casePath, { traps, renames, renameAgents });
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
    lifecycle,
    signal,
  });
  const stats = pools.stats();
  // The end of assembly, every file still in its region, must build on its own.
  const assembledDirectory = path.join(output, "assembled-reference");
  await mkdir(assembledDirectory, { mode: 0o700 });
  await writeTree(path.join(assembledDirectory, "source"), setup.trees.assembled);
  const assembledCandidate = await captureCandidate(
    path.join(assembledDirectory, "source"),
    path.join(assembledDirectory, "candidate"),
    { signal, includeAllFiles: true },
  );
  const assembled = await measureExtractionCandidate(
    assembledCandidate.source,
    path.join(assembledDirectory, "integration"),
    assembledCandidate.tree,
    { expectedPixels: setup.manifest.pixels, signal, completeInventory: true },
  );
  releaseCandidateWorkspace(path.join(assembledDirectory, "source"));
  assert.deepEqual(await assemblyRunIdentity(setup, general), identity);
  const final = report.stages.at(-1);
  const agentsOf = (name) => report.phases.find((phase) => phase.name === name).agents;
  const expectedAgents = (entries, limit = ASSEMBLY_AGENTS) =>
    lifecycle === "persistent" ? Math.min(limit, entries) : entries;
  const summary = {
    version: ASSEMBLY_RUN_VERSION,
    identity,
    lifecycle,
    traps: setup.traps,
    renames: renameSummary(setup),
    status:
      report.passed &&
      report.score.score === 100 &&
      stats.moved === setup.items.length &&
      stats.renamed === setup.renameDeliveries.length &&
      stats.extracted === setup.regions.length &&
      (!setup.renameDeliveries.length ||
        agentsOf("rename") ===
          expectedAgents(setup.renameDeliveries.length, setup.renames.agents)) &&
      stats.maxActive === ASSEMBLY_AGENTS &&
      agentsOf("assembly") === expectedAgents(setup.deliveries.length) &&
      agentsOf("extraction") === expectedAgents(setup.extractions.length) &&
      report.remainingMarkers === 0 &&
      report.attempts.length === 0 &&
      assembled.buildPassed &&
      assembled.resultMatched
        ? "pass"
        : "fail",
    totalUnits: report.totalUnits,
    items: setup.items.length,
    deliveries: setup.deliveries.length,
    regions: setup.regions.length,
    moved: stats.moved,
    extracted: stats.extracted,
    maxActive: stats.maxActive,
    assemblyAgents: agentsOf("assembly"),
    renamed: stats.renamed,
    renameAgents: setup.renameDeliveries.length ? agentsOf("rename") : 0,
    extractionAgents: agentsOf("extraction"),
    remainingMarkers: report.remainingMarkers,
    score: report.score.score,
    finalDifferences: final.structure.differenceIds.length,
    finalExactFiles: final.exactness.exactFiles,
    referenceFiles: final.exactness.referenceFiles,
    buildPassed: final.integration.buildPassed,
    resultMatched: final.integration.resultMatched,
    assembledBuildPassed: assembled.buildPassed,
    assembledResultMatched: assembled.resultMatched,
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}

function modelPools(output, config, general, { sharedSandbox } = {}) {
  const workspace = path.join(output, "workspace");
  return {
    mode: "model",
    create(phase) {
      const drivers = chunkModelDrivers(path.join(output, phase), workspace, config, general, {
        sharedSandbox,
      });
      // The general instructions precede the first assignment of every session.
      return {
        usage: drivers.usage,
        cleanup: drivers.cleanup,
        createDriver: (_item, session, context) => drivers.createDriver(phase, session, context),
        execute: (driver, prompt, { signal, session }) =>
          drivers.execute(driver, prompt, {
            signal,
            session,
            timeoutMs: ASSEMBLY_DELIVERY_DEADLINE_MS,
          }),
      };
    },
  };
}

/** Spend model credit on one observation. The proof must come from the same clean source. */
export async function runAssemblyModel(
  casePath,
  outputPath,
  config,
  { proofPath, lifecycle = "per-delivery", traps = 0, renames = 0, renameAgents = 20, signal } = {},
) {
  const output = path.resolve(outputPath);
  const setup = await prepareAssemblyCase(casePath, { traps, renames, renameAgents });
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
    lifecycle,
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
  {
    deliveries = 0,
    regions = [],
    scripted = false,
    lifecycle = "per-delivery",
    traps = 0,
    signal,
  } = {},
) {
  assert.ok(Number.isSafeInteger(deliveries) && deliveries >= 0);
  assert.ok(Array.isArray(regions));
  const output = path.resolve(outputPath);
  const setup = await prepareAssemblyCase(casePath, { traps });
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
    lifecycle,
    signal,
  });
}

/** The mixed probe's identity: clean source, its tasks and the general prompt. */
async function mixedProbeIdentity(
  probe,
  general,
  harness,
  agents = ASSEMBLY_AGENTS,
  sandbox = null,
) {
  const source = await restoringSourceIdentity();
  assert.equal(source.sourceClean, true, "Mixed probes require clean committed source");
  return {
    version: MIXED_PROBE_VERSION,
    source,
    planSha256: probe.setup.manifest.planSha256,
    counts: probe.counts,
    identities: probe.identities,
    generalSha256: hash(general),
    agents,
    deadlineSeconds: ASSEMBLY_DELIVERY_DEADLINE_MS / 1000,
    harness,
    sandbox,
  };
}

/** Sample the resident memory of this process's descendants every five seconds
 * and report the peak, in megabytes, with the process count at that moment.
 */
export function sampleTreeMemory() {
  const peak = { megabytes: 0, processes: 0 };
  const sample = () => {
    const parents = new Map(),
      rss = new Map();
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        parents.set(Number(pid), Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]));
        rss.set(Number(pid), Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0));
      } catch {
        // A process that exits between listing and reading has no memory left to count.
      }
    }
    const within = (pid) => {
      for (let at = parents.get(pid); at; at = parents.get(at)) if (at === process.pid) return true;
      return false;
    };
    let kilobytes = 0,
      processes = 0;
    for (const [pid, size] of rss)
      if (within(pid)) {
        kilobytes += size;
        processes++;
      }
    if (kilobytes / 1024 > peak.megabytes)
      Object.assign(peak, { megabytes: Math.round(kilobytes / 1024), processes });
  };
  const timer = setInterval(sample, 5000);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      return peak;
    },
  };
}

/** Build one main.cpp and render both scenes. */
export async function measureMain(directory, main, expectedPixels, signal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeTree(path.join(directory, "source"), { "main.cpp": main });
  const candidate = await captureCandidate(
    path.join(directory, "source"),
    path.join(directory, "candidate"),
    { signal, includeAllFiles: true },
  );
  try {
    return await measureExtractionCandidate(
      candidate.source,
      path.join(directory, "integration"),
      candidate.tree,
      { expectedPixels, signal, completeInventory: true },
    );
  } finally {
    releaseCandidateWorkspace(path.join(directory, "source"));
  }
}

/** Model-free proof of a mixed probe: the reference passes every check, the start
 * fails every check, and the reference main.cpp builds and renders the images.
 */
export async function verifyMixedProbe(casePath, outputPath, { counts = {}, signal } = {}) {
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const probe = await prepareMixedProbe(casePath, counts);
  const general = await loadGeneralPrompt();
  const identity = await mixedProbeIdentity(probe, general, null);
  const reference = gradeMixedProbe(probe, probe.expected["main.cpp"]);
  const start = gradeMixedProbe(probe, probe.start["main.cpp"]);
  const build = await measureMain(
    path.join(output, "reference"),
    probe.expected["main.cpp"],
    probe.setup.manifest.pixels,
    signal,
  );
  const summary = {
    version: MIXED_PROBE_VERSION,
    identity,
    status:
      reference.all.passed === reference.all.total &&
      reference.exact &&
      start.all.passed === 0 &&
      build.buildPassed &&
      build.resultMatched
        ? "pass"
        : "fail",
    deliveries: probe.queue.length,
    checks: { reference: reference.all, start: start.all },
    renames: probe.renames.map(({ kind, role, name, newName, edits }) => ({
      kind,
      role,
      name,
      newName,
      edits,
    })),
    buildPassed: build.buildPassed,
    resultMatched: build.resultMatched,
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}

/** One mixed observation: twenty agents work through the interleaved queue once,
 * without corrections. The summary reports the checks, file integrity, build and
 * render, tokens, cost and wall time.
 */
export async function runMixedProbe(
  casePath,
  outputPath,
  config,
  { proofPath, counts = {}, agents = ASSEMBLY_AGENTS, sandbox = "separate", signal } = {},
) {
  assert.ok(Number.isInteger(agents) && agents >= 1 && agents <= ASSEMBLY_AGENTS);
  assert.ok(["separate", "shared"].includes(sandbox), `Unknown sandbox mode ${sandbox}`);
  const shared = sandbox === "shared";
  const output = path.resolve(outputPath);
  const probe = await prepareMixedProbe(casePath, counts);
  const general = await loadGeneralPrompt();
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  assert.equal(proof.status, "pass", "The reference proof did not pass");
  assert.deepEqual(
    proof.identity,
    await mixedProbeIdentity(probe, general, null),
    "The reference proof belongs to other source or tasks",
  );
  const identity = await mixedProbeIdentity(
    probe,
    general,
    config.harness ?? "baseline-agent",
    agents,
    shared ? SHARED_SANDBOX_POLICY : null,
  );
  const started = Date.now();
  const memory = sampleTreeMemory();
  // In shared mode all agents of the run work in one sandbox, started with the first agent.
  /** @type {ReturnType<typeof startSharedSandbox> | undefined} */
  let team;
  const sharedSandbox = shared
    ? () => (team ??= startSharedSandbox(path.join(output, "sandbox")))
    : undefined;
  let report;
  try {
    report = await runAssemblyObservation({
      setup: probe.setup,
      output,
      pools: modelPools(output, config, general, { sharedSandbox }),
      identity,
      general,
      phases: [{ name: "mixed", entries: probe.queue, prompt: (entry) => entry.prompt, agents }],
      start: probe.start,
      reference: probe.expected,
      corrections: false,
      signal,
    });
  } finally {
    if (team) await (await team).stop();
  }
  const minutes = (Date.now() - started) / 60000;
  const peakMemory = memory.stop();
  const main = await readFile(path.join(output, "workspace", "main.cpp"), "utf8");
  const grade = gradeMixedProbe(probe, main);
  const build = await measureMain(
    path.join(output, "final-build"),
    cleanupAssemblyMarkers({ "main.cpp": main }, probe.setup.markers).tree["main.cpp"],
    probe.setup.manifest.pixels,
    signal,
  );
  const usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  for (const { usage: session } of report.sessions)
    for (const key of Object.keys(usage)) usage[key] += session?.[key] ?? 0;
  const rows = report.deliveries;
  const summary = {
    version: MIXED_PROBE_VERSION,
    identity,
    status: report.status,
    sandbox: shared ? SHARED_SANDBOX_POLICY : "separate",
    minutes: Number(minutes.toFixed(2)),
    deliveries: rows.length,
    timedOut: rows.filter((row) => row.status === "timed-out").length,
    checks: grade,
    differences: report.stages.at(-1).structure.differenceIds.length,
    buildPassed: build.buildPassed,
    resultMatched: build.resultMatched,
    usage,
    peakMemory,
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}
