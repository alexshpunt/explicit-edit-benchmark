import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chunkModelDrivers } from "./execution/chunk-model-drivers.mjs";
import { runAgentQueue } from "./execution/fresh-agent-queue.mjs";
import { restoringSourceIdentity } from "./execution/restoring-identity.mjs";
import { startSharedSandbox } from "./execution/shared-sandbox.mjs";
import {
  CHECKSUM_CLUSTERS,
  CHECKSUM_PROJECT_VERSION,
  definitionText,
  generateChecksumProject,
  identifierCount,
} from "./generation/checksum-project.mjs";

/** Passed edits per cluster, traps and controls side by side. */
export function clusterSummary(edits) {
  return Object.fromEntries(
    Object.keys(CHECKSUM_CLUSTERS)
      .filter((cluster) => edits.some((edit) => edit.cluster === cluster))
      .map((cluster) => [
        cluster,
        Object.fromEntries(
          ["trap", "control"].map((variant) => {
            const own = edits.filter(
              (edit) => edit.cluster === cluster && edit.variant === variant,
            );
            return [
              variant,
              { passed: own.filter(({ passed }) => passed).length, total: own.length },
            ];
          }),
        ),
      ]),
  );
}

/** Isolated runs of a generated checksum project: every task goes to a new agent in
 * its own copy of the start project, as in the original suite. A task passes when
 * its main.cpp equals the task's reference byte for byte; the build and the printed
 * answer are recorded beside it.
 */
export const CHECKSUM_RUN_VERSION = "multi-agent-checksum-isolated-v1";
export const CHECKSUM_SHARED_VERSION = "multi-agent-checksum-shared-v1";
export const CHECKSUM_DELIVERY_DEADLINE_MS = 300_000;
const execFileAsync = promisify(execFile);

/** Build one main.cpp and run it; the result records what it printed. */
export async function buildAndRun(directory, source, signal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "main.cpp"),
    binary = path.join(directory, "program");
  await writeFile(file, source);
  try {
    await execFileAsync("clang++", ["-std=c++17", file, "-o", binary], { signal });
  } catch (error) {
    return { built: false, output: null, error: String(error.stderr ?? error.message) };
  }
  try {
    const { stdout } = await execFileAsync(binary, [], { signal, timeout: 10_000 });
    return { built: true, output: stdout.trim() };
  } catch (error) {
    return { built: true, output: null, error: String(error.message) };
  }
}

