#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { officialVerdict } from "./official-verifier.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(Error(`${command} exited with ${signal ?? code}`)),
    );
  });
}

const [candidateDirectory, signerSha, policyFile = "policies/official-runs/v1.json"] =
  process.argv.slice(2);
if (!candidateDirectory || !signerSha)
  throw Error(
    "Usage: official-verifier-cli.mjs CANDIDATE_DIRECTORY SIGNER_WORKFLOW_SHA [POLICY_FILE]",
  );

const verdict = await officialVerdict({
  candidateDirectory,
  extractedDirectory: path.resolve(".tmp", `official-verify-${process.pid}`),
  policyFile,
  signerSha,
  verifyAttestation: async ({ artifact, attestation, repository }) => {
    try {
      await run(process.execPath, [
        "scripts/verify-official-attestation.mjs",
        artifact,
        attestation,
        repository,
        policyFile,
        signerSha,
      ]);
    } catch (error) {
      throw Object.assign(Error("GitHub attestation verification failed", { cause: error }), {
        code: "invalid-signature",
      });
    }
  },
});
console.log(JSON.stringify(verdict, (key, value) => (key === "evidence" ? undefined : value)));
if (verdict.status === "deferred") process.exitCode = 75;
else if (verdict.status !== "accepted") process.exitCode = 1;
