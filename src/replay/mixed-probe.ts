import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { piRpcEvents, type PiRecord } from "./adapters/pi.ts";
import type { AgentEvent } from "./adapters/common.ts";
import { Attributor, refineChange, type CallWindow } from "./attribution.ts";
import { lineHunks } from "./trace/diff.ts";
import { sha256, splitLines, writeTrace } from "./trace/store.ts";
import {
  TRACE_FORMAT,
  type AgentInfo,
  type FileChangeEvent,
  type TraceEvent,
  type TraceHeader,
} from "./trace/types.ts";

/**
 * Source for the Explicit Edit benchmark's shared-file mixed probe (`mixed-run`): one
 * fresh Pi agent per task, up to N at once, all editing one workspace/main.cpp. The run
 * directory gives the tasks and every agent's Pi RPC events; the agent-replay recording
 * gives every version of main.cpp and the time each event line was written.
 */
export interface MixedImportOptions {
  recording?: string;
  out: string;
  title?: string;
}

const HARNESS_LABELS: Record<string, string> = {
  "pi-agent-ide-codemode-no-bash": "Pi Agent IDE",
  "pi-agent-ide-codemode": "Pi Agent IDE + Bash",
  "baseline-agent": "Pi, Bash only",
  "oh-my-pi-default": "Oh My Pi",
  "oh-my-pi-no-bash": "Oh My Pi, no Bash",
  "dirac-default": "Dirac",
  "dirac-no-bash": "Dirac, no Bash",
  "pi-hashline-edit-pro": "pi-hashline-edit-pro",
  "pi-hashline-edit-pro-no-bash": "pi-hashline-edit-pro, no Bash",
};

/** The product whose version the delivery receipts report. */
const RUNTIME_NAMES: Record<string, string> = {
  "oh-my-pi-default": "Oh My Pi",
  "oh-my-pi-no-bash": "Oh My Pi",
  "dirac-default": "Dirac",
  "dirac-no-bash": "Dirac",
};

/** The fields of a mixed-run delivery row the importer reads. */
interface DeliveryRow {
  phase?: string;
  session: number;
  id: string;
  file: string | null;
  units: number | null;
  started: string;
  ended?: string | null;
  status: string;
  receipt?: {
    model?: string;
    version?: string;
    thinking?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cost?: number };
  };
}

interface MixedReport {
  deliveries: DeliveryRow[];
  identity?: { harness?: string };
}

interface MixedSummary {
  identity?: { harness?: string };
  checks?: {
    all?: { passed?: number; total?: number };
    integrity?: { passed: boolean; affectedLines?: number };
  };
  verdict?: string;
  minutes?: number;
  usage?: { output?: number };
}

interface RecordedVersion {
  t: number;
  sha256: string;
}

interface StreamGrowth {
  t: number;
  file: string;
  size: number;
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));
const readJsonl = async (file: string): Promise<unknown[]> =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));

export function taskLabel(id: string, file: string | null, units: number | null) {
  let match;
  if (id.startsWith("extract-") && file)
    return `Move ${units ?? ""} block${units === 1 ? "" : "s"} to ${file.split("/").at(-1)}`.replace(
      "  ",
      " ",
    );
  if ((match = /^rename-unique-(.+)$/.exec(id))) return `Rename ${match[1]}`;
  if ((match = /^rename-shared-(.+)$/.exec(id))) return `Rename one ${match[1]} overload`;
  if ((match = /^rename-(?:parameter|param)-(.+)$/.exec(id))) return `Rename parameter ${match[1]}`;
  if ((match = /^rename-field-(.+)$/.exec(id))) return `Rename field ${match[1]}`;
  return id;
}

const STATUS: Record<string, AgentInfo["status"]> = {
  settled: "done",
  "timed-out": "timed-out",
  error: "failed",
  running: "running",
};

/** Event lines with the time each was written, from the recorder's stream log. */
async function timedRecords(
  file: string,
  growth: Array<{ t: number; size: number }>,
): Promise<PiRecord[]> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const records: PiRecord[] = [];
  let offset = 0;
  let cursor = 0;
  for (const line of text.split("\n")) {
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let event: PiRecord["event"];
    try {
      event = JSON.parse(line) as PiRecord["event"];
    } catch {
      continue; // A killed process can leave a partial last line.
    }
    while ((growth[cursor]?.size ?? Infinity) < offset - 1) cursor++;
    records.push({ event, at: growth[cursor]?.t });
  }
  return records;
}

