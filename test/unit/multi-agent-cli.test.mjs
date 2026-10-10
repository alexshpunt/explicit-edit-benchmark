import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const command = (...args) =>
  spawnSync(process.execPath, ["scripts/multi-agent.mjs", ...args], {
    encoding: "utf8",
    timeout: 10000,
  });

await test("the separate CLI is discoverable without runtime, credentials, preparation or model access", () => {
  const result = command("--help");
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["prepare", "verify", "run", "export", "validate"])
    assert.ok(result.stdout.includes(name));
  assert.ok(result.stdout.includes("--allow-model-calls"));
});

await test("live calls need explicit permission and scripted mode rejects private provider configuration", () => {
  for (const args of [
    ["run", "missing-preparation", "missing-output", "--config", "private-config.json"],
    ["run", "missing-preparation", "missing-output", "--allow-model-calls"],
    ["verify", "missing-preparation", "missing-output", "--config", "private-config.json"],
    ["verify", "missing-preparation", "missing-output", "--agents", "0"],
  ]) {
    const result = command(...args);
    assert.equal(result.status, 1);
    assert.ok(
      !result.stderr.includes("ENOENT"),
      "Reject invalid invocation before reading preparation or credentials",
    );
  }
});
