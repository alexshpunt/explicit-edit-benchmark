/** Indexes a packed trace for replay: agents with colors and lanes, calls, and file
 * states at any time, rebuilt from checkpoints. */
import type {
  AgentInfo,
  Cause,
  FileChangeEvent,
  FileInfo,
  Hunk,
  MessageEvent,
  ObserveEvent,
  PackedTrace,
  ToolCategory,
  TraceHeader,
} from "../../trace/types.ts";
import { summarizeCall } from "./format.ts";

export type Rgb = readonly [number, number, number];

export interface Call {
  id: string;
  agent: Agent;
  tool: string;
  category: ToolCategory;
  args: unknown;
  mutating: boolean;
  start: number;
  /** End time; for a call that never ended, the end of its agent. */
  end: number;
  finished: boolean;
  ok: boolean | null;
  output: string;
  outputBytes: number;
  summary: string;
  observes: ObserveEvent[];
  marks: Mark[];
  /** The Codemode script that made this call, for a nested call. */
  parent: Call | null;
  /** Calls a script made, sorted by start. */
  children: Call[];
}

/** One hunk of one file change, with its cause resolved. Lines it inserted point at it. */
export interface Mark {
  t: number;
  confidence: Cause["confidence"];
  agent: Agent | null;
  call: Call | null;
  candidates: Call[];
  file: FileModel;
  change: FileChangeEvent;
  hunk: Hunk;
}

export type Item =
  | { kind: "message"; t: number; message: MessageEvent }
  | { kind: "call"; t: number; call: Call };

export interface Agent {
  id: string;
  info: AgentInfo;
  index: number;
  color: Rgb;
  lane: number;
  calls: Call[];
  items: Item[];
  marks: Mark[];
}

