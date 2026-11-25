import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  CHECKSUM_CLUSTERS,
  CHECKSUM_PROJECT_DEFAULTS,
  definitionText,
  generateChecksumProject,
  identifierCount,
} from "../../src/suites/explicit-edit-multi-agent/generation/checksum-project.mjs";
import {
  clusterSummary,
  gradeSharedChecksum,
  sharedPrompt,
} from "../../src/suites/explicit-edit-multi-agent/checksum-run.mjs";

const exec = promisify(execFile);
const ALL = "ABCDEFG";
const CONFIGS = [
  {},
  { clusters: ALL },
  { density: 2 },
  { density: 3, clusters: ALL },
  { density: 5 },
  { edits: 4 },
  { density: 3, edits: 2 },
];
const atoms = (project) => project.tasks.flatMap((task) => task.parts ?? [task]);

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

for (const { seed, options } of [
  { seed: 1, options: {} },
  { seed: 2, options: { density: 2, clusters: ALL } },
  { seed: 3, options: { density: 3 } },
  { seed: 4, options: { edits: 4, clusters: ALL } },
  { seed: 5, options: { perVariant: 3, density: 4 } },
]) {
  test(`checksum project ${seed} ${JSON.stringify(options)}: every state builds and prints its answer`, async (t) => {
    const project = generateChecksumProject(seed, options);
    const size = { ...CHECKSUM_PROJECT_DEFAULTS, ...options };
    const root = await mkdtemp(path.join(os.tmpdir(), "checksum-project-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const edits = atoms(project);
    assert.equal(edits.length, 2 * size.clusters.length * size.perVariant);
    assert.equal(project.tasks.length * size.edits, edits.length);
    for (const summary of Object.values(clusterSummary(edits)))
      assert.deepEqual(summary, {
        trap: { passed: 0, total: size.perVariant },
        control: { passed: 0, total: size.perVariant },
      });
    assert.notEqual(project.answers.expected, project.answers.start);
    assert.doesNotMatch(project.expected, /__EXPLICIT_EDIT_SLOT_/);
    const lines = project.start.split("\n").length;
    assert.ok(lines > 300 && lines < 900, `${lines} lines`);
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
      // Only a changed factor alters the answer, and one always does.
      const changes = (task.parts ?? [task]).some(({ cluster }) => "EF".includes(cluster));
      assert.equal(task.answer !== project.answers.start, changes, task.id);
    }
  });
}

/** The lines of the definition that starts at `first`, found by counting braces
 * outside character and string literals, or inside them too when `naive`.
 */
function definitionLength(lines, first, naive = false) {
  let depth = 0;
  for (let index = first; index < lines.length; index++) {
    const code = naive ? lines[index] : lines[index].replace(/'(?:\\.|[^'])'|"(?:\\.|[^"])*"/g, "");
    for (const character of code) depth += character === "{" ? 1 : character === "}" ? -1 : 0;
    if (depth === 0) return index - first + 1;
  }
  throw new Error("Unbalanced definition");
}

/** Follow one task's instruction literally, as plain text operations. */
function followInstruction(start, task) {
  if (task.kind === "composite") return task.parts.reduce(followInstruction, start);
  if (task.kind === "rename") {
    const pattern = new RegExp(`\\b${task.name}\\b`, "g");
    assert.equal(start.match(pattern).length, task.occurrences, task.id);
    return start.replace(pattern, task.newName);
  }
  if (task.kind === "expression") return start.replace(task.before, task.after);
  if (task.kind === "insert") return start.replace(task.marker, task.text);
  const lines = start.split("\n");
  const first = lines.indexOf(`long long ${task.name ?? task.host}(long long value) {`);
  const length = definitionLength(lines, first);
  if (task.kind === "scoped-replace" || task.kind === "local-rename") {
    let definition = lines.slice(first, first + length).join("\n");
    if (task.kind === "scoped-replace") {
      assert.equal(definition.split(task.before).length, 2, task.id);
      definition = definition.replace(task.before, task.after);
    } else {
      const pattern = new RegExp(`\\b${task.local}\\b`, "g");
      assert.equal(definition.match(pattern).length, task.occurrences, task.id);
      definition = definition.replace(pattern, task.newName);
    }
    lines.splice(first, length, definition);
    return lines.join("\n");
  }
  const moved = lines.splice(first, length);
  assert.equal(lines.splice(first, 1)[0], "", task.id);
  lines.splice(lines.indexOf(task.marker), 1, ...moved);
  return lines.join("\n");
}

