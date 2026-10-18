import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

await test("the owned preparation namespace lets child tools open private devices", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/preparation-devices-"));
  const preparation = path.resolve("src/suites/explicit-edit-multi-agent/prepare.mjs");
  const marker = path.join(root, "child-tools.json");
  const preload = path.join(root, "check-devices.mjs");
  try {
    // Exercise the actual preparation child before its expensive workload starts.
    // Missing coherent input then terminates it through the real failure path.
    await writeFile(
      preload,
      `import { openSync, closeSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
if (process.argv[1] === ${JSON.stringify(preparation)}) {
  const device = openSync("/dev/null", "r+");
  closeSync(device);
  const output = execFileSync(process.execPath, ["-e", "process.stdout.write('child-ok')"], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ output, device: "open" }));
}
`,
    );
    const parent = `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareMultiAgent } from ${JSON.stringify(pathToFileURL(preparation).href)};
await assert.rejects(
  prepareMultiAgent(${JSON.stringify(path.join(root, "output"))}, {
    coherentProof: ${JSON.stringify(path.join(root, "missing-coherent"))},
  }), /Multi-Agent preparation worker did not complete/,
);
assert.deepEqual(JSON.parse(await readFile(${JSON.stringify(marker)}, "utf8")), {
  output: "child-ok", device: "open",
});
`;
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", parent], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` },
    });
    assert.equal(result, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
