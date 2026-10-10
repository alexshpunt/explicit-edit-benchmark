import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateSeries } from "./generation/run.mjs";
import { verifyFullRestoration } from "./grading/verify-full-restoration.mjs";
import { prepareCoherent } from "./tasks/prepare-coherent.mjs";
import { runCoherent } from "./execution/coherent-run.mjs";
import { prepareConcurrent } from "./tasks/prepare-concurrent.mjs";

/** Prepare the unchanged workload from the bundled fixture without model calls.
 * A completed coherent proof may be supplied explicitly to skip its expensive
 * generation. The concurrent preparation still validates its hashes and routes;
 * a separate scripted run must prove the actual selected parallel schedule. */
export async function prepareMultiAgent(outputDirectory, { coherentProof } = {}) {
  const output = path.resolve(outputDirectory);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const coherent = coherentProof ? path.resolve(coherentProof) : path.join(output, "coherent");
  if (!coherentProof) {
    const generation = path.join(output, "generation");
    const generated = await generateSeries(generation, { names: true });
    const full = path.join(output, "full-proof");
    const proof = await verifyFullRestoration(generation, full);
    assert.equal(proof.status, "pass");
    assert.equal(proof.chain.status, "pass");
    assert.ok(proof.checks.every((check) => check.status === "pass"));
    const requests = await readFile(path.join(full, "requests.json"));
    await writeFile(
      path.join(full, "audit.json"),
      JSON.stringify({
        status: "pass",
        initial: proof.initial,
        final: proof.final,
        requestsSha256: createHash("sha256").update(requests).digest("hex"),
        pixels: generated.payload.pixels,
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await prepareCoherent(full, coherent);
    const reference = await runCoherent(coherent, path.join(output, "coherent-proof"));
    assert.equal(reference.status, "pass");
  }
  const preparation = path.join(output, "preparation");
  const manifest = await prepareConcurrent(coherent, preparation);
  console.log(`Multi-Agent preparation: ${preparation}`);
  console.log(`Next: npm run benchmark:multi-agent -- verify ${preparation} NEW_OUTPUT`);
  return manifest;
}