test("each instruction, followed literally, gives exactly its task's result", () => {
  for (let seed = 0; seed < 50; seed++) {
    const project = generateChecksumProject(seed, CONFIGS[seed % CONFIGS.length]);
    let all = project.start;
    for (const task of project.tasks) {
      assert.equal(followInstruction(project.start, task), task.result, `${seed}: ${task.id}`);
      assert.match(task.prompt, /^Perform only the following mechanical file edits\./);
      all = followInstruction(all, task);
    }
    assert.equal(all, project.expected, `${seed}: all tasks`);
  }
});

test("a trap and its control share their wording", () => {
  const project = generateChecksumProject(11, { clusters: ALL });
  const shape = (edit) =>
    edit.prompt.replace(/"(?:[^"\\]|\\.)*"/g, "Q").replace(/\d+ (occurrences|lines)/, "N $1");
  for (const cluster of Object.keys(CHECKSUM_CLUSTERS)) {
    const prompts = new Set(
      atoms(project)
        .filter((edit) => edit.cluster === cluster)
        .map(shape),
    );
    assert.equal(prompts.size, 1, cluster);
  }
  // Nothing an agent sees names the variant.
  for (const task of project.tasks) assert.doesNotMatch(task.id + task.prompt, /trap|control/);
});

test("each trap differs from its control in its one factor", () => {
  for (let seed = 0; seed < 20; seed++) {
    const project = generateChecksumProject(seed, { clusters: ALL });
    const { start } = project;
    for (const edit of atoms(project)) {
      const trap = edit.variant === "trap";
      if (edit.cluster === "A")
        assert.equal(start.split(edit.name).length - 1 > edit.occurrences, trap, edit.id);
      if (edit.cluster === "B")
        assert.equal(start.includes(`long long ${edit.name}(long long value);`), trap, edit.id);
      // A C trap scans for a brace character.
      if (edit.cluster === "C")
        assert.equal(/'[{}]'/.test(definitionText(start, edit.name)), trap, edit.id);
      if (edit.cluster === "F")
        assert.equal(start.split(edit.before).length - 1, trap ? 3 : 1, edit.id);
      if (edit.cluster === "G")
        assert.equal(identifierCount(start, edit.local) > edit.occurrences, trap, edit.id);
      if (edit.cluster === "D") {
        assert.equal(edit.lines, 13, edit.id);
        assert.equal(
          /[\\$`%"]/.test(
            edit.text
              .split("\n")
              .slice(2, 7)
              .join("\n")
              .replaceAll(/^ {4}"|",$/gm, ""),
          ),
          trap,
          edit.id,
        );
      }
      if (edit.cluster === "E") {
        const line = start.split("\n").find((text) => text.includes(edit.before));
        assert.equal(line.startsWith("\t") && line.endsWith("  "), trap, edit.id);
      }
    }
    // Tabs, trailing spaces and no-break spaces stand only on E trap lines.
    const special = start.split("\n").filter((line) => /\t| $|\u00a0/.test(line));
    const bytes = atoms(project).filter((edit) => edit.cluster === "E" && edit.variant === "trap");
    assert.equal(special.length, 2 * bytes.length, `${seed}`);
  }
});

test("tasks never edit the same text", () => {
  for (let seed = 0; seed < 50; seed++) {
    const project = generateChecksumProject(seed, CONFIGS[seed % CONFIGS.length]);
    const edits = atoms(project);
    const renamed = edits.filter(({ kind }) => kind === "rename").map(({ name }) => name);
    const changed = edits
      .filter(({ cluster }) => "EF".includes(cluster))
      .map(({ before }) => before);
    for (const edit of edits) {
      let text;
      if (edit.kind === "move" || edit.kind === "local-rename")
        text = definitionText(project.start, edit.name);
      if (edit.kind === "insert") text = edit.text;
      if (!text) continue;
      for (const name of renamed)
        assert.equal(identifierCount(text, name), 0, `${seed}: ${edit.id}`);
      for (const before of changed) assert.ok(!text.includes(before), `${seed}: ${edit.id}`);
    }
  }
});

test("density puts the edits of one zone next to each other", () => {
  for (const options of [
    { density: 1, clusters: ALL },
    { density: 2 },
    { density: 3, clusters: ALL },
    { density: 5 },
    { density: 1, edits: 2 },
    { density: 3, edits: 2 },
  ]) {
    const { density, edits: perTask = 1 } = options;
    // Paragraphs a zone can span: its host and one per moved or inserted function.
    const reach = density * perTask;
    for (let seed = 0; seed < 10; seed++) {
      const project = generateChecksumProject(seed, options);
      const paragraphs = project.start.split("\n\n");
      // Definitions and slots only: the constants paragraph holds every name.
      const where = (find) =>
        paragraphs.flatMap((paragraph, index) =>
          index > 2 && index < paragraphs.length - 1 && find(paragraph) ? [index] : [],
        );
      const zones = Map.groupBy(project.tasks, ({ zone }) => zone);
      // Tasks keep the zone order, so waves hold whole zones.
      assert.deepEqual(
        project.tasks.map(({ zone }) => zone),
        [...zones.keys()].flatMap((zone) => zones.get(zone).map(() => zone)),
      );
      const used = new Set();
      for (const [zone, tasks] of zones) {
        const label = `${JSON.stringify(options)}/${seed}: zone ${zone}`;
        assert.ok(tasks.length <= density, label);
        if (zone < zones.size) assert.equal(tasks.length, density, label);
        const edits = tasks.flatMap((task) => task.parts ?? [task]);
        assert.ok(
          edits.every((edit) => edit.zone === zone),
          label,
        );
        // The host: the one function that holds every A use and E site of the zone.
        let hosts = null;
        const near = [];
        for (const edit of edits) {
          if (["rename", "expression", "scoped-replace"].includes(edit.kind)) {
            const own = where((paragraph) =>
              edit.kind === "rename"
                ? identifierCount(paragraph, edit.name) > 0
                : edit.kind === "expression"
                  ? paragraph.includes(edit.before)
                  : paragraph.startsWith(`long long ${edit.host}(long long value) {`),
            );
            hosts = hosts ? hosts.filter((index) => own.includes(index)) : own;
          } else
            near.push(
              ...where((paragraph) =>
                edit.kind === "insert"
                  ? paragraph === edit.marker
                  : paragraph.startsWith(`long long ${edit.name}(long long value) {`),
              ),
            );
        }
        const host = (hosts ?? []).find((index) =>
          near.every((other) => Math.abs(other - index) <= reach),
        );
        if (hosts) assert.notEqual(host, undefined, label);
        const span = [...near, ...(host === undefined ? [] : [host])];
        assert.ok(Math.max(...span) - Math.min(...span) <= reach, label);
        // No two zones share a paragraph. Only an E or F site pins the host: an A
        // constant is also used in fillers.
        const pinned = edits.some(({ cluster }) => "EF".includes(cluster));
        for (const index of pinned ? span : near) {
          assert.ok(!used.has(index), label);
          used.add(index);
        }
      }
    }
  }
});

test("the shared grade credits finished tasks and names damaged definitions", () => {
  const project = generateChecksumProject(42, { clusters: ALL });
  assert.deepEqual(
    { exact: true, passed: 28, damaged: [], extra: [] },
    (({ exact, passed, damaged, extra }) => ({ exact, passed, damaged, extra }))(
      gradeSharedChecksum(project, project.expected),
    ),
  );
  assert.equal(gradeSharedChecksum(project, project.start).passed, 0);
  let partial = project.start;
  const done = project.tasks.slice(0, 8);
  for (const task of done) partial = followInstruction(partial, task);
  const grade = gradeSharedChecksum(project, partial);
  assert.deepEqual(
    grade.tasks.filter(({ passed }) => passed).map(({ id }) => id),
    done.map(({ id }) => id),
  );
  const find = (cluster, variant) =>
    project.tasks.find((task) => task.cluster === cluster && task.variant === variant);
  const failed = (candidate, task) =>
    !gradeSharedChecksum(project, candidate).tasks.find(({ id }) => id === task.id).passed;

  // A writer that drops a whole definition loses it without touching its neighbours.
  const lost = find("E", "control");
  const header = project.expected
    .split("\n\n")
    .find((block) => block.includes(lost.after))
    .split("\n")[0];
  const broken = project.expected
    .split("\n\n")
    .filter((block) => !block.startsWith(header))
    .join("\n\n");
  assert.deepEqual(gradeSharedChecksum(project, broken).damaged, [header]);
  assert.ok(failed(broken, lost));
  assert.match(sharedPrompt(lost), /^Perform only[^\n]*\n\nSeveral agents are editing main\.cpp/);

  // A rename of the look-alikes too, a normalized trap line and a lost prototype fail.
  const rename = find("A", "trap");
  assert.ok(
    failed(
      project.expected
        .replaceAll(rename.newName, rename.name)
        .replaceAll(rename.name, rename.newName),
      rename,
    ),
  );
  const bytes = find("E", "trap");
  assert.ok(
    failed(
      project.expected.replace(
        `${bytes.context.split("\n")[1]}`,
        `  ${bytes.context.split("\n")[1].trim()}`,
      ),
      bytes,
    ),
  );
  assert.ok(
    failed(project.expected.replace(bytes.context, bytes.context.replace("\u00a0", " ")), bytes),
  );
  const target = find("B", "trap");
  assert.ok(
    failed(project.expected.replace(`long long ${target.name}(long long value);\n`, ""), target),
  );
  // A longer spelling that contains the new name is a different name.
  const control = find("A", "control");
  assert.ok(failed(project.expected.replaceAll(control.newName, control.newName + "r"), control));
  // A replacement of every copy of an F text, or a rename of every "b", fails its trap.
  const scoped = find("F", "trap");
  assert.ok(failed(project.expected.replaceAll(scoped.before, scoped.after), scoped));
  const local = find("G", "trap");
  assert.ok(failed(project.expected.replace(/\bb\b/g, local.newName), local));
  // A C trap moved by counting every brace, even the one in a literal, fails.
  const extent = find("C", "trap");
  const cut = followInstruction(project.start, extent);
  const lines = project.start.split("\n");
  const first = lines.indexOf(`long long ${extent.name}(long long value) {`);
  const naive = definitionLength(lines, first, true);
  const moved = lines.splice(first, naive);
  lines.splice(lines.indexOf(extent.marker), 1, ...moved);
  assert.notEqual(lines.join("\n"), cut);
  assert.ok(failed(lines.join("\n"), extent));
});

test("a composite task passes only when every one of its edits is done", () => {
  const project = generateChecksumProject(5, { edits: 4 });
  const [task] = project.tasks;
  assert.match(task.prompt, /Make all 4 of the following edits:\n1\. In main\.cpp, /);
  const all = project.tasks.reduce(followInstruction, project.start);
  assert.equal(all, project.expected);
  // Undo the last edit of the first task: that task fails, the others pass.
  const partial = project.tasks
    .slice(1)
    .reduce(followInstruction, task.parts.slice(0, 3).reduce(followInstruction, project.start));
  const grade = gradeSharedChecksum(project, partial);
  assert.equal(
    grade.passed,
    project.tasks.length - 1,
    JSON.stringify(grade.tasks.filter(({ passed }) => !passed)),
  );
  assert.deepEqual(grade.tasks.find(({ id }) => id === task.id).failedEdits, [task.parts[3].id]);
});
