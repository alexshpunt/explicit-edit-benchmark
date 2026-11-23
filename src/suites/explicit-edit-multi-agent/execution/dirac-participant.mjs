import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { cliParticipant } from "./cli-participant.mjs";
import { participantSandboxArgs, writeSandboxAccounts } from "./participant-sandbox.mjs";

export const DIRAC_HARNESS = "dirac-default";
const PACKAGE = "node_modules/dirac-cli";

/** Whether a participant config selects Dirac. */
export const isDiracParticipant = (config) => config?.harness === DIRAC_HARNESS;

/** Resolve a Dirac participant without starting a process or reading credentials.
 * The runtime holds `dirac-cli`; `authFile` is a Dirac `secrets.json` with the
 * provider's credentials, copied to the participant's own Dirac home.
 */
export async function resolveDiracParticipantProfile(config) {
  const keys = new Set(["runtime", "model", "thinking", "harness", "authFile"]);
  assert.ok(
    Object.keys(config).every((key) => keys.has(key)),
    "Unknown Dirac participant configuration key",
  );
  assert.equal(config.harness, DIRAC_HARNESS);
  assert.ok(
    typeof config.runtime === "string" &&
      typeof config.model === "string" &&
      config.model.includes("/"),
    "Explicit runtime and provider/model are required",
  );
  assert.ok(
    ["minimal", "low", "medium", "high", "xhigh"].includes(config.thinking),
    "Dirac takes a reasoning effort: minimal, low, medium, high or xhigh",
  );
  assert.equal(typeof config.authFile, "string", "Dirac needs a secrets.json authFile");
  const runtime = await realpath(config.runtime);
  const manifest = JSON.parse(await readFile(path.join(runtime, PACKAGE, "package.json"), "utf8"));
  assert.equal(manifest.name, "dirac-cli");
  return { runtime, version: manifest.version };
}

/** Arguments of one unattended Dirac delivery inside the sandbox. */
export function diracCommand(config, prompt) {
  const slash = config.model.indexOf("/");
  return [
    "/usr/bin/node",
    `/runtime/${PACKAGE}/dist/cli.mjs`,
    "--yolo",
    "--json",
    "--config",
    "/state/dirac",
    "--provider",
    config.model.slice(0, slash),
    "--model",
    config.model.slice(slash + 1),
    "--reasoning-effort",
    config.thinking,
    prompt,
  ];
}

const FINISHED = new Set(["success", "error", "failed", "cancelled", "rejected"]);

