import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isOmpParticipant,
  ompCommand,
  resolveOmpParticipantProfile,
} from "../../src/suites/explicit-edit-multi-agent/execution/omp-participant.mjs";

async function runtime(t, { bun = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderer-omp-participant-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const omp = path.join(root, "node_modules/@oh-my-pi/pi-coding-agent");
  await mkdir(omp, { recursive: true });
  await writeFile(path.join(omp, "package.json"), JSON.stringify({ version: "19.1.1" }));
  if (bun) {
    await mkdir(path.join(root, "node_modules/@oven/bun-linux-x64/bin"), { recursive: true });
    await writeFile(path.join(root, "node_modules/@oven/bun-linux-x64/bin/bun"), "");
  }
  return root;
}

const config = (root, extra = {}) => ({
  runtime: root,
  model: "openai-codex/gpt-6.2-sol",
  thinking: "low",
  harness: "oh-my-pi-default",
  authFile: "/private/agent.db",
  ...extra,
});

test("an Oh My Pi participant resolves its runtime version without credentials", async (t) => {
  const root = await runtime(t);
  assert.equal(isOmpParticipant(config(root)), true);
  assert.equal(isOmpParticipant({ harness: "pi-agent-ide-codemode-no-bash" }), false);
  assert.equal(isOmpParticipant({}), false);
  const profile = await resolveOmpParticipantProfile(config(root));
  assert.equal(profile.version, "19.1.1");
});

test("an Oh My Pi participant rejects unknown keys, missing auth and a runtime without Bun", async (t) => {
  const root = await runtime(t);
  await assert.rejects(resolveOmpParticipantProfile(config(root, { toolchain: "hidden" })), {
    code: "ERR_ASSERTION",
  });
  await assert.rejects(resolveOmpParticipantProfile(config(root, { authFile: undefined })), {
    code: "ERR_ASSERTION",
  });
  await assert.rejects(resolveOmpParticipantProfile(config(root, { thinking: "huge" })), {
    code: "ERR_ASSERTION",
  });
  await assert.rejects(resolveOmpParticipantProfile(config(await runtime(t, { bun: false }))), {
    code: "ENOENT",
  });
});

test("one delivery runs Oh My Pi non-interactively with the selected model", () => {
  const args = ompCommand(config("/unused"), "Rename oldName.");
  assert.deepEqual(args.slice(0, 2), [
    "/runtime/node_modules/@oven/bun-linux-x64/bin/bun",
    "/runtime/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4), [
    "--model",
    "openai-codex/gpt-6.2-sol",
    "--thinking",
    "low",
  ]);
  assert.deepEqual(args.slice(-4), ["--mode", "json", "-p", "Rename oldName."]);
  for (const flag of [
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--auto-approve",
    "--no-title",
  ])
    assert.ok(args.includes(flag), flag);
});
