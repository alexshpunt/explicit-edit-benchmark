#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const help = `Usage:
  node scripts/multi-agent/checksum.mjs show SEED NEW_DIRECTORY
  node scripts/multi-agent/checksum.mjs isolated-run SEED NEW_RUN --config PRIVATE_JSON [--agents N] --allow-model-calls

show writes the seed's start main.cpp, its reference and its task prompts.
isolated-run gives every task to a new agent in its own copy of the start project
and grades each result byte for byte against that task's reference.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    agents: { type: "string" },
    "allow-model-calls": { type: "boolean" },
  },
});
const [command, seedText, target] = positionals;
assert.ok(positionals.length === 3 && /^\d+$/.test(seedText ?? ""), help);
const seed = Number(seedText);

if (command === "show") {
  const { generateChecksumProject } =
    await import("../../src/suites/explicit-edit-multi-agent/generation/checksum-project.mjs");
  const project = generateChecksumProject(seed);
  await mkdir(target, { mode: 0o700 });
  await writeFile(path.join(target, "main.cpp"), project.start);
  await writeFile(path.join(target, "expected-main.cpp"), project.expected);
  const tasks = project.tasks.map(
    (task, index) => `## ${index + 1}. ${task.id}\n\n${task.prompt}\n`,
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
} else if (command === "isolated-run") {
  assert.equal(
    values["allow-model-calls"],
    true,
    "Model calls require explicit --allow-model-calls",
  );
  assert.equal(typeof values.config, "string", help);
  const { runChecksumIsolated } =
    await import("../../src/suites/explicit-edit-multi-agent/checksum-run.mjs");
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => controller.abort());
  const summary = await runChecksumIsolated(
    seed,
    target,
    JSON.parse(await readFile(values.config, "utf8")),
    {
      agents: values.agents === undefined ? undefined : Number(values.agents),
      signal: controller.signal,
    },
  );
  const { identity: _identity, tasks, ...rest } = summary;
  console.log(JSON.stringify(rest));
  for (const task of tasks)
    console.log(
      `${task.exact ? "pass" : "FAIL"} ${task.id} status=${task.status} built=${task.built} answer=${task.answer}/${task.expectedAnswer}`,
    );
} else throw new Error(help);
