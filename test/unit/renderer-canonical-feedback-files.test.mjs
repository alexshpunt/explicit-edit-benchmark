import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalIntegrationNodes,
  prepareCanonicalFeedback,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";

const node = (id, text) => ({ id, dependencies: [], differenceIds: ["reference:1"], prompt: text });

test("small prose is inline and large prose remains complete in private session files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canonical-feedback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = [
    node("small", "Change the name in a.h."),
    node("large", "Complete assignment line.\n".repeat(3000)),
  ];
  const snapshot = structuredClone(original);
  const prepared = await prepareCanonicalFeedback(original, directory);
  assert.deepEqual(
    prepared.map(({ id }) => id),
    ["small", "large"],
  );
  assert.equal(prepared[0].prompt, original[0].prompt);
  assert.match(prepared[1].feedbackFile, /^\/feedback\/[a-zA-Z0-9._-]+\.txt$/);
  assert.ok(prepared[1].prompt.includes(prepared[1].feedbackFile));
  assert.ok(Buffer.byteLength(prepared[1].prompt) < 4096);
  const savedPath = path.join(directory, path.basename(prepared[1].feedbackFile));
  assert.equal(await readFile(savedPath, "utf8"), original[1].prompt);
  assert.equal((await readdir(directory)).length, 1);
  const later = await prepareCanonicalFeedback(
    [node("later", "Another assignment.\n".repeat(3000))],
    directory,
  );
  assert.notEqual(later[0].feedbackFile, prepared[1].feedbackFile);
  assert.equal(await readFile(savedPath, "utf8"), original[1].prompt);
  assert.equal((await readdir(directory)).length, 2);
  assert.deepEqual(original, snapshot);
});

test("integration scripts are complete, session-local and created only on delivery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canonical-scripts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expectedPixels = ["a".repeat(64), "b".repeat(64)];
  const build = canonicalIntegrationNodes("build-correction");
  const image = canonicalIntegrationNodes("image-correction", { expectedPixels });
  const original = structuredClone([build, image]);
  assert.deepEqual(await readdir(directory), []);
  for (const { nodes, name, created } of [
    { nodes: build, name: "check-build.sh", created: ["check-build.sh"] },
    { nodes: image, name: "check-images.sh", created: ["check-build.sh", "check-images.sh"] },
  ]) {
    const [packet] = await prepareCanonicalFeedback(nodes, directory);
    assert.equal(packet.validationFile, `/feedback/${name}`);
    assert.ok(packet.prompt.includes(packet.validationFile));
    assert.equal(packet.prompt.includes(nodes[0].validation), false);
    const script = path.join(directory, name);
    assert.equal(await readFile(script, "utf8"), nodes[0].validation + "\n");
    assert.equal((await stat(script)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(directory)).sort(), created);
    await assert.rejects(prepareCanonicalFeedback(nodes, directory), { code: "EEXIST" });
    assert.equal(await readFile(script, "utf8"), nodes[0].validation + "\n");
  }
  assert.deepEqual([build, image], original);
});
