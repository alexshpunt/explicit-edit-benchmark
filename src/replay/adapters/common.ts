import type { ToolCategory, TraceEvent } from "../trace/types.ts";

/**
 * The adapter boundary. An adapter reads one harness's native output for one agent and
 * returns agent events (no file changes, no seq) on the epoch clock, in milliseconds.
 * Sources merge the events of all agents with recorded file changes, run attribution,
 * shift times to the run start and number the events.
 */
type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
export type AgentEvent = WithoutSeq<Exclude<TraceEvent, { kind: "file.change" }>>;

export interface AdapterContext {
  /** Trace id of the agent; call ids are prefixed with it. */
  agent: string;
  /** Watched files: trace id and the path suffix that identifies it in tool arguments and output. */
  files: Array<{ id: string; path: string }>;
}

const CATEGORY: Record<string, ToolCategory> = {
  read: "read",
  read_file: "read",
  outline: "read",
  inspect_ast: "search",
  search_files: "search",
  list_files: "search",
  replace_match: "edit",
  undo_last_change: "edit",
  edit_file: "edit",
  edit_ast: "edit",
  write_to_file: "edit",
  execute_command: "shell",
  view: "read",
  search: "search",
  file_search: "search",
  ast_search: "search",
  lsp_search: "search",
  grep: "search",
  find: "search",
  glob: "search",
  ls: "search",
  tool_search: "other",
  write: "edit",
  edit: "edit",
  replace: "edit",
  insert: "edit",
  delete: "edit",
  copy: "edit",
  move: "edit",
  undo: "edit",
  apply_patch: "edit",
  multi_edit: "edit",
  file_change: "edit",
  str_replace_editor: "edit",
  bash: "shell",
  shell: "shell",
  command_execution: "shell",
  exec_command: "shell",
  codemode: "script",
  eval: "script",
  python: "script",
};

export function toolCategory(tool: string): ToolCategory {
  return CATEGORY[tool] ?? "other";
}

const SHELL_WRITE =
  /(?:^|[^<0-9&])>{1,2}\s*(?!\/dev\/|\/tmp\/|&)\S|\b(?:sed|perl)\s+[^;&|]*-i\b|\btee\b|(?:^|[;&|(]\s*|\s)(?:mv|cp|rm|truncate|patch|ed|ex)\s|\bgit\s+(?:apply|checkout|restore)\b|\b(?:python\d*|node|perl|ruby|php)\b/;
// Pi Agent IDE's Codemode calls `tools.*`; Oh My Pi's eval calls `tool.*`, `sh` and Bun.
const SCRIPT_WRITE =
  /\btools?\.(?:write|edit|replace|insert|delete|copy|move|undo|bash)\b|\bwriteFile|\bfs\.|\bBun\.write\b|\bsh`|\bwrite_(?:text|bytes)\b|\bsubprocess\b|\bos\.system\b/;

/** Whether a call can change files. Shell commands and scripts count when they look like they write. */
export function mayMutate(category: ToolCategory, args?: unknown): boolean {
  if (category === "edit") return true;
  if (category !== "shell" && category !== "script") return false;
  const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const source = [record.command, record.code, record.script, record.cmd]
    .filter((value) => typeof value === "string")
    .join("\n");
  if (!source) return true;
  return (category === "shell" ? SHELL_WRITE : SCRIPT_WRITE).test(source);
}

/** Keep both ends of long text; the page needs the gist, not megabytes. */
export function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n… ${text.length - head - tail} characters omitted …\n${text.slice(-tail)}`;
}

export function clipArgs(value: unknown, max = 6000): unknown {
  if (typeof value === "string") return clip(value, max);
  if (Array.isArray(value)) return value.map((item) => clipArgs(item, max));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clipArgs(item, max)]),
    );
  return value;
}

/** Merge 1-based inclusive ranges. */
export function mergeRanges(ranges: Array<[number, number]>) {
  const sorted = ranges.filter(([a, b]) => a >= 1 && b >= a).sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lines of watched files that a call showed its agent: explicit read ranges and
 * `path:line` references in the output (search hits, compiler messages, grep -n with a path).
 */
export function observedRanges(
  context: AdapterContext,
  tool: string,
  args: unknown,
  output: string,
): Array<{ file: string; ranges: Array<[number, number]> }> {
  const result = [];
  for (const file of context.files) {
    const name = file.path.split("/").at(-1) ?? file.path;
    const ranges: Array<[number, number]> = [];
    const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const target = typeof record.path === "string" ? record.path : "";
    // Oh My Pi names ranges in the path: `main.cpp:2787,2823-2842`.
    const inline = new RegExp(`${escape(name)}:([\\d,\\s-]+)$`).exec(target);
    if (toolCategory(tool) === "read" && inline?.[1] !== undefined) {
      for (const part of inline[1].split(",")) {
        const [a, b = a] = part.trim().split("-").map(Number);
        if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b))
          ranges.push([a, b]);
      }
    } else if (toolCategory(tool) === "read" && target.endsWith(name)) {
      const offset = typeof record.offset === "number" && record.offset > 0 ? record.offset : 1;
      const shown = output.split("\n").length;
      const limit = typeof record.limit === "number" ? Math.min(record.limit, shown) : shown;
      ranges.push([offset, offset + Math.max(limit, 1) - 1]);
    }
    const reference = new RegExp(`${escape(name)}:(\\d+)`, "g");
    for (const match of output.matchAll(reference)) {
      const line = Number(match[1]);
      ranges.push([line, line]);
    }
    // Oh My Pi prints numbered lines under a `[main.cpp#HASH]` header: `1533:text`, `*1533:hit`.
    for (const section of output.split(/^(?=\[[^\]\n]+#[0-9A-F]{4}\])/m)) {
      if (!section.startsWith(`[${name}#`) && !section.includes(`/${name}#`)) continue;
      for (const match of section.matchAll(/^\*?(\d+):/gm)) {
        const line = Number(match[1]);
        ranges.push([line, line]);
      }
    }
    if (tool === "bash" || tool === "shell" || tool === "command_execution") {
      const command = typeof record.command === "string" ? record.command : "";
      if (command.includes(name))
        for (const match of command.matchAll(/sed -n ['"]?(\d+),(\d+)p/g))
          ranges.push([Number(match[1]), Number(match[2])]);
    }
    const merged = mergeRanges(ranges);
    if (merged.length) result.push({ file: file.id, ranges: merged });
  }
  return result;
}