const textOf = (card) =>
  [
    card.header,
    card.body,
    ...(card.diffs ?? []).map(
      (diff) => `--- ${diff.path}\n${diff.oldText ?? ""}\n+++ ${diff.path}\n${diff.newText ?? ""}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");

/** Turn Dirac's `--json` records into Pi-shaped events; assistant text is an
 * `assistant_text` event because its usage is reported separately. Dirac repeats a record with
 * the same id as it changes: a card moves from `running` to a final status, and
 * streamed markdown grows. A card's first record starts its tool call. Its result is
 * what the model saw: the `[Tool]` text of the next API request, which carries the
 * results of every call that finished since the previous request, so a finished call
 * ends when that request starts. A tool result without a card, such as a call Dirac
 * rejected before running it, becomes a call of its own. Markdown is emitted once,
 * when a record with another id follows. Completed API requests carry the token usage.
 */
export function diracNormalizer() {
  const started = new Set();
  const ended = new Set();
  const usage = new Set();
  const requests = new Set();
  /** @type {Array<{ id: string, toolName: string, isError: boolean, card: any }>} */
  let finished = [];
  let synthetic = 0;
  let pending;
  const endCall = ({ id, toolName, isError, card }, seen) => {
    const diff = (card.diffs ?? []).length ? textOf({ diffs: card.diffs }) : "";
    const text = seen ? [seen, diff].filter(Boolean).join("\n\n") : textOf(card);
    return {
      type: "tool_execution_end",
      toolCallId: id,
      toolName,
      isError,
      result: { content: [{ type: "text", text }], isError },
    };
  };
  const toolResult = (status) => {
    const request = String(status.request ?? "");
    if (!request.startsWith("[Tool]") || requests.has(status.id)) return [];
    requests.add(status.id);
    const seen = request
      .replace(/\n*Loading\.\.\.$/, "")
      .slice("[Tool]".length)
      .trim();
    if (finished.length) {
      const out = finished.map((call) => endCall(call, seen));
      finished = [];
      return out;
    }
    const id = `dirac-unreported-${++synthetic}`;
    const isError = /tool execution failed|<error>/i.test(seen);
    const named = /\b(AST edit|AST inspect|edit|read|search|command|write)\b/i.exec(seen)?.[1];
    const toolName =
      { "ast edit": "edit_ast", "ast inspect": "inspect_ast", command: "execute_command" }[
        named?.toLowerCase() ?? ""
      ] ?? "dirac_tool";
    return [
      { type: "tool_execution_start", toolCallId: id, toolName, args: { unreported: true } },
      {
        type: "tool_execution_end",
        toolCallId: id,
        toolName,
        isError,
        result: { content: [{ type: "text", text: seen }], isError },
      },
    ];
  };
  const flush = () => {
    if (!pending) return [];
    const { role, text, thinking, ts } = pending;
    pending = undefined;
    const content = [
      ...(thinking ? [{ type: "thinking", thinking }] : []),
      ...(text ? [{ type: "text", text }] : []),
    ];
    if (!content.length) return [];
    // Usage arrives in separate records, and an assistant message without usage would
    // make the run's usage unknown, so assistant text has its own event type.
    const type = role === "user" ? "message_end" : "assistant_text";
    return [{ type, message: { role, content, timestamp: ts } }];
  };
  const normalize = (record) => {
    if (record?.type === "task_started")
      return [{ type: "session", id: String(record.taskId) }, { type: "agent_start" }];
    const content = record?.content;
    if (!content || typeof content !== "object") return [{ type: "dirac", record }];
    const out = [];
    if (pending && pending.id !== record.id) out.push(...flush());
    if (content.type === "markdown") {
      const role = content.role === "user" ? "user" : "assistant";
      const text = String(content.content ?? "");
      const previous = pending?.id === record.id ? pending : undefined;
      pending = {
        id: record.id,
        ts: record.ts,
        role,
        text: content.isReasoning ? (previous?.text ?? "") : text,
        thinking: content.isReasoning ? text : (previous?.thinking ?? ""),
      };
      return out;
    }
    if (content.type === "api_status") {
      const status = content.status ?? {};
      out.push(...toolResult(status));
      if (Number.isFinite(status.tokensIn) && !usage.has(status.id)) {
        usage.add(status.id);
        const input = status.tokensIn;
        const output = status.tokensOut ?? 0;
        const cacheRead = status.cacheReads ?? 0;
        const cacheWrite = status.cacheWrites ?? 0;
        out.push({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            timestamp: record.ts,
            stopReason: status.error ? "error" : "toolUse",
            ...(status.error ? { errorMessage: String(status.error) } : {}),
            usage: {
              input,
              output,
              cacheRead,
              cacheWrite,
              totalTokens: input + output + cacheRead + cacheWrite,
              cost: { total: status.cost ?? 0 },
            },
          },
        });
      }
      return out;
    }
    if (content.type === "card") {
      const card = content.card ?? {};
      const id = String(card.id ?? record.id);
      if (card.toolName === "respond") {
        if (FINISHED.has(card.status) && !ended.has(id)) {
          ended.add(id);
          out.push({
            type: "assistant_text",
            message: {
              role: "assistant",
              content: [{ type: "text", text: String(card.body ?? "") }],
              timestamp: record.ts,
            },
          });
        }
        return out;
      }
      if (!card.toolName) return out;
      if (!started.has(id)) {
        started.add(id);
        out.push({
          type: "tool_execution_start",
          toolCallId: id,
          toolName: card.toolName,
          args: {
            ...(card.rawInput && typeof card.rawInput === "object" ? card.rawInput : {}),
            header: card.header,
            ...(card.locations?.length ? { path: card.locations[0].path } : {}),
          },
        });
      }
      if (FINISHED.has(card.status) && !ended.has(id)) {
        ended.add(id);
        finished.push({ id, toolName: card.toolName, isError: card.status !== "success", card });
      }
      return out;
    }
    return out;
  };
  /** After the process exits: pending text, unfinished calls and the end of the run. */
  const finish = ({ code }) => {
    const out = [...flush(), ...finished.map((call) => endCall(call, ""))];
    finished = [];
    for (const id of started)
      if (!ended.has(id))
        out.push({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "unknown",
          isError: true,
          result: { content: [{ type: "text", text: "(Dirac stopped before the call finished)" }] },
        });
    if (code === 0) out.push({ type: "agent_end", willRetry: false }, { type: "agent_settled" });
    return out;
  };
  return { normalize, finish };
}

/** One Dirac participant in the same sandbox as native Pi participants. Each delivery
 * runs one `dirac --yolo --json` process with its own Dirac home. Native records go to
 * `<eventsFile without .jsonl>-native.jsonl`; Pi-shaped events go to eventsFile.
 */
export async function startDiracParticipant(
  workspace,
  stateDirectory,
  config,
  { eventsFile, signal, sharedSandbox, onProviderFailure } = {},
) {
  signal?.throwIfAborted();
  const { runtime, version } = await resolveDiracParticipantProfile(config);
  const state = path.resolve(stateDirectory);
  await mkdir(state, { mode: 0o700 });
  await mkdir(path.join(state, "dirac", "data"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(state, "home"));
  await copyFile(config.authFile, path.join(state, "dirac", "data", "secrets.json"));
  const accounts = await writeSandboxAccounts(state);
  const sandboxArgs = await participantSandboxArgs({
    sharedSandbox,
    accounts,
    runtime,
    state,
    workspace,
    environment: {
      PATH: "/runtime/node_modules/.bin:/usr/bin:/bin",
      DIRAC_DIR: "/state/dirac",
      DIRAC_NO_AUTO_UPDATE: "1",
      DIRAC_NO_EMOJI: "1",
      SHELL: "/bin/bash",
    },
  });
  const { normalize, finish } = diracNormalizer();
  return cliParticipant({
    name: "Dirac",
    version,
    config,
    sandboxArgs,
    command: (prompt) => diracCommand(config, prompt),
    normalize,
    finish,
    sharedSandbox,
    eventsFile,
    nativeFile: eventsFile?.replace(/\.jsonl$/, "") + "-native.jsonl",
    onProviderFailure,
  });
}
