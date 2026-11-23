import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePiParticipantProfile } from "../../src/suites/explicit-edit-multi-agent/execution/pi-profile.mjs";
import { missingProfileTools } from "../../scripts/pi-codemode-profile.mjs";
import { restoringFixture } from "../helpers/restoring-result-fixture.mjs";
import {
  restoringMultiAgentResult,
  validateRestoringMultiAgentResult,
  RESTORING_MULTI_AGENT_POLICY,
} from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";
const revision = "a".repeat(40);

test("safe results retain and compare the actual IDE source separately from the Pi runtime", async (t) => {
  const { config } = await fixture(t);
  const profile = await resolvePiParticipantProfile({
    ...config,
    harness: "pi-agent-ide-codemode",
  });
  const raw = restoringFixture();
  raw.policy = { ...RESTORING_MULTI_AGENT_POLICY, buildWeight: 2, resultWeight: 4 };
  raw.rounds[0].attempts = [
    raw.rounds[0].attempts[0],
    { ...raw.rounds[0].attempts.at(-1), attempt: 2 },
  ];
  raw.rounds[0].finalAttempt = 2;
  raw.executions = raw.executions.filter(({ attempt }) => attempt <= 2);
  raw.deliveries = raw.executions.length;
  raw.repairs = 1;
  raw.harness = profile.harness;
  raw.runtime.version = profile.version;
  const result = restoringMultiAgentResult(raw);
  assert.deepEqual(validateRestoringMultiAgentResult(result), result);
  assert.deepEqual(result.configuration.harness, profile.harness);
  assert.equal(result.configuration.runtime.version, "1.4.0");
  assert.equal(result.configuration.harness.version, "0.9.0+" + revision);
  raw.harness = { ...raw.harness, version: "0.9.0+" + "b".repeat(40) };
  assert.notEqual(restoringMultiAgentResult(raw).comparisonKey, result.comparisonKey);
  const invalid = structuredClone(result);
  invalid.configuration.harness.version = "/home/private/ide";
  assert.throws(() => validateRestoringMultiAgentResult(invalid), { code: "ERR_ASSERTION" });
});
async function fixture(t, { entries = ["./dist/pi-agent-ide.js"], gitHead = revision } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderer-pi-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  const pi = path.join(runtime, "node_modules/@earendil-works/pi-coding-agent");
  const ide = path.join(runtime, "node_modules/pi-agent-ide");
  await mkdir(pi, { recursive: true });
  await mkdir(path.join(ide, "dist"), { recursive: true });
  await writeFile(path.join(pi, "package.json"), JSON.stringify({ version: "1.4.0" }));
  await writeFile(
    path.join(ide, "package.json"),
    JSON.stringify({
      name: "pi-agent-ide",
      version: "0.9.0",
      gitHead,
      pi: { extensions: entries },
    }),
  );
  await writeFile(path.join(ide, "dist/pi-agent-ide.js"), "export default function() {}\n");
  return { root, runtime, ide, config: { runtime, model: "fixture/native", thinking: "low" } };
}

test("default native participants retain the Bash-only Baseline", async (t) => {
  const { config, runtime } = await fixture(t);
  const profile = await resolvePiParticipantProfile(config);
  assert.equal(profile.runtime, runtime);
  assert.equal(profile.version, "1.4.0");
  assert.equal(profile.baseline, true);
  assert.equal(profile.harness, "baseline-agent");
  assert.deepEqual(profile.toolArgs, ["--tools", "bash"]);
  assert.deepEqual(profile.extensionArgs, []);
  assert.equal(profile.settings, null);
});

