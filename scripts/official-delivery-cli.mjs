#!/usr/bin/env node
import { recoverOfficialDelivery, submitOfficialCandidate } from "./official-delivery.mjs";

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const artifact = value(args, "--artifact");
const attestation = value(args, "--attestation");
const manifest = value(args, "--manifest");
const signerWorkflowSha = value(args, "--signer-sha");
const repository = value(args, "--repository");
const statusFile = value(args, "--status-file");
if (!artifact || !attestation || !manifest || !signerWorkflowSha || !repository || !statusFile)
  throw Error(
    "Usage: official-delivery-cli.mjs --artifact FILE --attestation FILE --manifest FILE --signer-sha SHA --repository OWNER/DATASET --status-file FILE",
  );
let status = await submitOfficialCandidate({
  artifact,
  attestation,
  manifest,
  signerWorkflowSha,
  repository,
  statusFile,
  accessToken: process.env.HF_TOKEN,
});
if (args.includes("--wait-for-acceptance") && status.status === "delivered")
  status = await recoverOfficialDelivery({
    repository,
    delivery: status,
    accessToken: process.env.HF_TOKEN,
    statusFile,
    wait: {
      attempts: Number(process.env.ACCEPTANCE_POLL_ATTEMPTS ?? 120),
      delayMs: Number(process.env.ACCEPTANCE_POLL_DELAY_MS ?? 10_000),
    },
  });
console.log(JSON.stringify(status));
