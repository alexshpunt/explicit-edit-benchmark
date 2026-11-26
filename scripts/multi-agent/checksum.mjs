#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const help = `Usage:
  node scripts/multi-agent/checksum.mjs show SEED NEW_DIRECTORY
  node scripts/multi-agent/checksum.mjs isolated-run SEED NEW_RUN --config PRIVATE_JSON [--agents N] --allow-model-calls
  node scripts/multi-agent/checksum.mjs shared-run SEED NEW_RUN --config PRIVATE_JSON [--agents N] [--sandbox separate|shared] --allow-model-calls

show writes the seed's start main.cpp, its reference and its task prompts.
isolated-run gives every task to a new agent in its own copy of the start project
and grades each result byte for byte against that task's reference.
shared-run starts a pool of N agents (25 by default) on one main.cpp; each agent
takes the next task from one queue as soon as it has finished its last one and
keeps its session, and the final file is graded against the reference.
--clusters LETTERS picks the clusters, such as BCFG or XYZab: letters are case
sensitive, and the clusters after Z are lowercase; --per-variant N sets the trap
and control edits per cluster; --density N puts N edits
in each zone of neighbouring lines; --edits N groups N edits into one composite task;
--lines N adds functions until main.cpp has at least N lines.
--notice adds to shared-run prompts the sentence that other agents edit main.cpp at
the same time; by default shared-run prompts equal the isolated ones.
shared-rescore SEED SAVED_RUN grades a saved shared run again with the current grader.
compare SEED ISOLATED_RUN SHARED_RUN gives the two scores of one observation: the
isolated run of the seed's tasks, then the shared run of the same tasks graded
again with the current grader, and the edits that only one of them passed.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    agents: { type: "string" },
    sandbox: { type: "string" },
    notice: { type: "boolean" },
    "allow-model-calls": { type: "boolean" },
    clusters: { type: "string" },
    "per-variant": { type: "string" },
    density: { type: "string" },
    edits: { type: "string" },
    lines: { type: "string" },
  },
});
const [command, seedText, target] = positionals;
assert.ok(
  positionals.length === (command === "compare" ? 4 : 3) && /^\d+$/.test(seedText ?? ""),
  help,
);
const seed = Number(seedText);
/** Project size options; omitted ones keep the generator's defaults. */
const options = Object.fromEntries(
  [
    ["per-variant", "perVariant"],
    ["density", "density"],
    ["edits", "edits"],
    ["lines", "lines"],
  ]
    .filter(([flag]) => values[flag] !== undefined)
    .map(([flag, key]) => [key, Number(values[flag])]),
);
if (values.clusters !== undefined) options.clusters = values.clusters;

