import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { harnessParticipant } from "../../scripts/harness-participant.mjs";
import { teamDeliveryDirectory } from "../../scripts/normalized-team-protocol.mjs";
import { makeAdapter } from "../../scripts/prepare-benchmark.mjs";
import { providerFixture } from "./provider-fixture.mjs";

assert.ok(process.env.RENDERER_PI_RUNTIME, "Set RENDERER_PI_RUNTIME to the installed Pi runtime");

function messageText(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join("");
}

async function setup(t, respond, maxRetries) {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/pi-harness-retry-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  const artifacts = path.join(root, "artifacts");
  let provider, participant;
  t.after(async () => {
    try {
      await participant?.close();
    } finally {
      provider?.close();
      await Promise.all(
        [workspace, state, path.join(root, "models.json")].map((file) =>
          rm(file, { recursive: true, force: true }),
        ),
      );
    }
  });
  t.diagnostic(`Native delivery evidence: ${artifacts}`);
  await mkdir(workspace);
  provider = await providerFixture(root, respond);
  const adapter = makeAdapter({
    harness: "baseline-agent",
    command: path.join(
      process.env.RENDERER_PI_RUNTIME,
      "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    ),
    runtime: [process.env.RENDERER_PI_RUNTIME],
    version: "1.3.0",
    model: "fixture/deterministic",
    thinking: "off",
    modelFile: provider.config.modelsFile,
    env: { PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  adapter.stateFiles = {
    "pi/settings.json": JSON.stringify({
      compaction: { enabled: false },
      retry: {
        enabled: true,
        maxRetries,
        baseDelayMs: 1,
        provider: { maxRetries: 0 },
      },
    }),
  };
  participant = harnessParticipant(adapter, { workspace, state, artifacts });
  return { participant, provider, workspace, state, artifacts };
}

async function nativeEvents(artifacts, assignment) {
  const file = path.join(
    artifacts,
    teamDeliveryDirectory(assignment.round, assignment.attempt, assignment.atomicId),
    "stdout.jsonl",
  );
  return (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
}

const assignment = (number, signal) => ({
  round: "round-001",
  attempt: 1,
  atomicId: `task-001-edit-${String(number).padStart(5, "0")}`,
  signal,
});

test(
  "native Pi recovers transport errors, edits and continues the same participant history",
  { timeout: 60000 },
  async (t) => {
    const fixture = await setup(
      t,
      (body, number) => {
        if (number <= 2) return { status: 503, error: "Fixture upstream temporarily unavailable" };
        if (body.messages.at(-1).role === "tool") return {};
        return { command: "printf 'edit\\n' >> recovered.txt" };
      },
      2,
    );
    const prompts = ["retry-owner turn-0", "retry-owner turn-1"];
    const firstAssignment = assignment(1, t.signal);
    const first = await fixture.participant.execute(prompts[0], firstAssignment);
    assert.equal(first.exitCode, 0);
    assert.equal(first.timedOut, false);
    assert.equal(first.eventErrors, 2);
    assert.equal(first.terminalEventErrors, 0);
    assert.equal(first.toolCalls, 1);
    assert.equal(await readFile(path.join(fixture.workspace, "recovered.txt"), "utf8"), "edit\n");
    const firstEvents = await nativeEvents(fixture.artifacts, firstAssignment);
    assert.equal(firstEvents.filter((event) => event.type === "auto_retry_start").length, 2);
    assert.equal(
      firstEvents.filter((event) => event.type === "auto_retry_end" && event.success === true)
        .length,
      1,
    );
    assert.ok(firstEvents.some((event) => event.type === "agent_settled" && !event.aborted));

    // Both copied seeds and generated settings must survive the continuation unchanged.
    const modelsFile = path.join(fixture.state, "pi/models.json");
    const models = JSON.parse(await readFile(modelsFile, "utf8"));
    models.providers.fixture.apiKey = "retained-fixture-token";
    await writeFile(modelsFile, JSON.stringify(models));
    const settingsFile = path.join(fixture.state, "pi/settings.json");
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    settings.retry.baseDelayMs = 7;
    await writeFile(settingsFile, JSON.stringify(settings));

    const secondAssignment = assignment(2, t.signal);
    const second = await fixture.participant.execute(prompts[1], secondAssignment);
    assert.equal(second.exitCode, 0);
    assert.equal(second.eventErrors, 0);
    assert.equal(second.terminalEventErrors, 0);
    assert.equal(
      await readFile(path.join(fixture.workspace, "recovered.txt"), "utf8"),
      "edit\nedit\n",
    );
    const secondEvents = await nativeEvents(fixture.artifacts, secondAssignment);
    const firstSession = firstEvents.find((event) => event.type === "session")?.id;
    const secondSession = secondEvents.find((event) => event.type === "session")?.id;
    assert.equal(typeof firstSession, "string");
    assert.equal(secondSession, firstSession);
    const sessions = await readdir(path.join(fixture.state, "pi/sessions"));
    assert.equal(sessions.filter((name) => name.endsWith(".jsonl")).length, 1);
    const resumed = fixture.provider.requests.find((request) => {
      const users = request.messages.filter((message) => message.role === "user");
      return users.length === 2 && messageText(users.at(-1)) === prompts[1];
    });
    assert.ok(resumed);
    assert.deepEqual(
      resumed.messages.filter((message) => message.role === "user").map(messageText),
      prompts,
    );
    assert.equal(
      JSON.parse(await readFile(modelsFile, "utf8")).providers.fixture.apiKey,
      "retained-fixture-token",
    );
    assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).retry.baseDelayMs, 7);
    assert.deepEqual(fixture.provider.errors, []);
    await fixture.participant.close();
    assert.equal(fixture.participant.closed, true);
    await assert.rejects(readFile(settingsFile), { code: "ENOENT" });
  },
);

test(
  "native Pi retry exhaustion remains a failed participant delivery despite CLI exit zero",
  { timeout: 60000 },
  async (t) => {
    const fixture = await setup(
      t,
      () => ({ status: 503, error: "Fixture upstream remains unavailable" }),
      1,
    );
    const delivery = assignment(1, t.signal);
    await assert.rejects(
      fixture.participant.execute("retry-owner exhausted", delivery),
      (error) => {
        assert.equal(error.category, "driver_exit");
        assert.equal(error.receipt.exitCode, 0);
        assert.equal(error.receipt.timedOut, false);
        assert.equal(error.receipt.eventErrors, 2);
        assert.equal(error.receipt.terminalEventErrors, 2);
        return true;
      },
    );
    const events = await nativeEvents(fixture.artifacts, delivery);
    assert.equal(events.filter((event) => event.type === "auto_retry_start").length, 1);
    assert.equal(
      events.filter((event) => event.type === "auto_retry_end" && event.success === false).length,
      1,
    );
    assert.ok(events.some((event) => event.type === "agent_settled" && !event.aborted));
    assert.equal(events.filter((event) => event.type === "tool_execution_start").length, 0);
    assert.deepEqual(fixture.provider.errors, []);
    await fixture.participant.close();
    assert.equal(fixture.participant.closed, true);
  },
);
