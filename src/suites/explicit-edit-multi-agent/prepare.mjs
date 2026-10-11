import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateSeries } from "./generation/run.mjs";
import { verifyFullRestoration } from "./grading/verify-full-restoration.mjs";
import { prepareCoherent } from "./tasks/prepare-coherent.mjs";
import { runCoherent } from "./execution/coherent-run.mjs";
import { prepareConcurrent } from "./tasks/prepare-concurrent.mjs";

/** Prepare the unchanged workload without models in an owned process group.
 * Cancellation closes the preparation worker, its compilers and reference editors
 * before returning. Partial evidence is retained, but no completed proof is claimed.
 * A supplied coherent proof skips generation; a separate scripted concurrent run
 * must still prove the selected parallel schedule. */
export async function prepareMultiAgent(outputDirectory, { coherentProof, signal } = {}) {
  signal?.throwIfAborted();
  // Nested reference sandboxes start new sessions. Own their entire PID namespace
  // and keep Bubblewrap alive until it has reaped the namespace after cancellation.
  const worker = spawn(
    "/usr/bin/bwrap",
    [
      "--info-fd",
      "3",
      "--bind",
      "/",
      "/",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
      "--",
      process.execPath,
      fileURLToPath(import.meta.url),
      JSON.stringify({ outputDirectory, coherentProof }),
    ],
    { detached: true, stdio: ["ignore", "inherit", "inherit", "pipe"] },
  );
  /** @type {Error[]} */
  const failures = [];
  /** @type {number[]} */
  const namespaces = [];
  const cancel = () => {
    const pid = namespaces[0];
    if (!pid) return; // Startup has not reported a namespace yet.
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") failures.push(error);
    }
  };
  let information = "";
  worker.stdio[3].on("data", (bytes) => {
    information += bytes;
  });
  worker.stdio[3].once("end", () => {
    if (!information.trim()) return;
    try {
      const pid = JSON.parse(information)["child-pid"];
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "Missing preparation namespace PID");
      namespaces.push(pid);
      if (signal?.aborted) cancel();
    } catch (error) {
      failures.push(error);
    }
  });
  worker.on("error", (error) => {
    failures.push(error);
  });
  const closed = new Promise((resolve) =>
    worker.once("close", (code) => {
      signal?.removeEventListener("abort", cancel);
      resolve(code);
    }),
  );
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const code = await closed;
    signal?.throwIfAborted();
    if (failures.length) throw failures[0];
    if (code !== 0) throw Error("Multi-Agent preparation worker did not complete");
    const manifest = await readFile(
      path.join(outputDirectory, "preparation/manifest.json"),
      "utf8",
    );
    signal?.throwIfAborted();
    return JSON.parse(manifest);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

async function prepareInProcess(outputDirectory, { coherentProof } = {}) {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { outputDirectory, coherentProof } = JSON.parse(process.argv[2]);
    await prepareInProcess(outputDirectory, { coherentProof });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
