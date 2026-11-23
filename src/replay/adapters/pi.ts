import {
  clip,
  clipArgs,
  mayMutate,
  observedRanges,
  toolCategory,
  type AdapterContext,
  type AgentEvent,
} from "./common.ts";

/**
 * Pi adapter: Pi RPC events (`pi --mode rpc` stdout, as the Explicit Edit benchmark keeps
 * them in session-N-events.jsonl). Covers plain Pi and Pi with Pi Agent IDE; the IDE only
 * adds tools. Each record may carry `at`, the epoch time the line was written, from the
 * recorder's stream log. Without it, times come from message timestamps.
 */
interface PiContentPart {
  type?: string;
  text?: string;
  thinking?: string;
}

interface PiMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
}

/** The fields of a Pi RPC event the adapter reads; everything else is ignored. */
export interface PiEvent {
  type?: string;
  message?: PiMessage;
  toolCallId?: string | number;
  toolName?: string;
  args?: unknown;
  result?: { content?: unknown; isError?: boolean };
  isError?: boolean;
  willRetry?: boolean;
  aborted?: boolean;
}

export interface PiRecord {
  event: PiEvent | null;
  at?: number;
}

const OUTPUT_LIMIT = 24_000;

const SYSTEM_RESULT = /<system-result[\s\S]*?<\/system-result>\s*/g;

function textOf(content: unknown, type = "text"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<PiContentPart | null>)
    .filter((part) => part?.type === type)
    .map((part) => (type === "thinking" ? part?.thinking : part?.text) ?? "")
    .join("\n")
    .trim();
}

export function piRpcEvents(records: PiRecord[], context: AdapterContext): AgentEvent[] {
  const { agent } = context;
  // A tool result message is written right after its tool_execution_end, with a timestamp.
  const resultTimes = new Map<string, number>();
  for (const { event } of records) {
    const message = event?.message;
    if (
      event?.type === "message_end" &&
      message?.role === "toolResult" &&
      message.toolCallId !== undefined &&
      message.timestamp !== undefined
    )
      resultTimes.set(message.toolCallId, message.timestamp);
  }

  const out: AgentEvent[] = [];
  let clock = -Infinity;
  const time = (at: number | undefined, fallback: number | undefined) => {
    const value = at ?? fallback ?? clock;
    clock = Math.max(clock, value);
    return clock;
  };
  const started = new Map<string, { tool: string; args: unknown }>();
  const known = new Set<string>();
  const id = (call: string) => `${agent}:${call}`;
  let ended = false;

  for (const { event, at } of records) {
    switch (event?.type) {
      case "agent_start": {
        out.push({ kind: "agent.start", agent, t: time(at, undefined) });
        break;
      }
      // Converted streams (the benchmark's Dirac participant) put assistant text, whose
      // usage arrives separately, in its own event; it reads like a message.
      case "assistant_text":
      case "message_end": {
        const message = event.message;
        if (message?.role !== "user" && message?.role !== "assistant") {
          time(at, message?.timestamp);
          break;
        }
        const t = time(at, message.timestamp);
        const text = textOf(message.content);
        const thinking = message.role === "assistant" ? textOf(message.content, "thinking") : "";
        if (text || thinking)
          out.push({
            kind: "message",
            agent,
            t,
            role: message.role,
            text,
            ...(thinking ? { thinking: clip(thinking, 4000) } : {}),
          });
        break;
      }
      case "tool_execution_start": {
        const call = String(event.toolCallId);
        const tool = event.toolName ?? "";
        const category = toolCategory(tool);
        started.set(call, { tool, args: event.args });
        // Codemode reports the tools its script calls as `<codemode call id>/<n>`.
        const slash = call.lastIndexOf("/");
        const parent =
          slash > 0 && known.has(call.slice(0, slash)) ? id(call.slice(0, slash)) : undefined;
        known.add(call);
        out.push({
          kind: "call.start",
          agent,
          t: time(at, undefined),
          call: id(call),
          tool,
          category,
          args: clipArgs(event.args),
          mutating: mayMutate(category, event.args),
          ...(parent ? { parent } : {}),
        });
        break;
      }
      case "tool_execution_end": {
        const call = String(event.toolCallId);
        const start = started.get(call);
        if (!start) break;
        started.delete(call);
        const raw = textOf(event.result?.content).replace(SYSTEM_RESULT, "");
        const t = time(at, resultTimes.get(call));
        const isError = event.isError === true || event.result?.isError === true;
        out.push({
          kind: "call.end",
          agent,
          t,
          call: id(call),
          ok: !isError,
          output: clip(raw, OUTPUT_LIMIT),
          outputBytes: Buffer.byteLength(raw),
        });
        for (const seen of observedRanges(context, start.tool, start.args, raw))
          out.push({ kind: "observe", agent, t, call: id(call), ...seen });
        break;
      }
      case "agent_settled":
      case "agent_end": {
        if (!ended && (event.type === "agent_settled" || event.willRetry === false)) {
          ended = true;
          out.push({
            kind: "agent.end",
            agent,
            t: time(at, undefined),
            status: event.aborted === true ? "failed" : "done",
          });
        }
        break;
      }
      default: {
        if (at !== undefined) time(at, undefined);
      }
    }
  }
  // Calls the agent never finished (killed or timed out) end with the agent.
  for (const [call] of started)
    out.push({
      kind: "call.end",
      agent,
      t: clock,
      call: id(call),
      ok: false,
      output: "(no result: the agent stopped before the call finished)",
      outputBytes: 0,
    });
  return out.filter((event) => Number.isFinite(event.t));
}
