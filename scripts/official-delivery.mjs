import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { uploadFiles, whoAmI } from "@huggingface/hub";
import { resolveHuggingFaceToken } from "./huggingface-auth.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const defaultHub = { uploadFiles, whoAmI };

function candidateNumber(url) {
  const match = String(url).match(/\/discussions\/(\d+)(?:$|[/?#])/u);
  if (!match) throw Error("Hugging Face returned an invalid candidate URL");
  return Number(match[1]);
}

function authorization(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** Classify one transport identity before publication or acceptance. */
export function classifyOfficialDelivery(existing, candidate) {
  const match = existing.find((item) => item.executionId === candidate.executionId);
  if (!match) return "new";
  if (match.artifactSha256 === candidate.artifactSha256) return "duplicate";
  return "conflict";
}

function retryable(error) {
  const status = error?.statusCode ?? error?.status ?? error?.response?.status;
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

/** Retry only temporary transport failures, with bounded exponential backoff. */
export async function withDeliveryRetry(operation, options = {}) {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { status: "delivered", attempt, value: await operation(attempt) };
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt === attempts)
        return {
          status: "deferred",
          attempt,
          reason: `temporary-http-${error.statusCode ?? error.status ?? error.response.status}`,
        };
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw Error("delivery retry loop ended unexpectedly");
}

/** Wait until main contains the acceptance record for the exact delivered candidate bytes. */
export async function waitForOfficialAcceptance({
  repository,
  delivery,
  accessToken,
  attempts = 60,
  delayMs = 10_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  fetchImpl = fetch,
}) {
  if (!REPOSITORY.test(repository ?? "")) throw Error("Dataset repository must be owner/name");
  if (delivery.status !== "delivered") return null;
  const token = await resolveHuggingFaceToken({ accessToken });
  if (!token) throw Error("HF_TOKEN is required for acceptance recovery");
  const url = `https://huggingface.co/datasets/${repository}/resolve/main/source/official/${delivery.executionId}/acceptance.json`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(url, { headers: authorization(token), redirect: "follow" });
    if (response.status === 404) {
      if (attempt < attempts) await sleep(delayMs);
      continue;
    }
    if (!response.ok) {
      const error = Object.assign(Error(`Acceptance lookup failed (${response.status})`), {
        statusCode: response.status,
      });
      if (!retryable(error)) throw error;
      if (attempt < attempts) {
        await sleep(delayMs);
        continue;
      }
      return null;
    }
    const acceptance = await response.json();
    for (const [field, expected, label] of [
      ["executionId", delivery.executionId, "execution identity"],
      ["artifactSha256", delivery.artifactSha256, "artifact digest"],
      ["candidateNumber", delivery.candidateNumber, "candidate number"],
      ["candidateCommit", delivery.candidateCommit, "candidate commit"],
      ["signerWorkflowSha", delivery.signerWorkflowSha, "signer workflow"],
    ])
      if (acceptance[field] !== expected)
        throw Error(`Acceptance ${label} does not match delivered candidate`);
    const datasetCommit = response.headers.get("x-repo-commit");
    if (!/^[a-f0-9]{40}$/u.test(datasetCommit ?? ""))
      throw Error("Acceptance response has no immutable Dataset commit");
    return { ...acceptance, datasetCommit };
  }
  return null;
}

/** Add the immutable Dataset receipt and close the contributor's own candidate PR. */
export async function closeAcceptedOfficialCandidate({
  repository,
  delivery,
  receipt,
  accessToken,
  fetchImpl = fetch,
}) {
  if (!receipt) return { status: "deferred", reason: "acceptance-pending" };
  const token = await resolveHuggingFaceToken({ accessToken });
  if (!token) throw Error("HF_TOKEN is required to close the accepted candidate");
  const comment = `Accepted verified execution ${delivery.executionId} in Dataset commit ${receipt.datasetCommit}.`;
  const response = await fetchImpl(
    `https://huggingface.co/api/datasets/${repository}/discussions/${delivery.candidateNumber}/status`,
    {
      method: "POST",
      headers: authorization(token),
      body: JSON.stringify({ status: "closed", comment }),
    },
  );
  if (!response.ok) {
    const text = typeof response.text === "function" ? await response.text() : "";
    const error = Object.assign(
      Error(`Hugging Face candidate close failed (${response.status}): ${text}`),
      { statusCode: response.status },
    );
    if (retryable(error))
      return { status: "deferred", reason: `temporary-http-${response.status}` };
    throw error;
  }
  return {
    status: "accepted",
    executionId: delivery.executionId,
    candidateNumber: delivery.candidateNumber,
    candidateCommit: delivery.candidateCommit,
    datasetCommit: receipt.datasetCommit,
  };
}

/** Resume acceptance polling and candidate closure without rerunning inference or rebuilding bytes. */
export async function recoverOfficialDelivery({
  repository,
  delivery,
  accessToken,
  statusFile,
  wait = {},
  fetchImpl = fetch,
}) {
  let status;
  try {
    const receipt = await waitForOfficialAcceptance({
      repository,
      delivery,
      accessToken,
      fetchImpl,
      ...wait,
    });
    const closed = await closeAcceptedOfficialCandidate({
      repository,
      delivery,
      receipt,
      accessToken,
      fetchImpl,
    });
    status =
      closed.status === "accepted"
        ? { ...delivery, ...closed, phase: "closed" }
        : { ...delivery, ...closed, phase: receipt ? "close" : "acceptance" };
  } catch (error) {
    status = {
      ...delivery,
      status: "close-failed",
      phase: "close",
      reason: error.message,
    };
  }
  if (statusFile) await writeFile(path.resolve(statusFile), `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

/** Build stable transport metadata without changing the producer execution identity. */
export async function officialTransportMetadata({ artifact, manifest, signerWorkflowSha }) {
  const bytes = await readFile(path.resolve(artifact));
  const official = JSON.parse(await readFile(path.resolve(manifest), "utf8"));
  const executionId = official.executionIdentity?.executionId;
  if (!SHA256.test(executionId ?? "")) throw Error("official manifest has invalid executionId");
  if (!/^[a-f0-9]{40}$/.test(signerWorkflowSha ?? "")) throw Error("invalid signer workflow SHA");
  return {
    schemaVersion: 1,
    executionId,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    producer: {
      repository: official.executionIdentity.repository,
      runId: official.executionIdentity.runId,
      producerAttempt: official.executionIdentity.producerAttempt,
      invocation: official.executionIdentity.invocation,
    },
    signerWorkflowSha,
  };
}

async function findExistingOfficialCandidate(repository, executionId, token, fetchImpl = fetch) {
  const headers = authorization(token);
  const response = await fetchImpl(
    `https://huggingface.co/api/datasets/${repository}/discussions?status=open`,
    { headers },
  );
  if (!response.ok) {
    const error = Object.assign(Error(`Candidate lookup failed (${response.status})`), {
      statusCode: response.status,
    });
    if (retryable(error)) return null;
    throw error;
  }
  const title = `Contribute official benchmark execution ${executionId}`;
  const discussion = (await response.json()).discussions.find(
    (item) => item.isPullRequest && item.status === "open" && item.title === title,
  );
  if (!discussion) return null;
  const detailsResponse = await fetchImpl(
    `https://huggingface.co/api/datasets/${repository}/discussions/${discussion.num}`,
    { headers },
  );
  if (!detailsResponse.ok)
    throw Object.assign(Error(`Candidate details failed (${detailsResponse.status})`), {
      statusCode: detailsResponse.status,
    });
  const details = await detailsResponse.json();
  const commit = details.events.findLast((event) => event.type === "commit")?.data?.oid;
  if (!/^[a-f0-9]{40}$/u.test(commit ?? "")) throw Error("Existing candidate has no head commit");
  return {
    pullRequestUrl: `https://huggingface.co/datasets/${repository}/discussions/${discussion.num}`,
    candidateNumber: discussion.num,
    candidateCommit: commit,
    recovered: true,
  };
}
/** Upload the original signed bytes as a candidate. Retry never rebuilds the archive. */
export async function submitOfficialCandidate({
  artifact,
  attestation,
  manifest,
  signerWorkflowSha,
  repository,
  accessToken,
  statusFile,
  hub = defaultHub,
  retry = {},
  findExisting = findExistingOfficialCandidate,
}) {
  if (!REPOSITORY.test(repository ?? "")) throw Error("Dataset repository must be owner/name");
  const token = await resolveHuggingFaceToken({ accessToken });
  if (!token) throw Error("HF_TOKEN is required for official delivery");
  const metadata = await officialTransportMetadata({ artifact, manifest, signerWorkflowSha });
  const identity = await hub.whoAmI({ accessToken: token });
  const prefix = `candidates/official/${metadata.executionId}`;
  const transport = {
    ...metadata,
    submitter: identity.name,
  };
  const files = [
    { path: `${prefix}/official-result.tar.gz`, content: new Blob([await readFile(artifact)]) },
    { path: `${prefix}/attestation.jsonl`, content: new Blob([await readFile(attestation)]) },
    {
      path: `${prefix}/transport.json`,
      content: new Blob([`${JSON.stringify(transport, null, 2)}\n`]),
    },
  ];
  const existing = await findExisting(repository, metadata.executionId, token);
  const outcome = existing
    ? { status: "delivered", attempt: 0, value: existing }
    : await withDeliveryRetry(async () => {
        const result = await hub.uploadFiles({
          repo: { type: "dataset", name: repository },
          accessToken: token,
          files,
          isPullRequest: true,
          commitTitle: `Contribute official benchmark execution ${metadata.executionId}`,
        });
        if (!result.pullRequestUrl || !result.commit.oid)
          throw Error("Hugging Face did not return a candidate receipt");
        return {
          pullRequestUrl: result.pullRequestUrl,
          candidateNumber: candidateNumber(result.pullRequestUrl),
          candidateCommit: result.commit.oid,
          recovered: false,
        };
      }, retry);
  const status = {
    schemaVersion: 1,
    status: outcome.status,
    executionId: metadata.executionId,
    artifactSha256: metadata.artifactSha256,
    attempts: outcome.attempt,
    signerWorkflowSha,
    ...(outcome.status === "delivered" ? outcome.value : { reason: outcome.reason }),
  };
  if (statusFile) await writeFile(path.resolve(statusFile), `${JSON.stringify(status, null, 2)}\n`);
  return status;
}
