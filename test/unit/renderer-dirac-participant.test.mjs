import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  diracCommand,
  diracNormalizer,
  isDiracParticipant,
  resolveDiracParticipantProfile,
} from "../../src/suites/explicit-edit-multi-agent/execution/dirac-participant.mjs";
import { finalizedUsage } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";

const config = (runtime, extra = {}) => ({
  runtime,
  model: "openai-codex/gpt-6.2-sol",
  thinking: "low",
  harness: "dirac-default",
  authFile: "/private/secrets.json",
  ...extra,
});

// The shapes of a real `dirac --yolo --json` run: repeated records per id, a rejected
// call without a card, a read and an edit card, usage on finished requests.
const request = (id, ts, text, tokensIn) => ({
  id,
  ts,
  content: {
    type: "api_status",
    status: {
      id,
      request: tokensIn === undefined ? `${text}\n\nLoading...` : text,
      ...(tokensIn === undefined ? {} : { tokensIn, tokensOut: 30, cacheReads: 5000, cost: 0 }),
    },
  },
});
const card = (id, ts, toolName, status, extra = {}) => ({
  id,
  ts,
  content: {
    type: "card",
    card: { id, toolName, status, header: `${toolName} main.cpp`, ...extra },
  },
});
const stream = [
  { type: "task_started", taskId: "17" },
  {
    id: "u",
    ts: 1,
    content: { type: "markdown", role: "user", content: "Rename a.", isReasoning: false },
  },
  request("r1", 2, "<task>Rename a.</task>"),
  request("r1", 2, "<task>Rename a.</task>", 900),
  request(
    "r2",
    3,
    "[Tool]\nThe tool execution failed with the following error:\n<error>\nAST edit failed\n</error>",
  ),
  request("r2", 3, "[Tool]\nThe tool execution failed", 100),
  card("c1", 4, "read_file", "running", { locations: [{ path: "main.cpp" }] }),
  card("c1", 4, "read_file", "success", { locations: [{ path: "main.cpp" }] }),
  request("r3", 5, "[Tool]\n[File Hash: 1]\nKeep§int a = 1;"),
  request("r3", 5, "[Tool]\n[File Hash: 1]\nKeep§int a = 1;", 50),
  card("c2", 6, "edit_file", "running"),
  card("c2", 6, "edit_file", "success", {
    diffs: [{ path: "main.cpp", oldText: "int a = 1;\n", newText: "int b = 1;\n" }],
  }),
  request("r4", 7, "[Tool]\nApplied 1 edit(s) successfully"),
  card("c3", 8, "respond", "running", { body: "Renamed a." }),
  card("c3", 8, "respond", "success", { body: "Renamed a." }),
];

test("Dirac records become Pi-shaped events with what the model saw", () => {
  const { normalize, finish } = diracNormalizer();
  const events = [...stream.flatMap(normalize), ...finish({ code: 0 })];
  const calls = events.filter((e) => e.type === "tool_execution_start");
  assert.deepEqual(
    calls.map((e) => [e.toolCallId, e.toolName]),
    [
      ["dirac-unreported-1", "edit_ast"],
      ["c1", "read_file"],
      ["c2", "edit_file"],
    ],
  );
  const ends = Object.fromEntries(
    events.filter((e) => e.type === "tool_execution_end").map((e) => [e.toolCallId, e]),
  );
  assert.equal(ends["dirac-unreported-1"].isError, true);
  assert.equal(ends.c1.result.content[0].text, "[File Hash: 1]\nKeep§int a = 1;");
  assert.match(ends.c2.result.content[0].text, /^Applied 1 edit\(s\) successfully/);
  assert.match(ends.c2.result.content[0].text, /\+\+\+ main\.cpp\nint b = 1;/);
  // Each end follows its own start, and every call ends once.
  for (const call of calls) assert.ok(events.indexOf(ends[call.toolCallId]) > events.indexOf(call));
  assert.equal(events.filter((e) => e.type === "tool_execution_end").length, 3);
  const user = events.find((e) => e.type === "message_end" && e.message.role === "user");
  assert.deepEqual(user.message.content, [{ type: "text", text: "Rename a." }]);
  const said = events.filter((e) => e.type === "assistant_text");
  assert.equal(said.at(-1).message.content[0].text, "Renamed a.");
  // Every assistant message_end carries usage, so the run's usage stays known.
  assert.ok(
    events
      .filter((e) => e.type === "message_end" && e.message.role === "assistant")
      .every((e) => e.message.usage.totalTokens > 0),
  );
  assert.deepEqual(finalizedUsage(events), {
    input: 1050,
    output: 90,
    cacheRead: 15000,
    cacheWrite: 0,
    totalTokens: 16140,
    cost: 0,
  });
  assert.deepEqual(
    events.slice(-2).map((e) => e.type),
    ["agent_end", "agent_settled"],
  );
});

test("a killed Dirac run ends its open calls and does not claim to finish", () => {
  const { normalize, finish } = diracNormalizer();
  const events = [stream[0], card("c9", 1, "execute_command", "running")].flatMap(normalize);
  const tail = finish({ code: null });
  assert.deepEqual(
    tail.map((e) => [e.type, e.toolCallId, e.isError]),
    [["tool_execution_end", "c9", true]],
  );
  assert.equal(events.at(-1).type, "tool_execution_start");
});

test("a Dirac participant resolves its runtime and runs unattended with the model's provider", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderer-dirac-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "node_modules/dirac-cli"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules/dirac-cli/package.json"),
    JSON.stringify({ name: "dirac-cli", version: "0.6.1" }),
  );
  assert.equal(isDiracParticipant(config(root)), true);
  assert.equal((await resolveDiracParticipantProfile(config(root))).version, "0.6.1");
  await assert.rejects(resolveDiracParticipantProfile(config(root, { thinking: "off" })), {
    code: "ERR_ASSERTION",
  });
  await assert.rejects(resolveDiracParticipantProfile(config(root, { toolchain: "hidden" })), {
    code: "ERR_ASSERTION",
  });
  const args = diracCommand(config(root), "Rename a.");
  assert.deepEqual(args.slice(2), [
    "--yolo",
    "--json",
    "--config",
    "/state/dirac",
    "--provider",
    "openai-codex",
    "--model",
    "gpt-6.2-sol",
    "--reasoning-effort",
    "low",
    "Rename a.",
  ]);
});

test("the Dirac harness without Bash disables commands and the skills that create command tools", () => {
  const noBash = config("/unused", { harness: "dirac-no-bash" });
  assert.equal(isDiracParticipant(noBash), true);
  assert.equal(isDiracParticipant({ harness: "dirac" }), false);
  assert.deepEqual(diracCommand(noBash, "Rename a.").slice(-3), [
    "--disable-tool",
    "execute_command,use_skill",
    "Rename a.",
  ]);
});