test("an extension harness loads the package's declared entry and keeps its own tools", async (t) => {
  const { config, runtime } = await fixture(t);
  const hashline = path.join(runtime, "node_modules/pi-hashline-edit-pro");
  await mkdir(hashline, { recursive: true });
  await writeFile(
    path.join(hashline, "package.json"),
    JSON.stringify({
      name: "pi-hashline-edit-pro",
      version: "7.2.0",
      pi: { extensions: ["./index.ts"] },
    }),
  );
  await writeFile(path.join(hashline, "index.ts"), "export default function() {}\n");
  const profile = await resolvePiParticipantProfile({ ...config, harness: "pi-hashline-edit-pro" });
  assert.equal(profile.baseline, false);
  assert.deepEqual(profile.harness, {
    id: "pi-hashline-edit-pro",
    kind: "pi-hashline-edit-pro",
    version: "7.2.0",
  });
  assert.deepEqual(profile.toolArgs, []);
  assert.deepEqual(profile.extensionArgs, [
    "--extension",
    "/runtime/node_modules/pi-hashline-edit-pro/index.ts",
    "--extension",
    "/observer/pi-codemode-profile.mjs",
  ]);
  assert.equal(profile.settings, null);
  const loadout = ["read", "replace", "insert", "grep", "undo_last_change", "write", "bash"];
  assert.deepEqual(missingProfileTools(loadout, "pi-hashline-edit-pro"), []);
  assert.deepEqual(missingProfileTools([...loadout, "edit"], "pi-hashline-edit-pro"), ["-edit"]);
});

test("the extension harness without Bash removes Pi's Bash and rejects a loadout with it", async (t) => {
  const { config, runtime } = await fixture(t);
  const hashline = path.join(runtime, "node_modules/pi-hashline-edit-pro");
  await mkdir(hashline, { recursive: true });
  await writeFile(
    path.join(hashline, "package.json"),
    JSON.stringify({
      name: "pi-hashline-edit-pro",
      version: "7.2.0",
      pi: { extensions: ["./index.ts"] },
    }),
  );
  await writeFile(path.join(hashline, "index.ts"), "export default function() {}\n");
  const harness = "pi-hashline-edit-pro-no-bash";
  const profile = await resolvePiParticipantProfile({ ...config, harness });
  assert.deepEqual(profile.harness, { id: harness, kind: harness, version: "7.2.0" });
  assert.deepEqual(profile.toolArgs, ["--tools", "-bash"]);
  assert.deepEqual(profile.extensionArgs, [
    "--extension",
    "/runtime/node_modules/pi-hashline-edit-pro/index.ts",
    "--extension",
    "/observer/pi-codemode-profile.mjs",
  ]);
  const loadout = ["read", "replace", "insert", "grep", "undo_last_change", "write"];
  assert.deepEqual(missingProfileTools(loadout, harness), []);
  assert.deepEqual(missingProfileTools([...loadout, "bash"], harness), ["-bash"]);
});

test("Codemode participants bind the installed IDE source and additive main profile", async (t) => {
  const { config } = await fixture(t);
  const profile = await resolvePiParticipantProfile({
    ...config,
    harness: "pi-agent-ide-codemode",
  });
  assert.equal(profile.baseline, false);
  assert.equal(profile.version, "1.4.0");
  assert.deepEqual(profile.harness, {
    id: "pi-agent-ide-codemode",
    kind: "pi-agent-ide-codemode",
    version: `0.9.0+${revision}`,
  });
  assert.deepEqual(profile.toolArgs, ["--tools", "+codemode,+tool_search"]);
  assert.deepEqual(profile.extensionArgs, [
    "--extension",
    "builtin:codemode",
    "--extension",
    "builtin:tool-search",
    "--extension",
    "/runtime/node_modules/pi-agent-ide/dist/pi-agent-ide.js",
    "--extension",
    "/observer/pi-codemode-profile.mjs",
  ]);
  assert.deepEqual(profile.settings, {
    codemode: { mode: "on" },
    defaultTools: ["+codemode", "+tool_search"],
  });
});