export async function importMixedProbe(runDir: string, options: MixedImportOptions) {
  const run = path.resolve(runDir);
  const report = (await readJson(path.join(run, "report.json"))) as MixedReport;
  const summary = (await readJson(path.join(run, "summary.json")).catch(
    () => null,
  )) as MixedSummary | null;
  const deliveries = report.deliveries.filter((row) => row.phase === "mixed");
  const harnessId = report.identity?.harness ?? summary?.identity?.harness ?? "unknown";
  const receipt = deliveries.find((row) => row.receipt)?.receipt ?? {};

  const filePath = "main.cpp";
  const fileId = "main.cpp";
  const files = [{ id: fileId, path: filePath }];

  // File versions.
  const versions: Array<{ t: number; text: string }> = [];
  const growth = new Map<string, Array<{ t: number; size: number }>>();
  if (options.recording) {
    const recording = path.resolve(options.recording);
    for (const version of (await readJsonl(
      path.join(recording, "versions.jsonl"),
    )) as RecordedVersion[])
      versions.push({
        t: version.t,
        text: gunzipSync(
          await readFile(path.join(recording, "blobs", `${version.sha256}.gz`)),
        ).toString("utf8"),
      });
    for (const record of (await readJsonl(
      path.join(recording, "streams.jsonl"),
    )) as StreamGrowth[]) {
      const name = path.basename(record.file);
      const list = growth.get(name) ?? [];
      list.push({ t: record.t, size: record.size });
      growth.set(name, list);
    }
  } else {
    versions.push({ t: 0, text: await readFile(path.join(run, "workspace", filePath), "utf8") });
  }

  const starts = deliveries.map((row) => Date.parse(row.started));
  const t0 = Math.min(...starts);
  let initialIndex = 0;
  for (const [index, version] of versions.entries()) if (version.t <= t0) initialIndex = index;
  const initial = versions[initialIndex]?.text ?? "";

  // Agents.
  const agentEvents: AgentEvent[] = [];
  const agents: AgentInfo[] = [];
  const prompts: string[] = [];
  for (const row of deliveries) {
    const agent = `s${row.session}`;
    const records = await timedRecords(
      path.join(run, "mixed", `session-${row.session}-events.jsonl`),
      growth.get(`session-${row.session}-events.jsonl`) ?? [],
    );
    const events = piRpcEvents(records, { agent, files });
    const started = Date.parse(row.started);
    const ended = row.ended ? Date.parse(row.ended) : Math.max(started, ...events.map((e) => e.t));
    if (!events.some((event) => event.kind === "agent.start"))
      events.unshift({ kind: "agent.start", agent, t: started });
    const status = STATUS[row.status] ?? "failed";
    if (!events.some((event) => event.kind === "agent.end"))
      events.push({ kind: "agent.end", agent, t: ended, status });
    agentEvents.push(...events);
    const prompt = events.find((event) => event.kind === "message" && event.role === "user");
    prompts.push(prompt?.kind === "message" ? prompt.text : "");
    agents.push({
      id: agent,
      label: taskLabel(row.id, row.file, row.units),
      harness: harnessId,
      model: row.receipt?.model,
      startMs: started,
      endMs: ended,
      status,
      ...(row.receipt?.usage
        ? {
            usage: {
              input: row.receipt.usage.input,
              output: row.receipt.usage.output,
              cacheRead: row.receipt.usage.cacheRead,
              cost: row.receipt.usage.cost,
            },
          }
        : {}),
    });
  }
  // The general instructions open every prompt; keep only each agent's own assignment.
  const shared = commonPrefix(prompts.filter(Boolean));
  const cut = shared.lastIndexOf("\n") + 1;
  for (const [index, agent] of agents.entries())
    agent.task = prompts[index]?.slice(cut).trim() || undefined;
  for (const event of agentEvents)
    if (event.kind === "message" && event.role === "user" && cut > 0 && event.text.length > cut)
      event.text = event.text.slice(cut).trim();

  // Attribution windows of mutating calls.
  const windows: CallWindow[] = [];
  const open = new Map<string, CallWindow>();
  for (const event of agentEvents) {
    if (event.kind === "call.start" && event.mutating) {
      const window: CallWindow = {
        agent: event.agent,
        call: event.call,
        start: event.t,
        end: Infinity,
        args: event.args,
        parent: event.parent,
      };
      open.set(event.call, window);
      windows.push(window);
    } else if (event.kind === "call.end") {
      const window = open.get(event.call);
      if (window) {
        window.end = event.t;
        window.output = event.output;
      }
    }
  }
  const attributor = new Attributor(windows, {
    lifetimes: new Map(
      agents.map((agent) => [agent.id, { start: agent.startMs, end: agent.endMs }]),
    ),
  });

  const changes: Array<Omit<FileChangeEvent, "seq">> = [];
  let previous = splitLines(initial);
  // After the last agent, the controller strips its slot markers; that is not the agents' work.
  const cutoff = Math.max(...agents.map((agent) => agent.endMs));
  let partialWrites = 0;
  for (let i = initialIndex + 1; i < versions.length; i++) {
    const version = versions[i];
    if (!version || version.t > cutoff) break;
    if (isPartialWrite(version, versions[i + 1])) {
      partialWrites++;
      continue;
    }
    const next = splitLines(version.text);
    const found = lineHunks(previous, next);
    if (!found.length) continue;
    const hunks = found.map((hunk) => ({ ...hunk, cause: attributor.attribute(version.t, hunk) }));
    refineChange(hunks);
    changes.push({
      kind: "file.change",
      t: version.t,
      file: fileId,
      version: changes.length + 1,
      hunks,
      lines: next.length,
      sha256: sha256(version.text),
    });
    previous = next;
  }

  // One clock: milliseconds from the first agent start.
  const order = [
    "agent.start",
    "message",
    "call.start",
    "file.change",
    "call.end",
    "observe",
    "agent.end",
  ];
  const all = [...agentEvents, ...changes]
    .map((event) => ({ ...event, t: Math.max(0, event.t - t0) }))
    .sort((a, b) => a.t - b.t || order.indexOf(a.kind) - order.indexOf(b.kind));
  const events: TraceEvent[] = all.map((event, seq) => ({ ...event, seq }));
  for (const agent of agents) {
    agent.startMs = Math.max(0, agent.startMs - t0);
    agent.endMs = Math.max(agent.startMs, agent.endMs - t0);
  }
  const durationMs = Math.max(
    ...agents.map((agent) => agent.endMs),
    ...events.map((event) => event.t),
  );

  const counts = { moves: 0, renames: 0 };
  for (const row of deliveries) {
    if (row.id.startsWith("extract-")) counts.moves++;
    else counts.renames++;
  }
  const live = maxConcurrent(agents);
  const harnessLabel = HARNESS_LABELS[harnessId] ?? harnessId;
  const initialHash = sha256(initial);
  const header: TraceHeader = {
    format: TRACE_FORMAT,
    scenario: {
      title: options.title ?? `${agents.length} agents, one file`,
      task:
        `${agents.length} tasks on one shared ${splitLines(initial).length.toLocaleString("en-US")}-line main.cpp, ` +
        `at most ${live} agents at a time, each with its own task and no coordination: ` +
        `${counts.moves} block moves into new headers and ${counts.renames} renames.`,
      scope: [filePath],
    },
    run: {
      harness: harnessId,
      harnessLabel,
      harnessVersion: receipt.version
        ? `${RUNTIME_NAMES[harnessId] ?? "Pi"} ${receipt.version}`
        : undefined,
      model: receipt.model,
      thinking: receipt.thinking,
      source: `explicit-edit mixed probe: ${path.basename(run)}`,
      startedAt: new Date(t0).toISOString(),
      durationMs,
      outcome: summary
        ? {
            "Checks passed": `${summary.checks?.all?.passed}/${summary.checks?.all?.total}`,
            Integrity: summary.checks?.integrity
              ? summary.checks.integrity.passed
                ? "intact"
                : `${summary.checks.integrity.affectedLines} collateral lines`
              : null,
            Verdict: summary.verdict ?? null,
            Minutes: summary.minutes ?? null,
            "Output tokens": summary.usage?.output ?? null,
            ...(partialWrites ? { "Half-written file states": partialWrites } : {}),
          }
        : undefined,
    },
    agents,
    files: [{ id: fileId, path: filePath, language: "cpp", initial: { blob: initialHash } }],
  };
  await writeTrace(options.out, header, events, new Map([[initialHash, initial]]));
  const hunks = changes.flatMap((change) => change.hunks);
  const by = (confidence: string) =>
    hunks.filter((hunk) => hunk.cause.confidence === confidence).length;
  return {
    out: path.resolve(options.out),
    agents: agents.length,
    events: events.length,
    changes: changes.length,
    hunks: hunks.length,
    exact: by("exact"),
    matched: by("matched"),
    ambiguous: by("ambiguous"),
    external: by("external"),
  };
}

/**
 * A version caught in the middle of a non-atomic write: the file was truncated and
 * the recorder read it before the writer finished. It is empty or a strict prefix of
 * the version that follows within a moment. Other agents could read it too, so it is
 * counted, but it is not diffed: diffing it would turn every such write into "remove
 * the whole file, insert the whole file".
 */
export function isPartialWrite(
  version: { t: number; text: string },
  next: { t: number; text: string } | undefined,
  windowMs = 250,
) {
  return (
    next !== undefined &&
    next.t - version.t <= windowMs &&
    version.text.length < next.text.length &&
    next.text.startsWith(version.text)
  );
}

function commonPrefix(texts: string[]) {
  const [first, ...rest] = texts;
  if (first === undefined) return "";
  let prefix = first;
  for (const text of rest) {
    let i = 0;
    while (i < prefix.length && i < text.length && prefix[i] === text[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

function maxConcurrent(agents: AgentInfo[]) {
  const points = agents.flatMap((agent): Array<[number, number]> => [
    [agent.startMs, 1],
    [agent.endMs, -1],
  ]);
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let max = 0;
  for (const [, delta] of points) max = Math.max(max, (live += delta));
  return max;
}