export interface Model {
  header: TraceHeader;
  duration: number;
  agents: Agent[];
  agentById: Map<string, Agent>;
  /** Sorted by start. */
  calls: Call[];
  callById: Map<string, Call>;
  files: FileModel[];
  laneCount: number;
  /** Calls of each lane, sorted by start. */
  laneCalls: Call[][];
  /** Sorted distinct times of calls, messages and file changes, for stepping. */
  eventTimes: number[];
  editTimes: number[];
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Index of the last element whose key is <= t, or -1. `items` must be sorted by key. */
export function lastAtOrBefore<T>(items: readonly T[], t: number, key: (item: T) => number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (key(items[middle] as T) <= t) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export const rgba = (color: Rgb, alpha: number) =>
  `rgba(${color[0]},${color[1]},${color[2]},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;

/** Evenly spread, equally bright colors: OKLCH with golden-angle hue steps. */
export function agentColor(index: number): Rgb {
  const hue = ((index * 137.508 + 28) % 360) * (Math.PI / 180);
  const lightness = index % 2 ? 0.74 : 0.8;
  const chroma = 0.135;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const [red, green, blue] = linear.map((value) => {
    const clamped = Math.max(0, Math.min(1, value));
    const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(gamma * 255);
  });
  return [red ?? 0, green ?? 0, blue ?? 0];
}

export const CATEGORY_COLORS: Record<ToolCategory, Rgb> = {
  read: [92, 152, 240],
  search: [150, 122, 238],
  edit: [238, 176, 72],
  shell: [72, 202, 160],
  script: [228, 120, 168],
  other: [120, 128, 146],
};

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  read: "Read",
  search: "Search",
  edit: "Edit",
  shell: "Shell",
  script: "Script",
  other: "Other",
};

/** Opacity of a changed line's tint: bright right after the edit, then a lasting trace. */
export function markAlpha(age: number) {
  return 0.24 + 0.56 * Math.exp(-age / 6000);
}

export interface FileState {
  version: number;
  lines: string[];
  marks: (Mark | null)[];
}

export class FileModel {
  static readonly CHECKPOINT = 24;
  readonly changes: FileChangeEvent[] = [];
  readonly times: number[] = [];
  readonly hunkMarks: Mark[][] = [];
  private checkpoints: FileState[] = [];
  private cache: FileState;

  readonly info: FileInfo;
  readonly index: number;

  constructor(info: FileInfo, index: number, initial: string) {
    this.info = info;
    this.index = index;
    const lines = splitLines(initial);
    this.cache = { version: 0, lines, marks: Array.from({ length: lines.length }, () => null) };
    this.checkpoints.push(this.cache);
  }

  private get initialState(): FileState {
    const [initial] = this.checkpoints;
    if (!initial) throw new Error(`${this.info.path} has no initial state`);
    return initial;
  }

  /** Builds the checkpoints once every change and its marks are known. */
  finalize() {
    let state = this.initialState;
    for (let index = 0; index < this.changes.length; index++) {
      state = this.apply(state, index);
      if (state.version % FileModel.CHECKPOINT === 0) this.checkpoints.push(state);
    }
    this.cache = this.initialState;
  }

  get versions() {
    return this.changes.length;
  }

  /** Number of changes applied at time t. */
  versionAt(t: number) {
    return lastAtOrBefore(this.times, t, (time) => time) + 1;
  }

  state(version: number): FileState {
    const cache = this.cache;
    let base =
      cache.version <= version && version - cache.version <= FileModel.CHECKPOINT
        ? cache
        : (this.checkpoints[Math.floor(version / FileModel.CHECKPOINT)] ?? this.initialState);
    while (base.version < version) base = this.apply(base, base.version);
    this.cache = base;
    return base;
  }

  /** Applies change `index` (the one that makes version index + 1). Returns new arrays. */
  private apply(state: FileState, index: number): FileState {
    const { lines, marks } = state;
    const change = this.changes[index];
    const hunkMarks = this.hunkMarks[index] ?? [];
    if (!change) throw new Error(`${this.info.path} has no change ${index + 1}`);
    const nextLines: string[] = [];
    const nextMarks: (Mark | null)[] = [];
    // Loops, not spreads: a file can have more lines than a call can take arguments.
    const keep = (from: number, to: number) => {
      for (const line of lines.slice(from, to)) nextLines.push(line);
      for (const mark of marks.slice(from, to)) nextMarks.push(mark);
    };
    let position = 0;
    for (const [hunkIndex, hunk] of change.hunks.entries()) {
      keep(position, hunk.at);
      const mark = hunkMarks[hunkIndex] ?? null;
      for (const line of hunk.insert) {
        nextLines.push(line);
        nextMarks.push(mark);
      }
      position = hunk.at + hunk.remove;
    }
    keep(position, lines.length);
    return { version: index + 1, lines: nextLines, marks: nextMarks };
  }
}

export function buildModel(trace: PackedTrace): Model {
  const { header, events } = trace;
  const agents: Agent[] = header.agents.map((info, index) => ({
    id: info.id,
    info,
    index,
    color: agentColor(index),
    lane: 0,
    calls: [],
    items: [],
    marks: [],
  }));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const files = header.files.map(
    (info, index) => new FileModel(info, index, trace.blobs[info.initial.blob] ?? ""),
  );
  const fileById = new Map(files.map((file) => [file.info.id, file]));
  const callById = new Map<string, Call>();
  const calls: Call[] = [];
  const times = new Set<number>();
  const editTimes: number[] = [];
  const pendingChanges: Array<{ file: FileModel; change: FileChangeEvent }> = [];
  let lastTime = 0;

  for (const event of events) {
    lastTime = Math.max(lastTime, event.t);
    switch (event.kind) {
      case "call.start": {
        const agent = agentById.get(event.agent);
        if (!agent) break;
        const parent = event.parent ? (callById.get(event.parent) ?? null) : null;
        const call: Call = {
          id: event.call,
          agent,
          tool: event.tool,
          category: event.category,
          args: event.args,
          mutating: event.mutating,
          start: event.t,
          end: parent?.end ?? agent.info.endMs,
          finished: false,
          ok: null,
          output: "",
          outputBytes: 0,
          summary: summarizeCall(event.tool, event.args),
          observes: [],
          marks: [],
          parent,
          children: [],
        };
        callById.set(call.id, call);
        calls.push(call);
        if (parent) parent.children.push(call);
        else {
          agent.calls.push(call);
          agent.items.push({ kind: "call", t: event.t, call });
        }
        times.add(event.t);
        break;
      }
      case "call.end": {
        const call = callById.get(event.call);
        if (!call) break;
        call.end = event.t;
        call.finished = true;
        call.ok = event.ok;
        call.output = event.output;
        call.outputBytes = event.outputBytes;
        times.add(event.t);
        break;
      }
      case "message": {
        agentById.get(event.agent)?.items.push({ kind: "message", t: event.t, message: event });
        times.add(event.t);
        break;
      }
      case "observe": {
        callById.get(event.call)?.observes.push(event);
        break;
      }
      case "file.change": {
        const file = fileById.get(event.file);
        if (!file) break;
        pendingChanges.push({ file, change: event });
        times.add(event.t);
        editTimes.push(event.t);
        break;
      }
    }
  }

  for (const { file, change } of pendingChanges) {
    const marks = change.hunks.map((hunk): Mark => {
      const cause = hunk.cause;
      const call = cause.call ? (callById.get(cause.call) ?? null) : null;
      const agent = cause.agent ? (agentById.get(cause.agent) ?? null) : (call?.agent ?? null);
      const candidates = (cause.candidates ?? [])
        .map((candidate) => callById.get(candidate.call))
        .filter((candidate): candidate is Call => !!candidate);
      const mark: Mark = {
        t: change.t,
        confidence: cause.confidence,
        agent: cause.confidence === "ambiguous" || cause.confidence === "external" ? null : agent,
        call: cause.confidence === "ambiguous" || cause.confidence === "external" ? null : call,
        candidates,
        file,
        change,
        hunk,
      };
      mark.call?.marks.push(mark);
      mark.agent?.marks.push(mark);
      return mark;
    });
    file.changes.push(change);
    file.times.push(change.t);
    file.hunkMarks.push(marks);
  }
  for (const file of files) file.finalize();

  // Lanes: interval coloring, so concurrent agents never share a lane.
  const laneEnds: number[] = [];
  const order = [...agents].sort((a, b) => a.info.startMs - b.info.startMs || a.index - b.index);
  for (const agent of order) {
    let lane = laneEnds.findIndex((end) => end <= agent.info.startMs);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = agent.info.endMs + 400;
    agent.lane = lane;
  }
  const laneCalls: Call[][] = laneEnds.map(() => []);
  for (const call of calls) if (!call.parent) laneCalls[call.agent.lane]?.push(call);

  const duration = Math.max(
    header.run.durationMs || 0,
    lastTime,
    ...agents.map((agent) => agent.info.endMs),
  );
  return {
    header,
    duration,
    agents,
    agentById,
    calls,
    callById,
    files,
    laneCount: Math.max(1, laneEnds.length),
    laneCalls,
    eventTimes: [...times].sort((a, b) => a - b),
    editTimes,
  };
}

/** Status of an agent at time t. */
export function agentPhase(agent: Agent, t: number): "waiting" | "active" | "finished" {
  if (t < agent.info.startMs) return "waiting";
  if (t < agent.info.endMs) return "active";
  return "finished";
}

/** The agent's latest top-level call started at or before t. */
export function currentCall(agent: Agent, t: number): Call | null {
  const index = lastAtOrBefore(agent.calls, t, (call) => call.start);
  return agent.calls[index] ?? null;
}

/** The innermost call running or last started at t: a script's latest nested call, else the call. */
export function innermostCall(call: Call, t: number): Call {
  const index = lastAtOrBefore(call.children, t, (child) => child.start);
  return call.children[index] ?? call;
}

/** The top-level call that contains a call (itself when it has no parent). */
export const rootCall = (call: Call): Call => (call.parent ? rootCall(call.parent) : call);

/** True when the mark was made by the selected call or by a call its script made. */
export const markSelected = (mark: Mark, selected: string | null) =>
  !!selected && !!mark.call && (mark.call.id === selected || mark.call.parent?.id === selected);

/** Observations of a call and of the calls its script made. */
export function callObserves(call: Call): ObserveEvent[] {
  if (!call.children.length) return call.observes;
  return [...call.observes, ...call.children.flatMap(callObserves)];
}

export function visibleItems(agent: Agent, t: number) {
  return lastAtOrBefore(agent.items, t, (item) => item.t) + 1;
}

export function lastAssistantMessage(agent: Agent, t: number): MessageEvent | null {
  for (let index = visibleItems(agent, t) - 1; index >= 0; index--) {
    const item = agent.items[index];
    if (item?.kind === "message" && item.message.role === "assistant" && item.message.text.trim())
      return item.message;
  }
  return null;
}
