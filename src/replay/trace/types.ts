/**
 * The common trace format. Every harness adapter and every source maps into it, and the
 * viewer reads only this. A trace is stored as a directory:
 *
 *   trace.json    TraceHeader
 *   events.jsonl  TraceEvent, one per line, ordered by t then seq
 *   blobs/        content-addressed text: blobs/<sha256>.txt
 *
 * `packTrace` turns a directory into one PackedTrace object for the page.
 * Times are milliseconds from the run start (`run.startedAt`).
 */

export const TRACE_FORMAT = "agent-replay/trace@1";

/** A sha256 of UTF-8 text stored in blobs/. */
export type BlobRef = { blob: string };

export interface TraceHeader {
  format: typeof TRACE_FORMAT;
  scenario: Scenario;
  run: RunInfo;
  agents: AgentInfo[];
  files: FileInfo[];
}

export interface Scenario {
  title: string;
  /** What the agents were asked to do as a whole, in prose. */
  task: string;
  /** Globs of watched files, relative to the workspace. */
  scope: string[];
}

export interface RunInfo {
  /** Harness id, such as "pi-agent-ide" or "pi-bash". */
  harness: string;
  harnessLabel: string;
  harnessVersion?: string;
  model?: string;
  thinking?: string;
  /** Where the trace came from, such as "mixed-probe:<run id>". */
  source: string;
  startedAt: string;
  durationMs: number;
  /** Free-form outcome facts shown in the page, such as checks passed. */
  outcome?: Record<string, string | number | boolean | null>;
}

export interface AgentInfo {
  id: string;
  /** Short title of the agent's task, such as "Rename tVec4i". */
  label: string;
  /** The task prompt as the agent received it. */
  task?: string;
  harness: string;
  model?: string;
  startMs: number;
  endMs: number;
  status: "done" | "failed" | "timed-out" | "running";
  usage?: Usage;
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: number;
}

export interface FileInfo {
  id: string;
  /** Path relative to the workspace. */
  path: string;
  /** CodeMirror language hint: "cpp", "ts", "text"... */
  language: string;
  initial: BlobRef;
}

export type ToolCategory = "read" | "search" | "edit" | "shell" | "script" | "other";

export type TraceEvent =
  | AgentStartEvent
  | AgentEndEvent
  | MessageEvent
  | CallStartEvent
  | CallEndEvent
  | ObserveEvent
  | FileChangeEvent;

interface Base {
  t: number;
  seq: number;
}

export interface AgentStartEvent extends Base {
  kind: "agent.start";
  agent: string;
}

export interface AgentEndEvent extends Base {
  kind: "agent.end";
  agent: string;
  status: AgentInfo["status"];
}

export interface MessageEvent extends Base {
  kind: "message";
  agent: string;
  role: "user" | "assistant";
  text: string;
  /** Visible reasoning summary, when the harness exposes one. */
  thinking?: string;
}

export interface CallStartEvent extends Base {
  kind: "call.start";
  agent: string;
  /** Unique within the trace. */
  call: string;
  tool: string;
  category: ToolCategory;
  /** Native arguments; long strings may be shortened by the adapter. */
  args: unknown;
  /** True when the call can change files: edit tools, and shells or scripts that may write. */
  mutating: boolean;
  /** The enclosing call, for calls made inside a script tool such as Codemode. */
  parent?: string;
}

export interface CallEndEvent extends Base {
  kind: "call.end";
  agent: string;
  call: string;
  ok: boolean;
  /** What the agent saw as the result. May be shortened; see outputBytes. */
  output: string;
  outputBytes: number;
}

/** Lines of a watched file that a call showed to its agent. Ranges are 1-based, inclusive. */
export interface ObserveEvent extends Base {
  kind: "observe";
  agent: string;
  call: string;
  file: string;
  ranges: Array<[number, number]>;
}

export interface FileChangeEvent extends Base {
  kind: "file.change";
  file: string;
  /** 1 for the first change after the initial content. */
  version: number;
  hunks: Hunk[];
  /** Line count after the change. */
  lines: number;
  sha256: string;
}

/** Replace `remove` lines starting at 0-based `at` of the previous version with `insert`. */
export interface Hunk {
  at: number;
  remove: number;
  /** The removed lines, so the change can be shown and reversed without the old version. */
  removed: string[];
  insert: string[];
  cause: Cause;
}

export interface Cause {
  /** exact: one mutating call was running; matched: several, the hunk text matched one;
   * ambiguous: several remain; external: no agent call was running. */
  confidence: "exact" | "matched" | "ambiguous" | "external";
  agent?: string;
  call?: string;
  /** Every call that could have made the change, for matched and ambiguous. */
  candidates?: Array<{ agent: string; call: string }>;
}

/** Everything the page needs, in one object. Blobs used by the header are inlined. */
export interface PackedTrace {
  header: TraceHeader;
  blobs: Record<string, string>;
  events: TraceEvent[];
}
