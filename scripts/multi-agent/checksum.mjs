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
shared-rescore SEED SAVED_RUN grades a saved shared run again with the current grader.`;

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
assert.ok(positionals.length === 3 && /^\d+$/.test(seedText ?? ""), help);
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
          : ` wave=${task.wave} seconds=${task.seconds}`),
    );
} else throw new Error(help);
