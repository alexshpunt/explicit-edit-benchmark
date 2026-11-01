import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  prepareExtraction,
  loadExtraction,
} from "../../src/suites/explicit-edit-multi-agent/extraction/prepare.mjs";

async function input(root) {
  const directory = path.join(root, "input");
  await mkdir(directory);
  const initial = {
    "main.cpp":
      "#ifndef BAD_H\n#define BAD_H\nint bad_value = 3;\n#endif\nint main() { return bad_value; }\n",
  };
  await writeTree(path.join(directory, "initial"), initial);
  const tasks = [
    {
      id: "header",
      operations: [{ action: "header", file: "bad.h", guard: "BAD_H", includes: [] }],
    },
  ];
  const bytes = JSON.stringify(tasks) + "\n";
  const manifest = {
    version: "renderer-concurrent-v2",
    initial: treeIdentity(initial),
    workloadSha256: createHash("sha256").update(bytes).digest("hex"),
    pixels: ["0".repeat(64), "1".repeat(64)],
  };
  await writeFile(path.join(directory, "tasks.json"), bytes);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, initial, manifest };
}

test("preparation seals the current source and complete module plan without old renaming rounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-prepare-"));
  try {
    const source = await input(root);
    const output = path.join(root, "prepared");
    const manifest = await prepareExtraction(source.directory, output, { modules: ["bad.h"] });
    const loaded = await loadExtraction(output);
    assert.deepEqual(loaded.manifest, manifest);
    assert.deepEqual(loaded.plan.initial, source.initial);
    assert.equal(loaded.plan.tasks.length, 1);
    assert.equal(loaded.plan.expected["bad.h"].includes("bad_value"), true);
    assert.deepEqual(manifest.pixels, source.manifest.pixels);
    assert.equal(manifest.initial, treeIdentity(source.initial));
    const file = path.join(output, "plan.json");
    await writeFile(file, (await readFile(file, "utf8")).replace("bad_value = 3", "bad_value = 0"));
    await assert.rejects(loadExtraction(output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed preparation source is rejected before an extraction output is created", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-stale-"));
  try {
    const source = await input(root);
    await writeFile(
      path.join(source.directory, "initial/main.cpp"),
      source.initial["main.cpp"] + "int extra;\n",
    );
    await assert.rejects(
      prepareExtraction(source.directory, path.join(root, "prepared"), { modules: ["bad.h"] }),
    );
    await assert.rejects(readFile(path.join(root, "prepared/manifest.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