/** Spend model credit on one isolated run of every task of the seed's project. */
export async function runChecksumIsolated(
  seed,
  outputPath,
  config,
  { agents = 5, options = {}, signal } = {},
) {
  assert.ok(Number.isSafeInteger(agents) && agents >= 1);
  const source = await restoringSourceIdentity();
  assert.equal(source.sourceClean, true, "Checksum runs require clean committed source");
  const project = generateChecksumProject(seed, options);
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const identity = {
    version: CHECKSUM_RUN_VERSION,
    project: CHECKSUM_PROJECT_VERSION,
    seed,
    counts: project.counts,
    source,
    harness: config.harness ?? "baseline-agent",
    model: config.model,
    thinking: config.thinking ?? null,
    agents,
    deadlineSeconds: CHECKSUM_DELIVERY_DEADLINE_MS / 1000,
  };
  await writeFile(path.join(output, "start-main.cpp"), project.start);
  await writeFile(path.join(output, "expected-main.cpp"), project.expected);

  const pools = new Map();
  const rows = new Map();
  const started = Date.now();
  const { results } = await runAgentQueue(project.tasks, {
    lifecycle: "per-delivery",
    maxAgents: agents,
    signal,
    async createDriver(task, session, context) {
      const directory = path.join(output, "tasks", task.id);
      const workspace = path.join(directory, "workspace");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await writeFile(path.join(workspace, "main.cpp"), project.start);
      const drivers = chunkModelDrivers(directory, workspace, config, "");
      pools.set(task.id, { drivers, workspace, directory });
      return drivers.createDriver(null, session, context);
    },
    async execute(driver, task, { signal: abort, session }) {
      const { drivers } = pools.get(task.id);
      const row = { id: task.id, kind: task.kind, session, started: new Date().toISOString() };
      rows.set(task.id, row);
      const outcome = await drivers.execute(driver, task.prompt, {
        signal: abort,
        session,
        timeoutMs: CHECKSUM_DELIVERY_DEADLINE_MS,
      });
      row.status = outcome.status;
      row.ended = new Date().toISOString();
      return outcome;
    },
    async onClosed(driver, task) {
      rows.get(task.id).usage = pools.get(task.id).drivers.usage(driver);
    },
  });
  for (const { drivers } of pools.values()) await drivers.cleanup();
  const minutes = (Date.now() - started) / 60000;

  const tasks = [];
  for (const [index, task] of project.tasks.entries()) {
    const { workspace, directory } = pools.get(task.id);
    const main = await readFile(path.join(workspace, "main.cpp"), "utf8").catch(() => null);
    const files = (await readdir(workspace)).sort();
    const run =
      main === null ? null : await buildAndRun(path.join(directory, "build"), main, signal);
    // The same per-edit checks as in a shared run, against this task's reference.
    const grade =
      main === null
        ? null
        : gradeSharedChecksum({ start: project.start, expected: task.result, tasks: [task] }, main);
    tasks.push({
      ...rows.get(task.id),
      cluster: task.cluster,
      variant: task.variant,
      status: results[index]?.status ?? rows.get(task.id)?.status ?? "not-run",
      edits:
        grade?.edits ??
        (task.parts ?? [task]).map(({ id, cluster, variant }) => ({
          id,
          cluster,
          variant,
          passed: false,
        })),
      damaged: grade?.damaged ?? [],
      exact: main === task.result,
      built: run?.built ?? false,
      answer: run?.output ?? null,
      expectedAnswer: task.answer,
      extraFiles: files.filter((file) => file !== "main.cpp"),
    });
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  for (const row of tasks)
    for (const key of Object.keys(usage)) usage[key] += row.usage?.[key] ?? 0;
  const passed = tasks.filter((row) => row.exact && row.extraFiles.length === 0).length;
  const summary = {
    version: CHECKSUM_RUN_VERSION,
    identity,
    minutes: Number(minutes.toFixed(2)),
    passed,
    total: tasks.length,
    // Edits whose own checks pass, even when other bytes of the file differ.
    byCluster: clusterSummary(tasks.flatMap((row) => row.edits)),
    usage,
    tasks,
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}

/** The fact a shared-file agent needs: other agents edit the same file meanwhile. */
const SHARED_NOTICE =
  "Several agents are editing main.cpp at the same time. The file can change between the moment you read it and the moment you write it, and the risk of conflicting edits is high, so be as careful as possible with your edits.";

/** The prompt of a task in the shared file: the notice after the frame's opening. */
export function sharedPrompt(task) {
  const [opening, ...rest] = task.prompt.split("\n\n");
  return [opening, SHARED_NOTICE, ...rest].join("\n\n");
}

/** The paragraphs of a main.cpp: prototypes, each definition or slot, and main. */
const blocks = (text) => text.replace(/\n$/, "").split("\n\n");

/** The text of a namespace from its opening line to its closing line, or undefined. */
function namespaceText(text, name) {
  const open = text.indexOf(`namespace ${name} {\n`);
  const close = open < 0 ? -1 : text.indexOf(`}  // namespace ${name}\n`, open);
  return close < 0 ? undefined : text.slice(open, close);
}

/** Grade a shared main.cpp against the project's reference. A block passes when it
 * stands in the candidate exactly once, as a whole paragraph. A rename passes when
 * the old identifier is gone, the new one appears as often as in the reference and
 * longer identifiers that contain the old spelling are unchanged. An expression
 * passes when its comment line and edited line stand once, byte for byte as in the
 * reference. A move or an insert passes when its paragraph stands once, its slot is
 * gone and a neighbour paragraph matches the reference; a moved function also keeps
 * its prototype, if it has one.
 */
export function gradeSharedChecksum(project, candidate) {
  const wanted = blocks(project.expected),
    got = blocks(candidate);
  const count = (text, part) => text.split(part).length - 1;
  const paragraphs = new Map();
  for (const block of got) paragraphs.set(block, (paragraphs.get(block) ?? 0) + 1);
  const damaged = wanted.filter((block) => paragraphs.get(block) !== 1);
  // Paragraphs that stand unchanged in the start and that no edit moves.
  const moved = new Set(
    project.tasks
      .flatMap((task) => task.parts ?? [task])
      .filter(({ kind }) => kind === "move")
      .flatMap(({ name, full }) => [
        `long long ${name}(long long value) {`,
        // The later paragraphs of an O definition move with it.
        ...(full
          ? blocks(full)
              .slice(1)
              .map((block) => block.split("\n")[0])
          : []),
      ]),
  );
  const original = new Set(blocks(project.start ?? ""));
  const untouched = new Set(
    wanted.filter((block) => original.has(block) && !moved.has(block.split("\n")[0])),
  );
  const edits = project.tasks.flatMap((task) => task.parts ?? [task]);
  // A neighbour is known by its first line, so another agent's unfinished edit
  // inside it does not fail this one. Slots, inserted text and deleted functions
  // come and go with other agents' edits, so they are not neighbours.
  const first = (block) => block?.split("\n")[0];
  const inserted = new Set(edits.filter(({ kind }) => kind === "insert").map(({ text }) => text));
  const deleted = new Set(
    edits.flatMap((edit) =>
      edit.kind === "delete"
        ? [`long long ${edit.name}(long long value) {`]
        : edit.kind === "commented-delete"
          ? [edit.comment[0]]
          : [],
    ),
  );
  const passing = (block) =>
    block.startsWith("// __EXPLICIT_EDIT_SLOT_") ||
    inserted.has(block) ||
    deleted.has(first(block));
  const neighbour = (list, at, step) => {
    let index = at + step;
    while (index >= 0 && index < list.length && passing(list[index])) index += step;
    return first(list[index]);
  };
  const placed = (find, marker, variants = [(block) => block]) => {
    const at = got.findIndex(find),
      reference = wanted.findIndex(find);
    return (
      at >= 0 &&
      reference >= 0 &&
      paragraphs.get(got[at]) === 1 &&
      variants.some((variant) => got[at] === variant(wanted[reference])) &&
      count(candidate, marker) === 0 &&
      (neighbour(got, at, -1) === neighbour(wanted, reference, -1) ||
        neighbour(got, at, 1) === neighbour(wanted, reference, 1))
    );
  };
  const checks = new Map();
  for (const edit of edits) {
    let passed;
    if (edit.kind === "rename")
      passed =
        identifierCount(candidate, edit.name) === 0 &&
        identifierCount(candidate, edit.newName) ===
          identifierCount(project.expected, edit.newName) &&
        edit.lookAlikes.every(
          (name) => identifierCount(candidate, name) === identifierCount(project.expected, name),
        );
    else if (edit.kind === "expression")
      passed =
        count(candidate, edit.before) === 0 && count(candidate, edit.context ?? edit.after) === 1;
    else if (edit.kind === "insert") passed = placed((block) => block === edit.text, edit.marker);
    // The other copies of an F text stay unchanged, and a G name is new only in its
    // own function. New G names differ per edit, while two G traps share "b".
    // A copy of the text elsewhere that turned into the new text counts against the
    // edit; a copy that another agent destroyed does not.
    else if (edit.kind === "scoped-replace") {
      const own = definitionText(candidate, edit.host) ?? "";
      passed =
        count(candidate, edit.after) === 1 &&
        own.includes(edit.after) &&
        !own.includes(edit.before);
    } else if (edit.kind === "delete")
      // An N function's commented-out copy stays.
      passed =
        definitionText(candidate, edit.name) === undefined &&
        count(candidate, `long long ${edit.name}(long long value);`) ===
          count(project.expected, `long long ${edit.name}(long long value);`) &&
        (edit.copy === undefined || count(candidate, edit.copy) === 1);
    // Both namespaces of a K edit stand as in the reference: the target lost its
    // definition and the other namespace kept its own.
    else if (edit.kind === "namespace-delete")
      passed = [edit.namespace, edit.decoy].every(
        (space) =>
          namespaceText(candidate, space) !== undefined &&
          namespaceText(candidate, space) === namespaceText(project.expected, space),
      );
    else if (edit.kind === "commented-delete")
      passed =
        definitionText(candidate, edit.name) === undefined &&
        edit.comment.every((line) => count(candidate, line) === 0);
    else if (edit.kind === "bulk-delete") {
      const calls = candidate
        .split("\n")
        .filter((line) => line.trimStart().startsWith(`${edit.name}(`));
      passed = calls.length === 0 && count(candidate, edit.definition) === 1;
    } else if (edit.kind === "local-rename")
      passed =
        definitionText(candidate, edit.name) === definitionText(project.expected, edit.name) &&
        identifierCount(candidate, edit.newName) ===
          identifierCount(project.expected, edit.newName);
    else {
      const signature = `long long ${edit.name}(long long value)`;
      // A J trap's function may still hold its partner's old expression: a lost
      // partner edit fails the partner.
      const inner = edits.find(
        ({ partner, kind }) => partner?.id === edit.id && kind === "expression",
      );
      const variants = [(block) => block];
      if (inner && edit.variant === "trap")
        variants.push((block) => block.replace(inner.after, inner.before));
      // An O definition holds an empty line, so its first paragraph alone does not
      // show that the whole definition moved.
      passed =
        placed((block) => block.startsWith(`${signature} {`), edit.marker, variants) &&
        (edit.full === undefined || count(candidate, edit.full) === 1) &&
        count(candidate, `${signature};`) === count(project.expected, `${signature};`);
    }
    checks.set(edit.id, {
      id: edit.id,
      kind: edit.kind,
      cluster: edit.cluster,
      variant: edit.variant,
      zone: edit.zone,
      passed,
    });
  }
  // A composite task passes only when every one of its edits does.
  const tasks = project.tasks.map((task) => ({
    id: task.id,
    kind: task.kind,
    passed: (task.parts ?? [task]).every(({ id }) => checks.get(id).passed),
    failedEdits: (task.parts ?? [task])
      .filter(({ id }) => !checks.get(id).passed)
      .map(({ id }) => id),
  }));
  return {
    exact: candidate === project.expected,
    tasks,
    edits: [...checks.values()],
    passed: tasks.filter(({ passed }) => passed).length,
    // Paragraphs of the reference that are lost, changed or duplicated in the candidate.
    damaged: damaged.map((block) => block.split("\n")[0]),
    // Damaged paragraphs that no edit was meant to change or move: harm that one
    // agent's mistake did to text outside every task.
    collateral: damaged
      .filter((block) => untouched.has(block))
      .map((block) => block.split("\n")[0]),
    extra: got.filter((block) => !wanted.includes(block)).map((block) => block.split("\n")[0]),
  };
}

/** Spend model credit on one shared-file run: all agents start and warm up, then
 * wait at a barrier; each wave gives every agent one task at the same moment, and
 * the next wave starts when every agent of this one has finished. Agents persist
 * across waves; a timed-out agent is replaced before the next wave.
 */
export async function runChecksumShared(
  seed,
  outputPath,
  config,
  { agents, options = {}, sandbox = "separate", notice = true, signal } = {},
) {
  assert.ok(["separate", "shared"].includes(sandbox), `Unknown sandbox mode ${sandbox}`);
  const source = await restoringSourceIdentity();
  assert.equal(source.sourceClean, true, "Checksum runs require clean committed source");
  const project = generateChecksumProject(seed, options);
  const team = agents ?? project.tasks.length;
  assert.ok(Number.isSafeInteger(team) && team >= 1 && team <= project.tasks.length);
  const output = path.resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const identity = {
    version: CHECKSUM_SHARED_VERSION,
    project: CHECKSUM_PROJECT_VERSION,
    seed,
    counts: project.counts,
    source,
    harness: config.harness ?? "baseline-agent",
    model: config.model,
    thinking: config.thinking ?? null,
    agents: team,
    sandbox,
    // Whether prompts say that other agents edit the same file.
    notice,
    deadlineSeconds: CHECKSUM_DELIVERY_DEADLINE_MS / 1000,
  };
  const workspace = path.join(output, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(path.join(workspace, "main.cpp"), project.start);
  await writeFile(path.join(output, "start-main.cpp"), project.start);
  await writeFile(path.join(output, "expected-main.cpp"), project.expected);

  /** @type {Promise<any> | undefined} */
  let teamSandbox;
  const sharedSandbox =
    sandbox === "shared"
      ? () => (teamSandbox ??= startSharedSandbox(path.join(output, "sandbox")))
      : undefined;
  const drivers = chunkModelDrivers(path.join(output, "agents"), workspace, config, "", {
    sharedSandbox,
  });
  /** @type {{ driver: any, session: number }[]} */
  const slots = Array.from({ length: team }, () => ({ driver: null, session: 0 }));
  const usage = [];
  let sessions = 0;
  const retire = async (slot) => {
    if (!slot.driver) return;
    if (slot.driver.closed !== true)
      await (slot.driver.terminate ?? slot.driver.close).call(slot.driver);
    usage.push(drivers.usage(slot.driver));
    slot.driver = null;
  };
  const rows = [];
  const waves = [];
  const started = Date.now();
  try {
    for (let first = 0; first < project.tasks.length; first += team) {
      const wave = project.tasks.slice(first, first + team);
      // Warm-up: every agent of the wave is started before any task is given.
      const warm = Date.now();
      await Promise.all(
        slots.slice(0, wave.length).map(async (slot) => {
          if (slot.driver && slot.driver.closed !== true) return;
          await retire(slot);
          // Take the number before waiting: other slots start their agents meanwhile.
          const session = ++sessions;
          slot.driver = await drivers.createDriver(null, session, { signal });
          slot.session = session;
        }),
      );
      const barrier = Date.now();
      const results = await Promise.all(
        wave.map(async (task, index) => {
          const slot = slots[index];
          const row = {
            id: task.id,
            kind: task.kind,
            cluster: task.cluster,
            variant: task.variant,
            zone: task.zone,
            wave: waves.length + 1,
            session: slot.session,
          };
          rows.push(row);
          const begin = Date.now();
          try {
            const outcome = await drivers.execute(
              slot.driver,
              notice ? sharedPrompt(task) : task.prompt,
              {
                signal,
                session: slot.session,
                timeoutMs: CHECKSUM_DELIVERY_DEADLINE_MS,
              },
            );
            row.status = outcome.status;
          } catch (error) {
            row.status = "error";
            row.error = String(error?.message ?? error);
          }
          row.seconds = Number(((Date.now() - begin) / 1000).toFixed(1));
          return row;
        }),
      );
      waves.push({
        tasks: wave.length,
        warmUpSeconds: Number(((barrier - warm) / 1000).toFixed(1)),
        seconds: Number(((Date.now() - barrier) / 1000).toFixed(1)),
        timedOut: results.filter((row) => row.status === "timed-out").length,
      });
      await writeFile(
        path.join(output, `after-wave-${waves.length}.cpp`),
        await readFile(path.join(workspace, "main.cpp"), "utf8"),
      );
    }
  } finally {
    for (const slot of slots) await retire(slot);
    await drivers.cleanup();
    if (teamSandbox) await (await teamSandbox).stop();
  }
  const minutes = (Date.now() - started) / 60000;
  const main = await readFile(path.join(workspace, "main.cpp"), "utf8");
  const files = (await readdir(workspace)).sort();
  const grade = gradeSharedChecksum(project, main);
  const run = await buildAndRun(path.join(output, "build"), main, signal);
  const total = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  for (const entry of usage) for (const key of Object.keys(total)) total[key] += entry?.[key] ?? 0;
  const byId = new Map(grade.tasks.map((task) => [task.id, task]));
  const summary = {
    version: CHECKSUM_SHARED_VERSION,
    identity,
    minutes: Number(minutes.toFixed(2)),
    exact: grade.exact,
    passed: grade.passed,
    total: project.tasks.length,
    // Single edits by cluster; a composite task counts each of its edits here.
    byCluster: clusterSummary(grade.edits),
    damaged: grade.damaged,
    collateral: grade.collateral,
    extra: grade.extra,
    built: run.built,
    answer: run.output,
    expectedAnswer: project.answers.expected,
    extraFiles: files.filter((file) => file !== "main.cpp"),
    waves,
    usage: total,
    tasks: rows.map((row) => ({
      ...row,
      passed: byId.get(row.id).passed,
      failedEdits: byId.get(row.id).failedEdits,
    })),
  };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}
