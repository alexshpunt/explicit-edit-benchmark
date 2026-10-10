import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  generateSeries,
  buildAndRender,
} from "../../src/suites/explicit-edit-multi-agent/generation/run.mjs";
import {
  readTree,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const output = process.env.RENDERER_GENERATION_OUTPUT;
assert.ok(output, "Set RENDERER_GENERATION_OUTPUT to a new output directory");
const root = path.resolve(output);
const fixture = fileURLToPath(
  new URL("../../fixtures/explicit-edit-multi-agent/", import.meta.url),
);

await test(
  "generation finds the pinned fixture outside the checkout cwd and preserves notices, source and repeated pixels",
  { timeout: 180000 },
  async () => {
    await mkdir(root);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const generated = await generateSeries(path.join(root, "generation"), { verify: false });
      assert.equal(generated.payload.status, "unverified");
      const canonical = path.join(root, "generation/forward/00/source");
      const restored = await readTree(path.join(root, "generation/reverse/00/source"));
      const original = await readTree(canonical);
      assert.equal(treeIdentity(restored), generated.initial);
      assert.equal(treeIdentity(original), generated.initial);
      const notices = Object.fromEntries(
        Object.entries(await readTree(fixture)).filter(([name]) => !/\.(cpp|h)$/.test(name)),
      );
      assert.deepEqual(await readTree(path.join(root, "generation/notices")), notices);
      assert.ok(notices["LICENSE-YOCTO"] && notices["LICENSE-BENCHMARK"]);
      const payload = path.join(root, "generation/payload");
      const tree = await readTree(payload);
      assert.deepEqual(Object.keys(tree), ["main.cpp"]);
      const pixels = [
        "c9102ab63ee329889a44950cc532fb3d4181ae637072686cc36bc41cfd432071",
        "b7171b1c5e92a180a51c2656e0701d9e47bcfb8c6f933ad369baa78e6371091b",
      ];
      assert.deepEqual(
        await buildAndRender(canonical, path.join(root, "canonical-build"), original, "clang++"),
        pixels,
      );
      assert.deepEqual(
        await buildAndRender(payload, path.join(root, "payload-build"), tree, "clang++"),
        pixels,
      );
      const saved = JSON.parse(await readFile(path.join(root, "generation/report.json"), "utf8"));
      assert.equal(saved.final, treeIdentity(tree));
    } finally {
      process.chdir(cwd);
    }
    // This scenario is a focused generation check, not a full preparation proof.
    // Keep its report and builds; discard only its large intermediate source copies.
    for (const name of ["forward", "reverse"])
      await rm(path.join(root, "generation", name), { recursive: true });
  },
);
