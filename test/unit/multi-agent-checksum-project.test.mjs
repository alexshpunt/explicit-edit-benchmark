import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  CHECKSUM_PROJECT_DEFAULTS,
  generateChecksumProject,
} from "../../src/suites/explicit-edit-multi-agent/generation/checksum-project.mjs";
import {
  gradeSharedChecksum,
  sharedPrompt,
} from "../../src/suites/explicit-edit-multi-agent/checksum-run.mjs";

const exec = promisify(execFile);

/** Build one main.cpp with warnings as errors and return what it prints. */
async function output(root, name, source, signal) {
  const file = path.join(root, `${name}.cpp`),
    binary = path.join(root, name);
  await writeFile(file, source);
  await exec("clang++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", file, "-o", binary], {
    signal,
  });
  const { stdout, stderr } = await exec(binary, [], { signal });
  assert.equal(stderr, "");
  return stdout;
}

test("a seed fixes the checksum project and its tasks", () => {
  assert.deepEqual(generateChecksumProject(7), generateChecksumProject(7));
  assert.notEqual(generateChecksumProject(7).start, generateChecksumProject(8).start);
});

const LARGE = { functions: 80, moves: 20, renames: 15, expressions: 15 };
for (const [seed, options] of [
  [1, {}],
  [2, {}],
  [3, {}],
  [4, LARGE],
]) {
  test(`checksum project ${seed} ${JSON.stringify(options)}: every state builds and prints its answer`, async (t) => {
    const project = generateChecksumProject(seed, options);
    const size = { ...CHECKSUM_PROJECT_DEFAULTS, ...options };
    const root = await mkdtemp(path.join(os.tmpdir(), "checksum-project-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const counts = Object.fromEntries(
      ["move", "rename", "expression"].map((kind) => [
        kind,
        project.tasks.filter((task) => task.kind === kind).length,
      ]),
    );
    assert.deepEqual(counts, {
      move: size.moves,
      rename: size.renames,
      expression: size.expressions,
    });
    assert.notEqual(project.answers.expected, project.answers.start);
    assert.doesNotMatch(project.expected, /__EXPLICIT_EDIT_SLOT_/);
    const states = [
      { id: "start", source: project.start, answer: project.answers.start },
      { id: "expected", source: project.expected, answer: project.answers.expected },
      ...project.tasks.map((task) => ({ id: task.id, source: task.result, answer: task.answer })),
    ];
    const printed = await Promise.all(
      states.map((state) => output(root, state.id, state.source, t.signal)),
    );
    states.forEach((state, index) => assert.equal(printed[index], `${state.answer}\n`, state.id));
    for (const task of project.tasks) {
      assert.notEqual(task.result, project.start);
      if (task.kind === "expression") assert.notEqual(task.answer, project.answers.start);
      else assert.equal(task.answer, project.answers.start);
    }
  });
}

/** Follow one task's instruction literally, as plain text operations. */
function followInstruction(start, task) {
  if (task.kind === "rename") return start.replaceAll(task.name, task.newName);
  if (task.kind === "expression") return start.replace(task.before, task.after);
  const lines = start.split("\n");
  const first = lines.indexOf(`long long ${task.name}(long long value) {`);
  const last = lines.indexOf("}", first);
  assert.equal(last - first + 1, task.lines, task.id);
  const moved = lines.splice(first, task.lines);
  assert.equal(lines.splice(first, 1)[0], "", task.id);
  lines.splice(lines.indexOf(task.marker), 1, ...moved);
  return lines.join("\n");
}

test("each instruction, followed literally, gives exactly its task's result", () => {
  for (let seed = 0; seed < 50; seed++) {
    const project = generateChecksumProject(seed, seed % 5 === 0 ? LARGE : {});
    let all = project.start;
    for (const task of project.tasks) {
      assert.equal(followInstruction(project.start, task), task.result, `${seed}: ${task.id}`);
      assert.match(task.prompt, /^Perform only the following mechanical file edits\./);
      all = followInstruction(all, task);
    }
    assert.equal(all, project.expected, `${seed}: all tasks`);
  }
});

test("the shared grade credits finished tasks and names damaged definitions", () => {
  const project = generateChecksumProject(42);
  assert.deepEqual(
    { exact: true, passed: 10, damaged: [], extra: [] },
    (({ exact, passed, damaged, extra }) => ({ exact, passed, damaged, extra }))(
      gradeSharedChecksum(project, project.expected),
    ),
  );
  assert.equal(gradeSharedChecksum(project, project.start).passed, 0);
  let partial = project.start;
  const done = project.tasks.slice(0, 5);
  for (const task of done) partial = followInstruction(partial, task);
  const grade = gradeSharedChecksum(project, partial);
  assert.deepEqual(
    grade.tasks.filter(({ passed }) => passed).map(({ id }) => id),
    done.map(({ id }) => id),
  );
  // A writer that drops a whole definition loses it without touching its neighbours.
  const lost = project.tasks.find(({ kind }) => kind === "expression");
  const header = project.expected
    .split("\n\n")
    .find((block) => block.includes(lost.after))
    .split("\n")[0];
  const broken = project.expected
    .split("\n\n")
    .filter((block) => !block.startsWith(header))
    .join("\n\n");
  const damaged = gradeSharedChecksum(project, broken);
  assert.deepEqual(damaged.damaged, [header]);
  assert.equal(damaged.tasks.find(({ id }) => id === lost.id).passed, false);
  assert.match(sharedPrompt(lost), /^Perform only[^\n]*\n\nSeveral agents are editing main\.cpp/);
});

test("tasks never edit the same text", () => {
  for (let seed = 0; seed < 50; seed++) {
    const project = generateChecksumProject(seed);
    const renamed = new Set(
      project.tasks.filter(({ kind }) => kind === "rename").map(({ name }) => name),
    );
    const moved = new Set(
      project.tasks.filter(({ kind }) => kind === "move").map(({ name }) => name),
    );
    for (const task of project.tasks) {
      if (task.kind === "move") {
        const definition = new RegExp(
          `^long long ${task.name}\\(long long value\\) \\{\\n[\\s\\S]*?^\\}$`,
          "m",
        ).exec(project.start)?.[0];
        assert.ok(definition, `${seed}: ${task.id} has no definition`);
        for (const name of renamed) assert.doesNotMatch(definition, new RegExp(`\\b${name}\\b`));
      }
      if (task.kind === "expression") {
        assert.ok(!moved.has(task.id.slice("expression-".length)), `${seed}: ${task.id}`);
        for (const name of renamed) assert.ok(!task.before.includes(name), `${seed}: ${task.id}`);
        assert.equal(project.start.split(task.before).length, 2, `${seed}: ${task.id}`);
      }
    }
  }
});
