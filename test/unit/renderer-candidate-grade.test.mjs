import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  prepareAtomicNamingBatch,
  applyAtomicNamingBatch,
} from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-naming-replay.mjs";
import { prepareAtomicEffect } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-structural-effects.mjs";
import { prepareAtomicRoundFootprints } from "../../src/suites/explicit-edit-multi-agent/grading/round-footprints.mjs";
import { prepareAtomicRoundCredit } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-round-credit.mjs";
import { prepareBarrierSymbolMap } from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";
import { buildCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  captureCandidate,
  releaseCandidateWorkspace,
} from "../../src/suites/explicit-edit-multi-agent/execution/candidate-evidence.mjs";
import { measureRestoringCandidate } from "../../src/suites/explicit-edit-multi-agent/execution/candidate-grade.mjs";

async function fixture(t, { removeHeader = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderer-raw-grade-"));
  t.after(() => {
    releaseCandidateWorkspace(path.join(root, "workspace"));
    return rm(root, { recursive: true, force: true });
  });
  const before = {
    "first.cpp": "int first(int old) { return old + 1; }\n",
    "good.cpp": "int good(int other) { return other + 2; }\n",
    "main.cpp": `#include <fstream>
#include <string>
int first(int);
int good(int);
int main(int argc, char** argv) {
  if (argc != 2) return 1;
  for (int scene = 0; scene < 2; scene++) {
    float pixels[32 * 32 * 4];
    for (int i = 0; i < 32 * 32 * 4; i++) pixels[i] = float(i % 17 + first(scene) + good(scene));
    std::ofstream file(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    file.write(reinterpret_cast<const char*>(pixels), sizeof(pixels));
  }
}
`,
  };
  let expected = before;
  const namingBatches = [];
  for (const [id, file, from, to] of [
    ["first", "first.cpp", "old", "value"],
    ["good", "good.cpp", "other", "count"],
  ]) {
    const batch = prepareAtomicNamingBatch(expected, [
      {
        id,
        plan: {
          edits: [...expected[file].matchAll(new RegExp(`\\b${from}\\b`, "g"))].map(
            ({ index }) => ({ file, start: index, old: from, new: to }),
          ),
        },
      },
    ]);
    namingBatches.push(batch);
    expected = applyAtomicNamingBatch(expected, batch, batch.ids).tree;
  }
  const initial = removeHeader ? { ...before, "obsolete.h": "int obsolete;\n" } : before;
  const structuralFootprints = removeHeader
    ? prepareAtomicRoundFootprints(
        initial,
        [
          {
            id: "remove",
            effect: prepareAtomicEffect(initial, before),
            filesBefore: Object.keys(initial).sort(),
            filesAfter: Object.keys(before).sort(),
          },
        ],
        before,
      )
    : undefined;
  const nodes = [
    ...(removeHeader ? [{ id: "remove", operations: [{ phase: "structure" }] }] : []),
    ...["first", "good"].map((id) => ({ id, operations: [{ phase: "names" }] })),
  ];
  const prepared = prepareAtomicRoundCredit({
    beforeTree: initial,
    expectedTree: expected,
    nodes,
    namingBatches,
    structuralFootprints,
    expectedSymbols: await prepareBarrierSymbolMap(expected, {
      evidence: path.join(root, "expected-symbols"),
    }),
  });
  const workspace = path.join(root, "workspace");
  await writeTree(workspace, expected);
  const expectedPixels = await buildCoherentCandidate(
    workspace,
    path.join(root, "golden"),
    expected,
  );
  return {
    root,
    workspace,
    expected,
    prepared,
    async measure() {
      const candidate = await captureCandidate(workspace, path.join(root, "candidate"));
      const result = await measureRestoringCandidate(candidate, prepared, {
        evidence: path.join(root, "measurement"),
        expectedPixels,
      });
      return { result, candidate };
    },
  };
}

const atoms = (result) =>
  Object.fromEntries(result.credit.atoms.map(({ id, passed }) => [id, passed]));

test("malformed requested spelling fails its original TU without erasing independent successful-TU atom credit", async (t) => {
  const f = await fixture(t);
  const damaged = Buffer.concat([
    Buffer.from("int first(int "),
    Buffer.from([255]),
    Buffer.from(") { return "),
    Buffer.from([255]),
    Buffer.from(" + 1; }\n"),
  ]);
  await writeFile(path.join(f.workspace, "first.cpp"), damaged);
  const { result, candidate } = await f.measure();
  assert.deepEqual(await readFile(path.join(candidate.source, "first.cpp")), damaged);
  assert.deepEqual(atoms(result), { first: false, good: true });
  assert.equal(result.passedAtoms, 1);
  assert.equal(result.integrityPassed, true, JSON.stringify(result.credit));
  assert.equal(result.buildPassed, false);
  assert.equal(result.resultMatched, false);
  const map = JSON.parse(
    await readFile(path.join(f.root, "measurement/symbols/symbols.json"), "utf8"),
  );
  assert.deepEqual(
    Object.fromEntries(map.credit.translationUnits.map(({ file, status }) => [file, status])),
    { "first.cpp": "fail", "good.cpp": "pass", "main.cpp": "pass" },
  );
  assert.ok(result.bindings.every((binding) => !binding.recovered));
});

test("a successful original TU with malformed protected comment bytes retains independent atom and build evidence", async (t) => {
  const f = await fixture(t);
  const [head, tail] = f.expected["main.cpp"].split("  for (int scene");
  const raw = Buffer.concat([
    Buffer.from(head + "  /* "),
    Buffer.from([255]),
    Buffer.from(" */ for (int scene" + tail),
  ]);
  await writeFile(path.join(f.workspace, "main.cpp"), raw);
  const { result, candidate } = await f.measure();
  assert.deepEqual(await readFile(path.join(candidate.source, "main.cpp")), raw);
  assert.deepEqual(atoms(result), { first: true, good: true });
  assert.equal(result.integrityPassed, false);
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, true);
});
test("invalid bytes are not silently omitted from a successful compiler input", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, "extra.cpp"), Buffer.from([255, 59]));
  const { result, candidate } = await f.measure();
  assert.ok(candidate.files.includes("extra.cpp"));
  assert.equal(result.buildPassed, false);
  assert.equal(result.resultMatched, false);
  assert.deepEqual(atoms(result), { first: true, good: true });
  assert.equal(result.integrityPassed, false);
});

