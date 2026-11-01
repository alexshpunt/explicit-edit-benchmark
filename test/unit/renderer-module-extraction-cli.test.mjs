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

const script = new URL("../../scripts/module-extraction.mjs", import.meta.url);
test("the separate extraction CLI prepares the requested current-source module", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-cli-prepare-"));
  try {
    const input = path.join(root, "input");
    await mkdir(input);
    const initial = {
      "main.cpp":
        "#ifndef BAD_H\n#define BAD_H\nint bad_value = 3;\n#endif\nint main() { return bad_value; }\n",
    };
    const tasks =
      JSON.stringify([
        { operations: [{ action: "header", file: "bad.h", guard: "BAD_H", includes: [] }] },
      ]) + "\n";
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
      [script.pathname, "prepare", input, output, "--modules", "bad.h"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).modules, ["bad.h"]);
    const loaded = await loadExtraction(output);
    assert.deepEqual(loaded.plan.initial, initial);
    assert.equal(loaded.plan.tasks.length, 1);
    assert.equal(
      loaded.plan.expected["bad.h"],
      "#ifndef BAD_H\n#define BAD_H\nint bad_value = 3;\n#endif\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")),
      loaded.manifest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "the extraction CLI refuses model execution without explicit permission before reading configuration",
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
          "run",
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
