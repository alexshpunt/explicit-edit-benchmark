import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startRecorder, type Recorder } from "./record.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const usage = `Usage:
  npm run replay -- mixed-run REPLAY_DIR -- FLAT_CASE NEW_RUN MIXED_RUN_OPTIONS...
      Run the shared-file mixed probe (module-extraction mixed-run) under the recorder, then
      write REPLAY_DIR/recording, REPLAY_DIR/trace and the page REPLAY_DIR/replay.html.
  npm run replay -- record --out DIR --file PATH... [--stream DIR=REGEX...] [-- COMMAND ARGS...]
      Record every version of the watched files and the growth times of stream logs.
      With a command, record while it runs and exit with its code; otherwise stop on SIGINT or SIGTERM.
  npm run replay -- import-mixed RUN_DIR --recording DIR --out TRACE_DIR [--title TEXT]
      Turn a mixed-probe run and its recording into a trace.
  npm run replay -- build TRACE_DIR --out FILE.html
      Build one self-contained replay page.
  npm run replay -- agreement TRACE_DIR
      Check hunk attribution against the tasks: a hunk that introduces a name only one
      agent's task mentions belongs to that agent.`;

class UsageError extends Error {}

/** Runs one replay command and returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "mixed-run") return await mixedRun(rest);
    if (command === "record") return await record(rest);
    if (command === "import-mixed") return await importMixed(rest);
    if (command === "build") return await build(rest);
    if (command === "agreement") return await agreement(rest);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message ? `${error.message}\n\n${usage}` : usage);
    return 2;
  }
  console.error(usage);
  return command === "help" || command === "--help" ? 0 : 2;
}

function split(argv: string[]) {
  const at = argv.indexOf("--");
  return at < 0 ? { own: argv, child: [] } : { own: argv.slice(0, at), child: argv.slice(at + 1) };
}

async function importMixed(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      recording: { type: "string" },
      out: { type: "string" },
      title: { type: "string" },
    },
  });
  const [run] = positionals;
  if (positionals.length !== 1 || run === undefined || !values.out) throw new UsageError("");
  const { importMixedProbe } = await import("./mixed-probe.ts");
  console.log(
    await importMixedProbe(run, {
      recording: values.recording,
      out: values.out,
      title: values.title,
    }),
  );
  return 0;
}

async function build(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const [trace] = positionals;
  if (positionals.length !== 1 || trace === undefined || !values.out) throw new UsageError("");
  const { buildReplay } = await import("./build.ts");
  await buildReplay(trace, values.out);
  console.log(path.resolve(values.out));
  return 0;
}

async function agreement(argv: string[]) {
  const [trace] = argv;
  if (argv.length !== 1 || trace === undefined) throw new UsageError("");
  const { attributionAgreement } = await import("./agreement.ts");
  for (const [confidence, { checked, agree }] of Object.entries(await attributionAgreement(trace)))
    console.log(`${confidence}: ${agree} of ${checked} checkable hunks agree with the tasks`);
  return 0;
}

async function record(argv: string[]) {
  const { own, child } = split(argv);
  const { values } = parseArgs({
    args: own,
    options: {
      out: { type: "string" },
      file: { type: "string", multiple: true },
      stream: { type: "string", multiple: true },
    },
  });
  if (!values.out || !values.file?.length) throw new UsageError("");
  const recorder = await startRecorder({
    out: path.resolve(values.out),
    files: values.file.map((file) => path.resolve(file)),
    streams: (values.stream ?? []).map((entry) => {
      const at = entry.indexOf("=");
      if (at < 1) throw new UsageError(`--stream needs DIR=REGEX, got ${entry}`);
      return {
        directory: path.resolve(entry.slice(0, at)),
        pattern: new RegExp(entry.slice(at + 1)),
      };
    }),
  });
  const code = child.length ? await runChild(child) : await untilSignal();
  await stopRecorder(recorder);
  return code;
}

/**
 * Records a mixed-probe run and builds its replay. The run's own output stays where the
 * mixed-run command writes it; the replay directory holds only the recording, the trace
 * and the page.
 */
async function mixedRun(argv: string[]) {
  const { own, child } = split(argv);
  const [replayDir] = own;
  if (own.length !== 1 || replayDir === undefined) throw new UsageError("");
  // FLAT_CASE and NEW_RUN come first, as in the mixed-run usage, so option values are
  // never mistaken for the run directory.
  const [flatCase, runDir] = child;
  if (
    flatCase === undefined ||
    runDir === undefined ||
    [flatCase, runDir].some((a) => a.startsWith("-"))
  )
    throw new UsageError("mixed-run needs FLAT_CASE and NEW_RUN right after --");
  const out = path.resolve(replayDir);
  if (existsSync(out)) throw new UsageError(`${out} exists; use a new replay directory`);
  return replayMixedRun(out, path.resolve(runDir), [
    process.execPath,
    path.join(ROOT, "scripts", "module-extraction.mjs"),
    "mixed-run",
    ...child,
  ]);
}

/** Runs `command`, which writes a mixed-probe run to `run`, under the recorder, then
 * imports the run into `out/trace` and builds `out/replay.html`. Returns the command's
 * exit code, or 1 when the command left no run report to replay. */
export async function replayMixedRun(out: string, run: string, command: string[]) {
  const recording = path.join(out, "recording");
  const recorder = await startRecorder({
    out: recording,
    files: [path.join(run, "workspace", "main.cpp")],
    streams: [{ directory: path.join(run, "mixed"), pattern: /^session-[0-9]+-events\.jsonl$/ }],
  });
  const code = await runChild(command);
  await stopRecorder(recorder);
  if (!existsSync(path.join(run, "report.json"))) {
    console.error(`replay: ${run} has no run report, so there is nothing to replay`);
    return code || 1;
  }
  const { importMixedProbe } = await import("./mixed-probe.ts");
  const trace = path.join(out, "trace");
  const imported = await importMixedProbe(run, { recording, out: trace });
  console.error(
    `replay: trace ${imported.out}, ${imported.hunks} hunks of ${imported.agents} agents`,
  );
  const { buildReplay } = await import("./build.ts");
  const page = path.join(out, "replay.html");
  await buildReplay(trace, page);
  console.error(`replay: page ${page}`);
  return code;
}

async function stopRecorder(recorder: Recorder) {
  const counts = await recorder.stop();
  console.error(
    `replay: recorded ${counts.versions} versions, ${counts.streamRecords} stream records`,
  );
}

async function runChild(command: string[]) {
  const [file, ...args] = command;
  if (file === undefined) throw new UsageError("");
  const child = spawn(file, args, { stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exit: number | null, signal: NodeJS.Signals | null) =>
        resolve(exit ?? (signal ? 128 + 15 : 1)),
      );
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

async function untilSignal() {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  return 0;
}