test("the IDE variant without Bash removes Bash and must not declare it", async (t) => {
  const { config } = await fixture(t);
  const profile = await resolvePiParticipantProfile({
    ...config,
    harness: "pi-agent-ide-codemode-no-bash",
  });
  assert.equal(profile.baseline, false);
  assert.equal(profile.harness.id, "pi-agent-ide-codemode-no-bash");
  assert.deepEqual(profile.toolArgs, ["--tools", "+codemode,+tool_search,-bash"]);
  assert.deepEqual(profile.settings, {
    codemode: { mode: "on" },
    defaultTools: ["+codemode", "+tool_search", "-bash"],
  });
  const ide = ["codemode", "read", "write", "search", "replace", "insert"];
  const editing = [...ide, "delete", "copy", "move", "tool_search"];
  assert.deepEqual(missingProfileTools(editing, "pi-agent-ide-codemode-no-bash"), []);
  // Deferred IDE tools such as diff and undo are not required in the active loadout.
  assert.deepEqual(
    missingProfileTools(
      editing.filter((name) => name !== "move"),
      "pi-agent-ide-codemode-no-bash",
    ),
    ["move"],
  );
  assert.deepEqual(missingProfileTools([...editing, "bash"], "pi-agent-ide-codemode-no-bash"), [
    "-bash",
  ]);
  assert.deepEqual(missingProfileTools(editing, "pi-agent-ide-codemode"), ["bash"]);
  assert.deepEqual(missingProfileTools(editing, "other"), ["unknown harness other"]);
});

test("a package's declared compiled entry is resolved instead of a hand-picked module", async (t) => {
  const { config, ide } = await fixture(t, { entries: ["./dist/custom-entry.js"] });
  await writeFile(path.join(ide, "dist/custom-entry.js"), "export default function() {}\n");
  const profile = await resolvePiParticipantProfile({
    ...config,
    harness: "pi-agent-ide-codemode",
  });
  assert.ok(
    profile.extensionArgs.includes("/runtime/node_modules/pi-agent-ide/dist/custom-entry.js"),
  );
});

test("undeclared configuration and historical IDE profiles cannot silently change the loadout", async (t) => {
  const { config } = await fixture(t);
  for (const extra of [
    { harness: "pi-agent-ide" },
    { harness: null },
    { tools: "bash" },
    { thinking: null },
  ]) {
    await assert.rejects(resolvePiParticipantProfile({ ...config, ...extra }), {
      code: "ERR_ASSERTION",
    });
  }
});

test("Codemode packages reject ambiguous or missing declared extension entries", async (t) => {
  for (const entries of [[], ["./dist/a.js", "./dist/b.js"], ["./dist/missing.js"]]) {
    const { config } = await fixture(t, { entries });
    await assert.rejects(
      resolvePiParticipantProfile({ ...config, harness: "pi-agent-ide-codemode" }),
    );
  }
});

test("Codemode entries and symlinked packages must stay inside the mounted runtime", async (t) => {
  const { root, config, ide } = await fixture(t);
  const outside = path.join(root, "outside.js");
  await writeFile(outside, "export default function() {}\n");
  await rm(path.join(ide, "dist/pi-agent-ide.js"));
  await symlink(outside, path.join(ide, "dist/pi-agent-ide.js"));
  await assert.rejects(
    resolvePiParticipantProfile({ ...config, harness: "pi-agent-ide-codemode" }),
    { code: "ERR_ASSERTION" },
  );
  await rm(ide, { recursive: true });
  const outsidePackage = path.join(root, "outside-package");
  await mkdir(outsidePackage);
  await writeFile(
    path.join(outsidePackage, "package.json"),
    JSON.stringify({
      name: "pi-agent-ide",
      version: "0.9.0",
      gitHead: revision,
      pi: { extensions: ["entry.js"] },
    }),
  );
  await writeFile(path.join(outsidePackage, "entry.js"), "export default function() {}\n");
  await symlink(outsidePackage, ide);
  await assert.rejects(
    resolvePiParticipantProfile({ ...config, harness: "pi-agent-ide-codemode" }),
    { code: "ERR_ASSERTION" },
  );
});

test("a development source identity cannot contain private paths or arbitrary labels", async (t) => {
  const { config } = await fixture(t, { gitHead: "not-a-commit" });
  await assert.rejects(
    resolvePiParticipantProfile({ ...config, harness: "pi-agent-ide-codemode" }),
    { code: "ERR_ASSERTION" },
  );
});