test("an unmirrored special entry fails closed without pretending that projected compiler facts are original", async (t) => {
  const f = await fixture(t);
  execFileSync("/usr/bin/mkfifo", [path.join(f.workspace, "pending.pipe")]);
  const { result, candidate } = await f.measure();
  assert.equal(
    candidate.manifest.entries.find(({ path }) => path === "pending.pipe").type,
    "unsupported",
  );
  assert.equal(result.passedAtoms, 0);
  assert.equal(result.integrityPassed, true);
  assert.equal(result.buildPassed, false);
  assert.equal(result.resultMatched, false);
  const saved = JSON.parse(
    await readFile(path.join(f.root, "measurement/measurement.json"), "utf8"),
  );
  assert.equal(saved.compilerStatus, "unavailable");
  assert.equal(saved.build.failure.reason, "unsupported-source-input");
});
test("a requested removed header left as a symlink fails only its owned atom while the genuine build passes", async (t) => {
  const f = await fixture(t, { removeHeader: true });
  const outside = path.join(f.root, "outside.h");
  await writeFile(outside, "outside sentinel\n");
  await symlink(outside, path.join(f.workspace, "obsolete.h"));
  const { result } = await f.measure();
  assert.deepEqual(atoms(result), { remove: false, first: true, good: true });
  assert.equal(result.integrityPassed, true);
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, true);
  assert.equal(await readFile(outside, "utf8"), "outside sentinel\n");
});
test("an unexpected nonregular source entry cannot disappear from physical file goals", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside.h");
  await writeFile(outside, "outside sentinel\n");
  await symlink(outside, path.join(f.workspace, "extra.h"));
  await mkdir(path.join(f.workspace, "directory.cpp"));
  const { result } = await f.measure();
  assert.equal(result.integrityPassed, false);
  assert.equal(result.buildPassed, false);
  assert.equal(result.resultMatched, false);
  assert.equal(await readFile(outside, "utf8"), "outside sentinel\n");
});
