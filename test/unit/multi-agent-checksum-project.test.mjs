import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  compareChecksumRuns,
  failureKind,
  gradeSharedChecksum,
  passedAtFinish,
  sharedFailure,
  sharedPrompt,
} from "../../src/suites/explicit-edit-multi-agent/checksum-run.mjs";

const exec = promisify(execFile);
const ALL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
// Files beside main.cpp are byte strings; an X trap's starts with this mark.
const BOM = "\xef\xbb\xbf";
const CONFIGS = [
  {},
  { clusters: ALL },
  { density: 2 },
  { density: 3, clusters: ALL },
  { density: 5 },
  { edits: 4 },
  { density: 3, edits: 2 },
  { clusters: ALL, compact: true },
  { density: 3, clusters: ALL, compact: true },
];
const atoms = (project) => project.tasks.flatMap((task) => task.parts ?? [task]);

/** Build one main.cpp and the files it includes with warnings as errors and return
 * what it prints.
 */
async function output(root, name, source, signal, files = {}) {
  const directory = path.join(root, name);
  await mkdir(directory);
  const file = path.join(directory, "main.cpp"),
    binary = path.join(directory, "program");
  await writeFile(file, source);
  for (const [included, text] of Object.entries(files))
    await writeFile(path.join(directory, included), text, "latin1");
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
  { seed: 6, options: { clusters: "FKLM", lines: 3000 } },
  { seed: 7, options: { clusters: ALL, perVariant: 3, compact: true } },
]) {
  test(`checksum project ${seed} ${JSON.stringify(options)}: every state builds and prints its answer`, async (t) => {
    const project = generateChecksumProject(seed, options);
    const size = { ...CHECKSUM_PROJECT_DEFAULTS, ...options };
    const root = await mkdtemp(path.join(os.tmpdir(), "checksum-project-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const edits = atoms(project);
    // A J trap or control is a pair of edits, an L one a group of three.
    const per = (cluster) => (({ J: 2, L: 3 })[cluster] ?? 1) * size.perVariant;
    const clusters = size.clusters.split("");
    assert.equal(edits.length, 2 * clusters.reduce((sum, cluster) => sum + per(cluster), 0));
    assert.equal(project.tasks.length * size.edits, edits.length);
    for (const [cluster, summary] of Object.entries(clusterSummary(edits)))
      assert.deepEqual(summary, {
        trap: { passed: 0, total: per(cluster) },
        control: { passed: 0, total: per(cluster) },
      });
    assert.notEqual(project.answers.expected, project.answers.start);
    assert.doesNotMatch(project.expected, /__EXPLICIT_EDIT_SLOT_/);
    const lines = project.start.split("\n").length;
    // Generated code stays near 20 lines per edit, so a run's file stays readable,
    // unless the size option asks for more.
    // A compact file keeps only the fillers that something needs.
    if (size.compact) {
      const loose = generateChecksumProject(seed, { ...options, compact: false });
      assert.ok(lines < 0.7 * loose.start.split("\n").length, `${lines} lines`);
    } else if (size.lines === 0)
      assert.ok(lines > 15 * edits.length && lines < 40 * edits.length, `${lines} lines`);
    else assert.ok(lines >= size.lines && lines < 1.2 * size.lines + 40 * edits.length);
    const states = [
      {
        id: "start",
        source: project.start,
        files: project.startFiles,
        answer: project.answers.start,
      },
      {
        id: "expected",
        source: project.expected,
        files: project.expectedFiles,
        answer: project.answers.expected,
      },
      ...project.tasks.map((task) => ({
        id: task.id,
        source: task.result,
        files: task.resultFiles,
        answer: task.answer,
      })),
    ];
    const printed = await Promise.all(
      states.map((state) => output(root, state.id, state.source, t.signal, state.files)),
    );
    states.forEach((state, index) => assert.equal(printed[index], `${state.answer}\n`, state.id));
    for (const task of project.tasks) {
      // Only a changed factor alters the answer, and one always does.
      const changes = (task.parts ?? [task]).some(
        ({ statement, shifts }) => statement !== undefined || shifts !== undefined,
      );
      assert.equal(task.answer !== project.answers.start, changes, task.id);
    }
  });
}

test("the size option reaches a file of 50,000 lines that builds", async (t) => {
  const project = generateChecksumProject(8, { clusters: "BNO", lines: 50000 });
  const lines = project.start.split("\n").length;
  assert.ok(lines >= 50000 && lines < 60000, `${lines} lines`);
  const headers = project.start.split("\n").filter((line) => line.startsWith("long long "));
  assert.equal(new Set(headers).size, headers.length);
  const root = await mkdtemp(path.join(os.tmpdir(), "checksum-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await output(root, "start", project.start, t.signal), `${project.answers.start}\n`);
});

/** The lines of the definition that starts at `first`, found by counting braces
 * outside character, string and raw string literals, or inside them too when `naive`.
 */
function definitionLength(lines, first, naive = false) {
  let depth = 0;
  let raw = false;
  for (let index = first; index < lines.length; index++) {
    let code = lines[index];
    if (!naive) {
      // A raw string literal that opens on one line and closes on a later one.
      if (raw) {
        const close = code.indexOf(')"');
        if (close < 0) continue;
        code = code.slice(close + 2);
        raw = false;
      }
      const open = code.indexOf('R"(');
      if (open >= 0 && !code.includes(')"', open)) {
        code = code.slice(0, open);
        raw = true;
      }
      code = code.replace(/'(?:\\.|[^'])'|"(?:\\.|[^"])*"/g, "");
    }
    for (const character of code) depth += character === "{" ? 1 : character === "}" ? -1 : 0;
    if (depth === 0) return index - first + 1;
  }
  throw new Error("Unbalanced definition");
}

/** The name of the function that a P, Q, R or S instruction describes, found from
 * the instruction's facts alone, or undefined for other instructions.
 */
function locate(lines, task) {
  // Every definition with its name and its lines.
  const definitions = () =>
    lines.flatMap((line, first) => {
      const name = /^long long (\w+)\(long long value\) \{$/.exec(line)?.[1];
      return name
        ? [{ name, body: lines.slice(first, first + definitionLength(lines, first)) }]
        : [];
    });
  // Code without comments and string literals.
  const code = (line) =>
    line.trimStart().startsWith("//") ? "" : line.replace(/"(?:\\.|[^"])*"/g, '""');
  const only = (found) => {
    assert.equal(found.length, 1, task.id);
    return found[0].name;
  };
  if (task.cluster === "P") {
    const main = lines.slice(lines.indexOf("int main() {"));
    const calls = main.filter((line) => line.includes(`(${task.argument}))`));
    assert.equal(calls.length, 1, task.id);
    return /\* (\w+)\(/.exec(calls[0])[1];
  }
  if (task.cluster === "Q")
    return only(
      definitions().filter(({ body }) =>
        body.slice(1).some((line) => code(line).includes(`${task.callee}(`)),
      ),
    );
  if (task.cluster === "S")
    return only(
      definitions().filter(({ body }) =>
        body.some((line) => new RegExp(`\\b${task.constant}\\b`).test(code(line))),
      ),
    );
  if (task.cluster === "R") {
    const first = lines.indexOf(`long long ${task.anchor}(long long value) {`);
    const end = first + definitionLength(lines, first);
    assert.equal(lines[end], "", task.id);
    return /^long long (\w+)\(/.exec(lines[end + 1])[1];
  }
  return undefined;
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
  // An edit of a file beside main.cpp changes that file only; see followFiles.
  if (task.kind === "file-delete" || task.kind === "file-insert") return start;
  if (task.kind === "literal-replace") {
    // A naive follower types the text in composed form and takes its one match.
    const typed = task.before.normalize("NFC");
    if (task.naive && start.split(typed).length === 2) return start.replace(typed, task.after);
    assert.equal(start.split(task.before).length, 2, task.id);
    return start.replace(task.before, task.after);
  }
  // Code without comment lines and string literals; a naive follower reads them as
  // code too.
  const code = (line) =>
    task.naive || !line.trimStart().startsWith("//")
      ? line.split(task.naive ? /(?!)/ : /("(?:\\.|[^"\\])*")/)
      : ["", line];
  if (task.kind === "function-rename") {
    const pattern = new RegExp(`\\b${task.name}\\b`, "g");
    return start
      .split("\n")
      .map((line) =>
        code(line)
          .map((part, index) => (index % 2 ? part : part.replace(pattern, task.newName)))
          .join(""),
      )
      .join("\n");
  }
  const lines = start.split("\n");
  if (task.kind === "factor-shift") {
    // Each number that multiplies a variable, on either side; a naive follower only
    // looks for a variable times a number.
    const first = lines.indexOf(`long long ${task.host}(long long value) {`);
    const shift = (number) => Number(number) + 1000;
    for (let at = first; at < first + definitionLength(lines, first); at++) {
      lines[at] = lines[at].replace(
        /\b([a-z]\w*) \* (\d+)\b/g,
        (_, name, number) => `${name} * ${shift(number)}`,
      );
      if (!task.naive)
        lines[at] = lines[at].replace(
          /\b(\d+) \* ([a-z]\w*)\b/g,
          (_, number, name) => `${shift(number)} * ${name}`,
        );
    }
    return lines.join("\n");
  }
  if (task.kind === "reorder") {
    // The namespace's definitions sorted by name, one empty line apart.
    const open = lines.indexOf(`namespace ${task.namespace} {`);
    const close = lines.indexOf(`}  // namespace ${task.namespace}`, open);
    const definitions = [];
    for (let first = open + 1; first < close; first++) {
      const name = /^long long (\w+)\(long long value\) \{$/.exec(lines[first])?.[1];
      if (!name) continue;
      const length = definitionLength(lines, first);
      definitions.push({ name, text: lines.slice(first, first + length).join("\n") });
      first += length - 1;
    }
    assert.equal(lines[open + 1], "", task.id);
    assert.equal(lines[close - 1], "", task.id);
    definitions.sort((one, other) => (one.name < other.name ? -1 : 1));
    return [
      ...lines.slice(0, open + 2),
      definitions.map(({ text }) => text).join("\n\n"),
      ...lines.slice(close - 1),
    ].join("\n");
  }
  if (task.kind === "prune") {
    // Every definition of the namespace that no code outside it calls.
    const open = lines.indexOf(`namespace ${task.namespace} {`);
    const close = lines.indexOf(`}  // namespace ${task.namespace}`, open);
    const unused = [];
    for (let first = open; first < close; first++) {
      const name = /^long long (\w+)\(long long value\) \{$/.exec(lines[first])?.[1];
      if (!name) continue;
      const length = definitionLength(lines, first);
      // Inside the namespace a call can leave out the namespace; a naive follower
      // only searches for the qualified name.
      const own = new RegExp(`(^|[^:\\w])${name}\\(`);
      const called = lines.some(
        (line, at) =>
          (at < first || at >= first + length) &&
          code(line)
            .filter((_, index) => index % 2 === 0)
            .some(
              (part) =>
                part.includes(`${task.namespace}::${name}(`) ||
                (!task.naive && at > open && at < close && own.test(part)),
            ),
      );
      if (!called) unused.push({ first, length });
    }
    assert.ok(unused.length > 0, task.id);
    for (const { first, length } of unused.reverse()) {
      assert.equal(lines[first + length], "", task.id);
      lines.splice(first, length + 1);
    }
    return lines.join("\n");
  }
  if (task.kind === "bulk-delete") {
    const kept = lines.filter((line) => !line.trimStart().startsWith(`${task.name}(`));
    assert.equal(lines.length - kept.length, task.occurrences, task.id);
    return kept.join("\n");
  }
  const header = `long long ${locate(lines, task) ?? task.name ?? task.host}(long long value) {`;
  // A K definition is the first one after the opening line of its namespace.
  const from =
    task.kind === "namespace-delete" ? lines.indexOf(`namespace ${task.namespace} {`) : 0;
  const first = lines.indexOf(header, from);
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
  // An L deletion starts at the comment lines right above the definition.
  let top = first;
  if (task.kind === "commented-delete") while (lines[top - 1].startsWith("//")) top--;
  const moved = lines.splice(top, first - top + length);
  assert.equal(lines.splice(top, 1)[0], "", task.id);
  if (task.kind === "move") lines.splice(lines.indexOf(task.marker), 1, ...moved);
  return lines.join("\n");
}

/** Follow one task's instructions for the files beside main.cpp, byte for byte, or
 * in text mode, which writes every line ending as LF. A naive follower writes a
 * recipe's tab as spaces, and reads a file as UTF-8, replacing what it cannot
 * decode, and ends every line it writes with a newline.
 */
function followFiles(files, task, textMode = false) {
  const result = { ...files };
  for (const edit of task.parts ?? [task]) {
    const text = result[edit.file];
    if (edit.kind === "file-insert") {
      assert.equal(text.split(edit.marker).length, 2, edit.id);
      const supplied = edit.naive ? edit.text.replaceAll("\t", "        ") : edit.text;
      result[edit.file] = text.replace(edit.marker, supplied);
    }
    if (edit.kind === "file-delete") {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      // A byte order mark belongs to the file, not to its first line.
      const mark = text.startsWith(BOM) ? BOM : "";
      const lines = text.slice(mark.length).split(eol);
      const first = lines.indexOf(`long long ${edit.name}(long long value) {`);
      const length = definitionLength(lines, first);
      assert.equal(lines[first + length], "", edit.id);
      lines.splice(first, length + 1);
      let written = mark + lines.join(textMode ? "\n" : eol);
      if (edit.naive) {
        written = Buffer.from(Buffer.from(written, "latin1").toString("utf8")).toString("latin1");
        if (!written.endsWith("\n")) written += "\n";
      }
      result[edit.file] = written;
    }
  }
  return result;
}

test("each instruction, followed literally, gives exactly its task's result", () => {
  for (let seed = 0; seed < 50; seed++) {
    const project = generateChecksumProject(seed, CONFIGS[seed % CONFIGS.length]);
    let all = project.start;
    let files = project.startFiles;
    for (const task of project.tasks) {
      const label = `${seed}: ${task.id}`;
      assert.equal(followInstruction(project.start, task), task.result, label);
      assert.deepEqual(followFiles(project.startFiles, task), task.resultFiles, label);
      assert.match(task.prompt, /^Perform only the following mechanical file edits\./);
      all = followInstruction(all, task);
      files = followFiles(files, task);
    }
    assert.equal(all, project.expected, `${seed}: all tasks`);
    assert.deepEqual(files, project.expectedFiles, `${seed}: all files`);
  }
});

test("a d rule runs under make, and spaces for a trap's tabs break the makefile", async (t) => {
  const project = generateChecksumProject(9, { clusters: "d", perVariant: 2 });
  const root = await mkdtemp(path.join(os.tmpdir(), "checksum-make-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const task of project.tasks) {
    const spaced = followFiles(project.startFiles, { ...task, naive: true });
    for (const [label, files, works] of [
      ["reference", task.resultFiles, true],
      ["spaces", spaced, task.variant === "control"],
    ]) {
      const directory = path.join(root, `${task.id}-${label}`);
      await mkdir(directory);
      await writeFile(path.join(directory, task.file), files[task.file], "latin1");
      // The rule's prerequisite, so make only prints the recipe.
      await writeFile(path.join(directory, task.target), "");
      const run = exec("make", ["-n", "-f", task.file, "check"], { cwd: directory });
      if (works)
        assert.equal(
          (await run).stdout,
          `./${task.target} --self-test\ntouch ${task.target}.checked\n`,
          `${task.id} ${label}`,
        );
      else await assert.rejects(run, /missing separator/, `${task.id} ${label}`);
    }
  }
});

test("a project of every cluster with many edits takes three-word names", () => {
  const project = generateChecksumProject(3, { clusters: ALL, perVariant: 4 });
  assert.match(project.start, /^long long [a-z]+_[a-z]+_[a-z]+\(long long value\) \{$/m);
  let all = project.start;
  for (const task of project.tasks) {
    assert.equal(followInstruction(project.start, task), task.result, task.id);
    all = followInstruction(all, task);
  }
  assert.equal(all, project.expected);
});

test("a trap and its control share their wording", () => {
  const project = generateChecksumProject(11, { clusters: ALL });
  const shape = (edit) =>
    edit.prompt
      .replace(/"(?:[^"\\]|\\.)*"/g, "Q")
      .replace(/\d+ (occurrences|lines)/, "N $1")
      .replace(/argument \d+/, "argument N")
      .replace(/In \w+\.(inc|mk),/, "In F,");
  for (const cluster of Object.keys(CHECKSUM_CLUSTERS)) {
    const prompts = new Set(
      atoms(project)
        .filter((edit) => edit.cluster === cluster)
        .map(shape),
    );
    // A J pair has two instructions, the move and the expression edit, and an L
    // group two, the deletion and the inserts.
    assert.equal(prompts.size, "JL".includes(cluster) ? 2 : 1, cluster);
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
      if ("BHI".includes(edit.cluster))
        assert.equal(
          start.includes(`long long ${edit.name ?? edit.host}(long long value);`),
          trap,
          edit.id,
        );
      // The first brace after a B, H or I trap's prototype opens the lead, so a
      // blind search from the prototype takes a whole definition for the target.
      if ("BHI".includes(edit.cluster) && trap) {
        const prototype = start.indexOf(`long long ${edit.name ?? edit.host}(long long value);`);
        const lead = start.split("\n\n")[3];
        assert.equal(start.indexOf("{", prototype), start.indexOf(lead) + lead.indexOf("{"));
      }
      // The first definition after the prototypes repeats every I expression.
      if (edit.cluster === "I") {
        const lead = start.split("\n\n")[3];
        assert.ok(lead.includes(edit.before) && !lead.startsWith(`long long ${edit.host}(`));
      }
      // A J trap's expression is inside the function its partner moves; a control's
      // is in the function right next to it.
      if (edit.cluster === "J" && edit.kind === "expression") {
        const blocks = start.split("\n\n");
        const at = (name) => blocks.findIndex((block) => block.startsWith(`long long ${name}(`));
        const distance = Math.abs(at(edit.host) - at(edit.partner.name));
        assert.equal(distance, trap ? 0 : 1, edit.id);
      }
      // A K trap's signature also stands in the namespace before its own.
      if (edit.cluster === "K") {
        const own = start.indexOf(`namespace ${edit.namespace} {`);
        const other = start.indexOf(`namespace ${edit.decoy} {`);
        assert.ok(other < own, edit.id);
        assert.equal(start.slice(other, own).includes(`long long ${edit.name}(`), trap, edit.id);
      }
      // L neighbours' slots stand right above a trap's function and right below a
      // control's.
      if (edit.cluster === "L" && edit.kind === "insert") {
        const blocks = start.split("\n\n");
        const own = blocks.findIndex((block) => block.includes(`long long ${edit.partner.name}(`));
        const slot = blocks.indexOf(edit.marker);
        assert.ok(trap ? [own - 1, own - 2].includes(slot) : [own + 1, own + 2].includes(slot));
      }
      if (edit.cluster === "M") assert.equal(edit.occurrences, trap ? 32 : 3, edit.id);
      // An N trap's commented-out copy has its signature; an O trap's literal holds a
      // lone closing brace.
      if (edit.cluster === "N")
        assert.equal(edit.copy.includes(`// long long ${edit.name}(`), trap, edit.id);
      if (edit.cluster === "O") assert.equal(edit.full.includes('R"(\n}\n\n)"'), trap, edit.id);
      // A P, Q or S trap's decoy, above the target, holds the property's text where it
      // is not the property; an R trap's anchor has a prototype.
      if ("PQS".includes(edit.cluster)) {
        const decoy = definitionText(start, edit.decoy);
        assert.ok(start.indexOf(decoy) < start.indexOf(definitionText(start, edit.host)));
        const text =
          edit.cluster === "P"
            ? `(${edit.argument})`
            : edit.cluster === "Q"
              ? `// long long c = (${edit.callee}(`
              : `"${edit.constant} is tuned"`;
        assert.equal(decoy.includes(text), trap, edit.id);
      }
      if (edit.cluster === "R")
        assert.equal(start.includes(`long long ${edit.anchor}(long long value);`), trap, edit.id);
      // A T trap's comment and literal name the function; a U trap's commented-out
      // call names a function to delete.
      if (edit.cluster === "T")
        assert.ok(edit.mentions.every((line) => identifierCount(line, edit.name) === +trap));
      if (edit.cluster === "U")
        assert.equal(edit.mention.includes(`${edit.removed[0]}(`), trap, edit.id);
      // A V trap's entry calls its helper without the namespace.
      if (edit.cluster === "V") assert.equal(!start.includes(`${edit.helper}(`), trap, edit.id);
      // A W trap's file ends its lines with CRLF; an X trap's starts with a byte
      // order mark.
      const own = project.startFiles[edit.file];
      if (edit.cluster === "W") assert.equal(own.includes("\r\n"), trap, edit.id);
      if (edit.cluster === "X") assert.equal(own.startsWith(BOM), trap, edit.id);
      // A Y trap's file has no final newline, an a trap's holds a Latin-1 byte and a
      // d trap's recipes start with a tab.
      if (edit.cluster === "Y") assert.equal(own.endsWith("\n"), !trap, edit.id);
      if (edit.cluster === "a") assert.equal(own.includes("\xb0"), trap, edit.id);
      if (edit.cluster === "d") assert.equal(own.includes("\t"), trap, edit.id);
      // A Z trap writes one factor before its variable; a b trap's decoy holds the
      // composed form of the target's text; a c trap reorders twelve functions.
      if (edit.cluster === "Z")
        assert.equal(/= \(\d+ \* /.test(definitionText(start, edit.host)), trap, edit.id);
      if (edit.cluster === "b")
        assert.equal(edit.decoyText === edit.before.normalize("NFC"), trap, edit.id);
      if (edit.cluster === "c") assert.equal(edit.members.length, trap ? 12 : 3, edit.id);
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
    const renamed = edits
      .filter(({ kind }) => kind === "rename" || kind === "function-rename")
      .map(({ name }) => name);
    const changed = edits
      .filter(({ statement }) => statement !== undefined)
      .map(({ before }) => before);
    for (const edit of edits) {
      let text;
      // A J trap moves a function whose expression its partner changes, on purpose.
      if (
        ["move", "local-rename", "delete", "commented-delete"].includes(edit.kind) &&
        edit.cluster !== "J"
      )
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
    const zoneReach = density * perTask;
    for (let seed = 0; seed < 10; seed++) {
      const project = generateChecksumProject(seed, options);
      const paragraphs = project.start.split("\n\n");
      // Definitions and slots only: the constants paragraph holds every name.
      const where = (find) =>
        paragraphs.flatMap((paragraph, index) =>
          index > 2 && index < paragraphs.length - 1 && find(paragraph) ? [index] : [],
        );
      const zones = Map.groupBy(project.tasks, ({ zone }) => zone);
      // Tasks keep the zone order, so a zone's tasks stand together in the queue.
      assert.deepEqual(
        project.tasks.map(({ zone }) => zone),
        [...zones.keys()].flatMap((zone) => zones.get(zone).map(() => zone)),
      );
      const used = new Set();
      for (const [zone, tasks] of zones) {
        const label = `${JSON.stringify(options)}/${seed}: zone ${zone}`;
        assert.ok(tasks.length <= density, label);
        if (zone < zones.size) assert.equal(tasks.length, density, label);
        const all = tasks.flatMap((task) => task.parts ?? [task]);
        assert.ok(
          all.every((edit) => edit.zone === zone),
          label,
        );
        // J, K, L, N and P to c edits stand in gaps of their own, M edits everywhere,
        // and d edits in files of their own.
        const edits = all.filter(({ cluster }) => !"JKLMNPQRSTUVWXYZabcd".includes(cluster));
        if (edits.length === 0) continue;
        // An O definition holds an empty line, so it spans two paragraphs.
        const reach = zoneReach + edits.filter(({ cluster }) => cluster === "O").length;
        // The host: the one function that holds every A use and E site of the zone.
        let hosts = null;
        const near = [];
        for (const edit of edits) {
          if ("AEF".includes(edit.cluster)) {
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
                  : paragraph.startsWith(`long long ${edit.name ?? edit.host}(long long value) {`),
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
    { exact: true, passed: project.tasks.length, damaged: [], extra: [] },
    (({ exact, passed, damaged, extra }) => ({ exact, passed, damaged, extra }))(
      gradeSharedChecksum(project, project.expected, project.expectedFiles),
    ),
  );
  assert.equal(gradeSharedChecksum(project, project.start, project.startFiles).passed, 0);
  let partial = project.start;
  let partialFiles = project.startFiles;
  const done = project.tasks.slice(0, 8);
  for (const task of done) {
    partial = followInstruction(partial, task);
    partialFiles = followFiles(partialFiles, task);
  }
  const grade = gradeSharedChecksum(project, partial, partialFiles);
  assert.deepEqual(
    grade.tasks.filter(({ passed }) => passed).map(({ id }) => id),
    done.map(({ id }) => id),
  );
  const find = (cluster, variant) =>
    project.tasks.find((task) => task.cluster === cluster && task.variant === variant);
  const failed = (candidate, task, files = project.expectedFiles) =>
    !gradeSharedChecksum(project, candidate, files).tasks.find(({ id }) => id === task.id).passed;
  // A W deletion written back in text mode loses the file's CRLF line endings, and
  // an X deletion that takes the byte order mark with the first line drops it: both
  // fail their traps. The same writers pass the controls.
  for (const variant of ["trap", "control"]) {
    const lines = find("W", variant);
    const text = followFiles(project.startFiles, lines, true);
    assert.equal(failed(project.start, lines, text), variant === "trap");
    const mark = find("X", variant);
    const stripped = followFiles(project.startFiles, mark);
    stripped[mark.file] = stripped[mark.file].replace(BOM, "");
    assert.equal(failed(project.start, mark, stripped), variant === "trap");
    // A naive writer adds a final newline to a Y file, replaces an a file's Latin-1
    // byte and writes a d recipe's tab as spaces: each fails its trap only.
    for (const cluster of "Yad") {
      const task = find(cluster, variant);
      const naive = followFiles(project.startFiles, { ...task, naive: true });
      assert.equal(failed(project.start, task, naive), variant === "trap", task.id);
    }
  }

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
  // An H or I trap that takes the lead function for its target fails and harms the
  // lead, which no edit was meant to change.
  const paragraphs = project.start.split("\n\n");
  const lead = paragraphs[3];
  const deletion = find("H", "trap");
  const wrong = paragraphs.filter((block) => block !== lead).join("\n\n");
  assert.ok(failed(wrong, deletion));
  assert.deepEqual(gradeSharedChecksum(project, wrong).collateral, [lead.split("\n")[0]]);
  // A J trap's move written from a copy read before its partner's edit loses that
  // edit. The final file cannot tell a stale move from a partner that never edited,
  // so the partner fails and the move, finished either way, passes.
  const inner = project.tasks.find(
    (task) => task.cluster === "J" && task.variant === "trap" && task.kind === "expression",
  );
  const stale = project.expected.replace(inner.after, inner.before);
  assert.ok(failed(stale, inner));
  assert.ok(!failed(stale, inner.partner));
  // Any other change to the moved function fails the move.
  const mover = definitionText(project.expected, inner.partner.name);
  const edited = mover.replace("  return (", "  return  (");
  assert.ok(failed(project.expected.replace(mover, edited), inner.partner));
  const inPlace = find("I", "trap");
  assert.ok(
    failed(
      project.expected
        .replace(inPlace.after, inPlace.before)
        .replace(inPlace.before, inPlace.after),
      inPlace,
    ),
  );
  // A K trap that deletes the first definition with its signature, in the other
  // namespace, fails and harms that namespace.
  const spaced = find("K", "trap");
  const decoy = { ...spaced, namespace: spaced.decoy };
  assert.ok(failed(followInstruction(project.start, decoy), spaced));
  const both = followInstruction(project.expected, decoy);
  assert.ok(failed(both, spaced));
  assert.deepEqual(gradeSharedChecksum(project, both).collateral, [
    `long long ${spaced.name}(long long value) {`,
  ]);
  // An L deletion that leaves the comment lines fails.
  const commented = project.tasks.find((task) => task.kind === "commented-delete");
  assert.ok(failed(followInstruction(project.start, { ...commented, kind: "delete" }), commented));
  // A blind script that takes the first match of the signature and counts braces
  // from there, as Terra's Bash agents do, deletes an N trap's commented-out copy and
  // cuts an O trap's definition inside its literal; both fail.
  const blind = (text, task) => {
    const at = text.indexOf(`long long ${task.name}(long long value)`);
    const start = text.lastIndexOf("\n", at) + 1;
    let depth = 0;
    let end = text.indexOf("{", at);
    for (; ; end++) {
      depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0;
      if (depth === 0) break;
    }
    assert.equal(text.slice(end + 1, end + 3), "\n\n");
    const cut = text.slice(start, end + 1);
    const rest = text.slice(0, start) + text.slice(end + 3);
    return task.kind === "move" ? rest.replace(task.marker, cut) : rest;
  };
  const copied = find("N", "trap");
  const uncommented = blind(project.start, copied);
  assert.ok(!uncommented.includes(copied.copy.split("\n")[1]));
  assert.ok(failed(uncommented, copied));
  const raw = find("O", "trap");
  const halfway = blind(project.start, raw);
  assert.ok(halfway.includes(`}\n\n)";`) && failed(halfway, raw));
  // Why a result failed follows from the start, the reference and the result: the
  // blind script touched text that its task keeps; a file written in text mode and
  // supplied text with a lost escape got only their own text wrong; and an agent that
  // did nothing left everything as at the start.
  const reference = (task) => ({
    start: project.start,
    result: task.result,
    startFiles: project.startFiles,
    resultFiles: task.resultFiles,
  });
  const kind = (task, candidate, files = project.startFiles) =>
    failureKind(reference(task), candidate, files);
  for (const task of [copied, raw, find("B", "trap"), find("H", "trap")])
    assert.equal(kind(task, blind(project.start, task)), "touched-other-text", task.id);
  const crlf = find("W", "trap");
  assert.equal(
    kind(crlf, project.start, followFiles(project.startFiles, crlf, true)),
    "wrong-own-text",
  );
  const escaped = find("D", "trap");
  const unescaped = escaped.result.replace(String.raw`\\`, "\\");
  assert.notEqual(unescaped, escaped.result);
  assert.equal(kind(escaped, unescaped), "wrong-own-text");
  assert.equal(kind(escaped, project.start), "not-done");
  assert.equal(kind(escaped, escaped.result, escaped.resultFiles), undefined);
  // The same scripts handle the controls.
  for (const control of [find("N", "control"), find("O", "control")])
    assert.equal(blind(project.start, control), control.result);
  // A replacement of the first copy of a P, Q, R or S text edits the decoy or the
  // lead, in traps and controls alike: only the property tells the functions apart.
  for (const cluster of "PQRS")
    for (const variant of ["trap", "control"]) {
      const task = find(cluster, variant);
      assert.ok(failed(project.start.replace(task.before, task.after), task), task.id);
    }
  // A rename of every occurrence of a T name, a deletion of the U and V functions
  // whose qualified name nothing mentions, a Z pattern for a variable times a number
  // and a b text typed in composed form fail their traps and pass their controls.
  for (const cluster of "TUVZb")
    for (const variant of ["trap", "control"]) {
      const task = find(cluster, variant);
      const naive = followInstruction(project.start, { ...task, naive: true });
      assert.equal(failed(naive, task), variant === "trap", task.id);
    }
  // Damage that another agent did does not fail an edit: a T rename whose prototype
  // went with a neighbour's cut, an A rename that lost a use in a destroyed paragraph
  // and an insert glued to the paragraph above it still pass.
  const renamed = find("T", "control");
  const unprototyped = project.expected.replace(
    `long long ${renamed.newName}(long long value);\n`,
    "",
  );
  assert.ok(unprototyped !== project.expected && !failed(unprototyped, renamed));
  const spread = find("A", "trap");
  const user = project.expected
    .split("\n\n")
    .find((block) => block.startsWith("long long ") && identifierCount(block, spread.newName) > 0);
  assert.ok(!failed(project.expected.replace(`${user}\n\n`, ""), spread));
  const supplied = find("D", "control");
  const glued = project.expected.replace(`\n\n${supplied.text}`, `\n${supplied.text}`);
  assert.ok(glued !== project.expected && !failed(glued, supplied));
  // On the file as its agent left it, a move or an insert needs only its own text:
  // the neighbours around it may still be in other agents' hands.
  const supplier = project.tasks.find((task) => task.kind === "insert" && task.cluster === "D");
  const inserted = followInstruction(project.start, supplier);
  const lonely = inserted
    .split("\n\n")
    .filter(
      (block, index, all) => all[index + 1] !== supplier.text && all[index - 1] !== supplier.text,
    )
    .join("\n\n");
  assert.ok(failed(lonely, supplier));
  assert.ok(passedAtFinish(project, supplier, { main: lonely, files: project.startFiles }));
  assert.ok(!passedAtFinish(project, supplier, { main: project.start, files: project.startFiles }));
  // An M edit that deletes the definition too fails.
  const bulk = find("M", "trap");
  assert.ok(failed(project.expected.replace(`${bulk.definition}\n`, ""), bulk));
});

test("an observation's two scores grade the same edits alone and in the crowd", () => {
  const identity = {
    project: "p",
    seed: 1,
    harness: "h",
    model: "m",
    thinking: null,
    counts: {},
    agents: 25,
  };
  const row = (id, cluster, variant, passed, failure) => ({
    id,
    edits: [{ id, cluster, variant, passed }],
    failure,
  });
  const isolated = {
    identity,
    tasks: [
      row("edit-01", "B", "trap", false, "touched-other-text"),
      row("edit-02", "T", "control", true),
      row("edit-03", "I", "trap", false, "touched-other-text"),
    ],
  };
  // The B trap fails in both runs, the T control only in the crowd and the I trap
  // only alone.
  const shared = {
    identity,
    built: false,
    answer: "1",
    expectedAnswer: "2",
    damaged: ["x"],
    collateral: ["x"],
    // The T control passed when its agent finished and was lost to a later write.
    tasks: [
      { id: "edit-01", failedEdits: ["edit-01"], passedAtFinish: false },
      { id: "edit-02", failedEdits: ["edit-02"], passedAtFinish: true },
      { id: "edit-03", failedEdits: [], passedAtFinish: true },
    ],
  };
  const score = compareChecksumRuns(isolated, shared);
  assert.deepEqual(score.isolated, {
    passed: 1,
    total: 3,
    traps: { passed: 0, total: 2 },
    controls: { passed: 1, total: 1 },
  });
  assert.deepEqual(score.shared, {
    passed: 1,
    total: 3,
    traps: { passed: 1, total: 2 },
    controls: { passed: 0, total: 1 },
    built: false,
    answer: false,
    damaged: 1,
    collateral: 1,
    agents: 25,
    providerFailures: 0,
  });
  assert.equal(score.isolatedProviderFailures, 0);
  // One edit of three is right alone, and it is lost in the crowd; the I trap that
  // passes only in the crowd earns nothing.
  assert.deepEqual(score.score.all, {
    precision: { passed: 1, total: 3 },
    resilience: { passed: 0, total: 1 },
    overall: { passed: 0, total: 3 },
  });
  assert.deepEqual(score.score.traps.overall, { passed: 0, total: 2 });
  assert.deepEqual(score.score.controls.precision, { passed: 1, total: 1 });
  assert.deepEqual(score.byCluster.T, {
    isolated: { trap: { passed: 0, total: 0 }, control: { passed: 1, total: 1 } },
    shared: { trap: { passed: 0, total: 0 }, control: { passed: 0, total: 1 } },
  });
  assert.deepEqual(score.failures, {
    isolated: { "touched-other-text": 2 },
    shared: { "failed-at-finish": 1, "lost-later": 1 },
  });
  assert.deepEqual(score.lostInCrowd, [
    { id: "edit-02", cluster: "T", variant: "control", kind: "lost-later" },
  ]);
  assert.deepEqual(score.gainedInCrowd, [
    { id: "edit-03", cluster: "I", variant: "trap", kind: "touched-other-text" },
  ]);
  // A crowd failure names whose doing it was: the edit passed after its own agent's
  // tool call, when that agent finished, or never.
  assert.deepEqual(
    [
      { passedAtFinish: true, passedAfterOwnWrite: true },
      { passedAtFinish: false, passedAfterOwnWrite: true },
      { passedAtFinish: false, passedAfterOwnWrite: false },
      { passedAtFinish: false },
      { status: "timed-out", passedAtFinish: true },
      {},
    ].map((row) => sharedFailure(row)),
    ["lost-later", "lost-before-finish", "own-mistake", "failed-at-finish", "timed-out", "unknown"],
  );
  // Runs of another model are not one observation.
  const other = { ...shared, identity: { ...identity, model: "other" } };
  assert.throws(() => compareChecksumRuns(isolated, other), /model/);
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
