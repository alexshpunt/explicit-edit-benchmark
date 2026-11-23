/** Text helpers for the page: call summaries, times, sizes. */

type Args = Record<string, unknown>;

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(text).join(", ");
  if (typeof value === "object" && "id" in value) return String(value.id);
  return JSON.stringify(value);
};

const shortPath = (value: unknown) => text(value).replace(/^\/workspace\//, "");

export const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function clip(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
}

const quote = (value: string) => `“${clip(oneLine(value), 48)}”`;

function firstLine(value: string) {
  const lines = value.split("\n");
  const first = lines.find((line) => line.trim()) ?? "";
  const more = lines.filter((line) => line.trim()).length - 1;
  return { first: first.trim(), more };
}

/** First line of a script that says what it does: skips blanks, comments and option headers. */
function meaningfulLine(code: string) {
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    if (/^(const|let|var)\s+\w+\s*=\s*\[\s*$/.test(line)) continue;
    return line;
  }
  return "";
}

function edited(args: Args) {
  const { first, more } = firstLine(text(args.text ?? args.content ?? ""));
  return `${quote(first)}${more > 0 ? ` +${more} lines` : ""}`;
}

/** One line that says what a tool call did, for timeline tooltips and agent cards. */
export function summarizeCall(tool: string, rawArgs: unknown): string {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Args;
  const selection = args.at ?? args.from ?? args.after ?? args.before;
  let summary: string;
  switch (tool) {
    case "read": {
      summary = shortPath(args.path);
      if (args.offset != null || args.limit != null)
        summary += `:${text(args.offset ?? 1)}${args.limit != null ? `+${text(args.limit)}` : ""}`;
      break;
    }
    case "search":
    case "grep": {
      summary = `${quote(text(args.query ?? args.pattern))}${args.path ? ` in ${shortPath(args.path)}` : ""}`;
      break;
    }
    case "file_search":
    case "find":
    case "ast_search": {
      summary = quote(text(args.pattern ?? args.query));
      break;
    }
    case "replace":
    case "edit": {
      summary = selection
        ? `${quote(text(selection))} → ${edited(args)}`
        : `${shortPath(args.path)} → ${edited(args)}`;
      if (args.oldText || args.old_string)
        summary = `${quote(text(args.oldText ?? args.old_string))} → ${quote(text(args.newText ?? args.new_string))}`;
      break;
    }
    case "move":
    case "copy": {
      const target =
        args.target ?? args.targetAfter ?? args.targetBefore ?? args.targetAt ?? args.targetFrom;
      summary = `${quote(text(selection ?? args.path))} → ${quote(text(target ?? args.path))}`;
      break;
    }
    case "insert": {
      summary = `${edited(args)} ${args.after ? `after ${quote(text(args.after))}` : args.before ? `before ${quote(text(args.before))}` : ""}`;
      break;
    }
    case "delete": {
      summary = quote(text(selection ?? args.path));
      break;
    }
    case "write": {
      const lines = text(args.content).split("\n").length;
      summary = `${shortPath(args.path)} (${lines} lines)`;
      break;
    }
    case "bash":
    case "command_execution": {
      summary = firstLine(text(args.command)).first;
      break;
    }
    case "codemode":
    case "eval": {
      summary = meaningfulLine(text(args.code ?? args.script));
      break;
    }
    default: {
      const value = Object.values(args).find((entry) => typeof entry === "string");
      summary = value ? text(value) : "";
    }
  }
  return clip(oneLine(summary), 120);
}

/** Pretty arguments for the transcript, with very long strings shortened. */
export function formatArgs(args: unknown): string {
  return JSON.stringify(
    args,
    (_key, value: unknown) =>
      typeof value === "string" && value.length > 4000
        ? value.slice(0, 4000) + `… (${value.length - 4000} more characters)`
        : value,
    2,
  );
}

/** Tool results carry harness bookkeeping such as <system-result> tags; the page hides it. */
export function cleanOutput(output: string) {
  return output.replace(/<system-result[\s\S]*?<\/system-result>\s*/g, "").replace(/^\s+/, "");
}

export function formatTime(ms: number, precise = false) {
  const negative = ms < 0;
  const total = Math.abs(ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  const secondsText = precise
    ? seconds.toFixed(1).padStart(4, "0")
    : String(Math.floor(seconds)).padStart(2, "0");
  return `${negative ? "−" : ""}${minutes}:${secondsText}`;
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return formatTime(ms);
}

export function formatCount(value: number) {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