if (command === "show") {
  const { generateChecksumProject } =
    await import("../../src/suites/explicit-edit-multi-agent/generation/checksum-project.mjs");
  const project = generateChecksumProject(seed, options);
  await mkdir(target, { mode: 0o700 });
  await writeFile(path.join(target, "main.cpp"), project.start);
  await writeFile(path.join(target, "expected-main.cpp"), project.expected);
  // Files beside main.cpp are byte strings.
  for (const [name, text] of Object.entries(project.startFiles))
    await writeFile(path.join(target, name), text, "latin1");
  for (const [name, text] of Object.entries(project.expectedFiles))
    await writeFile(path.join(target, `expected-${name}`), text, "latin1");
  const tasks = project.tasks.map(
    (task, index) =>
      `## ${index + 1}. ${task.id}${task.zone ? ` (zone ${task.zone})` : ""}\n\n${task.prompt}\n`,
  );
  await writeFile(
    path.join(target, "tasks.md"),
    [
      `# Seed ${seed}`,
      "",
      `The start prints ${project.answers.start}; the reference prints ${project.answers.expected}.`,
      "",
      ...tasks,
    ].join("\n"),
  );
} else if (command === "shared-rescore") {
  // Grade a saved shared run again with the current grader, without model calls.
  const { gradeSharedChecksum, readProjectFiles } =
    await import("../../src/suites/explicit-edit-multi-agent/checksum-run.mjs");
  const { generateChecksumProject } =
    await import("../../src/suites/explicit-edit-multi-agent/generation/checksum-project.mjs");
  const saved = JSON.parse(await readFile(path.join(target, "summary.json"), "utf8"));
  assert.equal(saved.identity.seed, seed, "The run belongs to another seed");
  const project = generateChecksumProject(seed, saved.identity.counts);
  const workspace = path.join(target, "workspace");
  const grade = gradeSharedChecksum(
    project,
    await readFile(path.join(workspace, "main.cpp"), "utf8"),
    await readProjectFiles(workspace, Object.keys(project.startFiles)),
  );
  const { tasks, ...rest } = grade;
  console.log(JSON.stringify(rest));
  for (const task of tasks.filter(({ passed }) => !passed)) console.log(`FAIL ${task.id}`);
} else if (command === "compare") {
  const {
    compareChecksumRuns,
    gradeSharedChecksum,
    isolatedFailure,
    passedAtFinish,
    readProjectFiles,
  } = await import("../../src/suites/explicit-edit-multi-agent/checksum-run.mjs");
  const { gunzipSync } = await import("node:zlib");
  const { generateChecksumProject } =
    await import("../../src/suites/explicit-edit-multi-agent/generation/checksum-project.mjs");
  const summary = async (run) => JSON.parse(await readFile(path.join(run, "summary.json"), "utf8"));
  const isolated = await summary(target);
  const shared = await summary(positionals[3]);
  assert.equal(isolated.identity.seed, seed, "The runs belong to another seed");
  // The shared file graded again, so both runs use the current grader.
  const project = generateChecksumProject(seed, shared.identity.counts);
  const workspace = path.join(positionals[3], "workspace");
  const grade = gradeSharedChecksum(
    project,
    await readFile(path.join(workspace, "main.cpp"), "utf8"),
    await readProjectFiles(workspace, Object.keys(project.startFiles)),
  );
  const failed = new Map(grade.tasks.map((task) => [task.id, task.failedEdits]));
  // The file as each task's agent left it, graded again where the run kept it.
  const atFinish = async (row) => {
    const saved = await readFile(path.join(positionals[3], "finished", `${row.id}.json.gz`)).catch(
      () => null,
    );
    if (saved === null) return row.passedAtFinish;
    const task = project.tasks.find(({ id }) => id === row.id);
    return passedAtFinish(project, task, JSON.parse(gunzipSync(saved).toString("utf8")));
  };
  const regraded = {
    ...shared,
    damaged: grade.damaged,
    collateral: grade.collateral,
    tasks: await Promise.all(
      shared.tasks.map(async (row) => ({
        ...row,
        failedEdits: failed.get(row.id),
        passedAtFinish: await atFinish(row),
      })),
    ),
  };
  // An isolated run from before failure kinds gets them from its saved workspaces.
  const names = Object.keys(project.startFiles);
  for (const row of isolated.tasks)
    if (row.failure === undefined && row.edits.some(({ passed }) => !passed)) {
      const own = path.join(target, "tasks", row.id, "workspace");
      const main = await readFile(path.join(own, "main.cpp"), "utf8").catch(() => null);
      const task = project.tasks.find(({ id }) => id === row.id);
      row.failure = isolatedFailure(
        project,
        task,
        row.status,
        main,
        await readProjectFiles(own, names),
      );
    }
  const score = compareChecksumRuns(isolated, regraded);
  const part = ({ passed, total }) => `${passed} of ${total}`;
  const line = (name, own) =>
    `${name}: ${part(own)} edits; traps ${part(own.traps)}, controls ${part(own.controls)}`;
  console.log(`${score.harness}, ${score.model}, seed ${score.seed}, ${score.project}`);
  console.log(line("Alone (isolated)", score.isolated));
  console.log(
    `${line(`Crowd (pool of ${score.shared.agents})`, score.shared)}; the file ` +
      `${score.shared.built ? "builds" : "does not build"}, ` +
      `${score.shared.answer ? "prints" : "does not print"} the reference answer, ` +
      `${score.shared.collateral} collateral paragraphs`,
  );
  const broken = score.shared.providerFailures + score.isolatedProviderFailures;
  if (broken > 0)
    console.log(
      `Provider failures: ${score.isolatedProviderFailures} isolated tasks after every ` +
        `attempt and ${score.shared.providerFailures} shared deliveries; their tasks count as failed`,
    );
  const cell = ({ trap, control }) =>
    `${trap.passed}/${trap.total} ${control.passed}/${control.total}`;
  console.log("Cluster  alone: traps controls  crowd: traps controls");
  for (const [cluster, { isolated: alone, shared: crowd }] of Object.entries(score.byCluster))
    console.log(`${cluster.padEnd(8)} ${cell(alone).padEnd(22)} ${cell(crowd)}`);
  const list = (edits) =>
    edits
      .map(({ id, cluster, variant, kind }) => `${id} (${cluster} ${variant}, ${kind})`)
      .join(", ") || "none";
  const kinds = (counts) =>
    Object.entries(counts)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ") || "none";
  console.log(`Why edits failed alone: ${kinds(score.failures.isolated)}`);
  console.log(`Why edits failed in the crowd: ${kinds(score.failures.shared)}`);
  console.log(`Failed alone: ${list(score.failedAlone)}`);
  console.log(`Lost in the crowd: ${list(score.lostInCrowd)}`);
  console.log(`Passed only in the crowd, with why they failed alone: ${list(score.gainedInCrowd)}`);
} else if (command === "isolated-run" || command === "shared-run") {
  assert.equal(
    values["allow-model-calls"],
    true,
    "Model calls require explicit --allow-model-calls",
  );
  assert.equal(typeof values.config, "string", help);
  assert.ok(command === "shared-run" || values.sandbox === undefined, help);
  const { runChecksumIsolated, runChecksumShared } =
    await import("../../src/suites/explicit-edit-multi-agent/checksum-run.mjs");
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => controller.abort());
  const run = command === "shared-run" ? runChecksumShared : runChecksumIsolated;
  const summary = await run(seed, target, JSON.parse(await readFile(values.config, "utf8")), {
    agents: values.agents === undefined ? undefined : Number(values.agents),
    options,
    ...(values.sandbox === undefined ? {} : { sandbox: values.sandbox }),
    ...(values.notice ? { notice: true } : {}),
    signal: controller.signal,
  });
  const { identity: _identity, tasks, ...rest } = summary;
  console.log(JSON.stringify(rest));
  for (const task of tasks)
    console.log(
      `${task.exact || task.passed ? "pass" : "FAIL"} ${task.id} status=${task.status}` +
        (command === "isolated-run"
          ? ` built=${task.built} answer=${task.answer}/${task.expectedAnswer}`
          : ` session=${task.session} delivery=${task.delivery} seconds=${task.seconds}`),
    );
} else throw new Error(help);
