import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { loadExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/prepare.mjs";
import { restoreProjectGuards } from "../../src/suites/explicit-edit-multi-agent/generation/project-header-guards.mjs";

import { pairedExtractionFixture } from "../helpers/module-extraction-generation.mjs";
const script = new URL("../../scripts/module-extraction.mjs", import.meta.url);

for (const command of ["run", "recover"])
  test(
    `closed-run ${command} is refused before opening even an explicitly authorized configuration`,
    { skip: process.platform === "win32" },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "extraction-closed-cli-"));
      try {
        const config = path.join(root, "unopened-config");
        assert.equal(spawnSync("mkfifo", [config]).status, 0);
        const result = spawnSync(
          process.execPath,
          [
            script.pathname,
            command,
            "unread-case",
            path.join(root, "run"),
            "--allow-model-calls",
            "--config",
            config,
            "--proof",
            "unread-proof",
            "--from-run",
            "closed-run",
            "--source-receipt",
            "unread-receipt",
          ],
          { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(path.join(root, "run")), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
test("the separate extraction CLI prepares the requested current-source module", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-cli-prepare-"));
  try {
    const input = path.join(root, "input");
    await mkdir(input);
    const fixture = pairedExtractionFixture(),
      initial = fixture.initial;
    const tasks =
      JSON.stringify(
        fixture.headers.map((header) => ({ operations: [{ action: "header", ...header }] })),
      ) + "\n";
    const generation = path.join(root, "generation");
    await mkdir(generation);
    await writeFile(
      path.join(generation, "operations.json"),
      JSON.stringify(fixture.generation.manifest),
    );
    await writeFile(
      path.join(generation, "report.json"),
      JSON.stringify({
        operations: fixture.generation.manifest.operations,
        mixing: fixture.generation.mixing,
      }),
    );
    await writeTree(path.join(input, "initial"), initial);
    await writeFile(path.join(input, "tasks.json"), tasks);
    await writeFile(
      path.join(input, "manifest.json"),
      JSON.stringify({
        version: "renderer-concurrent-v2",
        initial: treeIdentity(initial),
        workloadSha256: createHash("sha256").update(tasks).digest("hex"),
        pixels: ["0".repeat(64), "1".repeat(64)],
      }),
    );
    const output = path.join(root, "case");
    const result = spawnSync(
      process.execPath,
      [
        script.pathname,
        "prepare",
        input,
        output,
        "--modules",
        "frond_a",
        "--generation",
        generation,
        "--agents",
        "1",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).modules, ["frond_a"]);
    const loaded = await loadExtraction(output);
    assert.equal(loaded.plan.headerProtection, "pragma-once");
    assert.deepEqual(
      restoreProjectGuards(loaded.plan.initial, loaded.plan.generation.manifest.operations.at(-1)),
      initial,
    );
    assert.equal(loaded.plan.tasks.length, 3);
    assert.equal(loaded.plan.agents, 1);
    assert.deepEqual(
      new Set(loaded.plan.tasks.map((task) => task.file)),
      new Set(["frond_a.h", "frond_a.cpp", "frond_math.h"]),
    );
    assert.ok(
      loaded.plan.expected["frond_a.cpp"].includes("int operation_a() { return identity(1); }"),
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")),
      loaded.manifest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const command of ["run", "recover"])
  test(
    `the extraction CLI refuses ${command} without explicit permission before reading configuration`,
    { skip: process.platform === "win32" },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "extraction-cli-"));
      try {
        const output = path.join(root, "run");
        const config = path.join(root, "unopened-config");
        assert.equal(spawnSync("mkfifo", [config]).status, 0);
        const result = spawnSync(
          process.execPath,
          [
            script.pathname,
            command,
            path.join(root, "missing-case"),
            output,
            "--config",
            config,
            "--proof",
            path.join(root, "missing-proof"),
          ],
          { encoding: "utf8", timeout: 3000 },
        );
        // A configuration read would block on the pipe until this watchdog kills it.
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(output), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
