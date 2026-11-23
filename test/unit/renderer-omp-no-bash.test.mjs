import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isOmpParticipant,
  OMP_NO_BASH_SETTINGS,
  ompCommand,
} from "../../src/suites/explicit-edit-multi-agent/execution/omp-participant.mjs";
import noShellGuard, {
  loadoutProblems,
  shellUse,
} from "../../src/suites/explicit-edit-multi-agent/execution/omp-no-shell-guard.mjs";

const config = (harness) => ({
  runtime: "/unused",
  model: "openai-codex/gpt-6.2-sol",
  thinking: "low",
  harness,
  authFile: "/private/agent.db",
});

test("the no-Bash Oh My Pi harness loads its settings overlay and shell guard", () => {
  assert.equal(isOmpParticipant(config("oh-my-pi-no-bash")), true);
  const args = ompCommand(config("oh-my-pi-no-bash"), "Rename oldName.");
  const at = args.indexOf("--config");
  assert.deepEqual(args.slice(at, at + 4), [
    "--config",
    "/state/omp/no-bash.yml",
    "--extension",
    "/observer/omp-no-shell-guard.mjs",
  ]);
  assert.ok(args.includes("--no-extensions"));
  assert.deepEqual(args.slice(-4), ["--mode", "json", "-p", "Rename oldName."]);
  assert.match(OMP_NO_BASH_SETTINGS, /^bash:\n {2}enabled: false\n/m);
  assert.match(OMP_NO_BASH_SETTINGS, /^eval:\n {2}py: false\n/m);
  assert.match(OMP_NO_BASH_SETTINGS, /^debug:\n {2}enabled: false\n/m);
  const plain = ompCommand(config("oh-my-pi-default"), "Rename oldName.");
  assert.equal(plain.includes("--config"), false);
  assert.equal(plain.includes("--extension"), false);
});

test("the shell guard refuses eval cells and tools that reach a shell", () => {
  const js = (code) => shellUse("eval", { language: "js", code });
  for (const code of [
    'await sh("clang++ main.cpp")',
    "await sh`ls ${dir}`",
    "const run = sh; await run('ls')",
    'const { spawnSync } = await import("node:child_process")',
    "require('child_process').execSync('ls')",
    'Bun.spawn(["ls"])',
    "await Bun.$`ls`",
    'import { $ } from "bun"',
    'await __omp_call_tool__("__shell__", { command: "ls" })',
    "process.binding('spawn_sync')",
    "%bun add left-pad",
  ])
    assert.ok(js(code), code);
  assert.ok(shellUse("eval", { language: "py", code: "print(1)" }));
  assert.ok(shellUse("bash", { command: "ls" }));
  assert.ok(shellUse("debug", { action: "launch", program: "/bin/sh" }));
});

test("the shell guard lets file edits and ordinary JavaScript run", () => {
  const js = (code) => shellUse("eval", { language: "js", code });
  for (const code of [
    'const text = await read("main.cpp"); await write("main.cpp", text.replaceAll("a", "b"))',
    'import { readFileSync } from "node:fs"',
    "const shape = shared.sh_flag + hash(x); // finish",
    'const s = "#!/bin/sh"',
  ])
    assert.equal(js(code), undefined, code);
  assert.equal(shellUse("edit", { path: "main.cpp" }), undefined);
  assert.equal(shellUse("read", { path: "main.cpp" }), undefined);
});

test("the shell guard blocks with a prose reason and records a valid loadout", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-no-shell-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const handlers = new Map();
  noShellGuard({
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => ["read", "eval", "edit"],
  });
  handlers.get("session_start")();
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, "no-shell-profile.json"), "utf8")),
    { tools: ["edit", "eval", "read"], problems: [] },
  );
  const blocked = handlers.get("tool_call")({
    toolName: "eval",
    input: { language: "js", code: "await sh('ls')" },
  });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /^Shell commands are not available in this benchmark run\./);
  assert.match(blocked.reason, /Refused: the sh\(\) helper\.$/);
  assert.equal(
    handlers.get("tool_call")({ toolName: "edit", input: { path: "main.cpp" } }),
    undefined,
  );
});

test("a loadout with Bash, the debugger or without eval is invalid", () => {
  assert.deepEqual(loadoutProblems(["bash", "eval", "read"]), ["bash is active"]);
  assert.deepEqual(loadoutProblems(["debug", "eval", "read"]), ["debug is active"]);
  assert.deepEqual(loadoutProblems(["read"]), ["eval is not active"]);
  assert.deepEqual(loadoutProblems(["edit", "eval", "read"]), []);
});
