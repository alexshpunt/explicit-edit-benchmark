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
import { pairedExtractionFixture } from "../helpers/module-extraction-generation.mjs";
import { restoreProjectGuards } from "../../src/suites/explicit-edit-multi-agent/generation/project-header-guards.mjs";
import { preparePairedExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/paired-plan.mjs";
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

test("legacy serialized paired cases retain guard-based reconstruction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-legacy-paired-"));
  try {
    const plan = preparePairedExtraction({
      ...pairedExtractionFixture(),
      modules: ["frond_a"],
      agents: 1,
      headerProtection: "guard",
    });
    const bytes = JSON.stringify(plan) + "\n";
    const manifest = {
      version: "renderer-module-extraction-v2",
      scope: plan.scope,
      initial: plan.initialIdentity,
      expected: treeIdentity(plan.expected),
      modules: plan.modules,
      agents: plan.agents,
      files: plan.tasks.map(({ id, file }) => ({ id, file })),
      pixels: ["0".repeat(64), "1".repeat(64)],
      planSha256: createHash("sha256").update(bytes).digest("hex"),
      provenance: {
        initial: plan.initialIdentity,
        workloadSha256: "2".repeat(64),
        generationSha256: createHash("sha256")
          .update(JSON.stringify(plan.generation))
          .digest("hex"),
      },
    };
    await writeFile(path.join(root, "plan.json"), bytes);
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
    assert.deepEqual(await loadExtraction(root), { manifest, plan });
    assert.match(plan.expected["frond_a.h"], /^#ifndef A_H\n#define A_H\n/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function pairedInput(root) {
  const fixture = pairedExtractionFixture();
  const directory = path.join(root, "input"),
    generation = path.join(root, "generation");
  await mkdir(directory);
  await mkdir(generation);
  await writeTree(path.join(directory, "initial"), fixture.initial);
  const tasks =
    JSON.stringify(
      fixture.headers.map((header) => ({ operations: [{ action: "header", ...header }] })),
    ) + "\n";
  await writeFile(path.join(directory, "tasks.json"), tasks);
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      version: "renderer-concurrent-v2",
      initial: treeIdentity(fixture.initial),
      workloadSha256: createHash("sha256").update(tasks).digest("hex"),
      pixels: ["0".repeat(64), "1".repeat(64)],
    }),
  );
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
  return { directory, generation, fixture };
}

test("paired preparation seals generation ownership, file tasks and the selected participant count", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-pair-prepare-"));
  try {
    const source = await pairedInput(root),
      output = path.join(root, "prepared");
    const manifest = await prepareExtraction(source.directory, output, {
      modules: ["frond_a"],
      generation: source.generation,
      agents: 1,
    });
    assert.equal(manifest.version, "renderer-module-extraction-v4");
    assert.equal(manifest.assignmentContract, "symbol-inventory-v1");
    assert.equal(manifest.headerProtection, "pragma-once");
    assert.equal(manifest.scope, "experimental-module-pairs");
    assert.equal(manifest.agents, 1);
    const loaded = await loadExtraction(output);
    assert.deepEqual(loaded.manifest, manifest);
    assert.deepEqual(
      restoreProjectGuards(loaded.plan.initial, loaded.plan.generation.manifest.operations.at(-1)),
      source.fixture.initial,
    );
    assert.deepEqual(
      new Set(manifest.files.map((file) => file.file)),
      new Set(["frond_a.h", "frond_a.cpp", "frond_math.h"]),
    );
    assert.deepEqual(loaded.plan.generation.mixing, source.fixture.generation.mixing);
    assert.deepEqual(
      loaded.plan.generation.manifest.operations.slice(0, -1),
      source.fixture.generation.manifest.operations,
    );
    assert.equal(manifest.provenance.preparationInitial, source.fixture.generation.manifest.final);
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({ ...manifest, agents: 2 }));
    await assert.rejects(loadExtraction(output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mismatched generation journals are rejected before creating a paired case", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extraction-pair-journal-"));
  try {
    const source = await pairedInput(root),
      output = path.join(root, "prepared");
    await writeFile(
      path.join(source.generation, "report.json"),
      JSON.stringify({ operations: [], mixing: null }),
    );
    await assert.rejects(
      prepareExtraction(source.directory, output, {
        modules: ["frond_a"],
        generation: source.generation,
        agents: 1,
      }),
    );
    await assert.rejects(readFile(path.join(output, "manifest.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
