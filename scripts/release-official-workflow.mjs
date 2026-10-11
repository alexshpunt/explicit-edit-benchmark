#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { approvedTeamRelease } from "./official-team-release.mjs";
import { validateOfficialPolicy } from "./official-policy.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const WORKFLOW = ".github/workflows/official-run.yml";
const RESUBMIT = ".github/workflows/resubmit.yml";
const POLICY = "policies/official-runs/v1.json";
const RELEASE_REPOSITORY = "alexshpunt/explicit-edit-benchmark";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function commitSha(root, revision = "HEAD") {
  const sha = git(root, "rev-parse", "--verify", `${revision}^{commit}`);
  if (!SHA.test(sha)) throw Error(`Git did not resolve a full commit SHA: ${revision}`);
  return sha;
}

function commit(root, message, files) {
  git(root, "add", "--", ...files);
  git(root, "commit", "-m", message);
  return commitSha(root);
}

function requireMaintainerAutomation() {
  if (
    process.env.OFFICIAL_RELEASE_AUTOMATION !== "1" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY ||
    !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "")
  )
    throw Error("Official workflow releases run only through the maintainer release workflow");
}

function requireClean(root) {
  const dirty = git(root, "status", "--porcelain");
  if (dirty) throw Error(`Release checkout must be clean:\n${dirty}`);
}

export function pinCallerTemplate(text, workflowSha, policySha) {
  let count = 0;
  const updated = text.replace(
    /(official-run\.yml@|signer_sha:\s*)[0-9a-f]{40}/gu,
    (match, prefix) => {
      count += 1;
      return `${prefix}${workflowSha}`;
    },
  );
  if (count !== 2) throw Error(`Unexpected caller workflow pin layout: ${count}`);
  let submitCount = 0;
  const complete = updated.replace(
    /(official-submit\.yml@|policy_sha:\s*)[0-9a-f]{40}/gu,
    (match, prefix) => {
      submitCount += 1;
      return `${prefix}${policySha}`;
    },
  );
  if (submitCount !== 3) throw Error(`Unexpected caller policy/submit pin layout: ${submitCount}`);
  return complete;
}

/** Upgrade the supported caller layout and bind both suites to one release.
 * Unknown layouts refuse instead of producing a partly configured workflow.
 */
export function prepareCallerTemplate(text, workflowSha, policySha) {
  let updated = pinCallerTemplate(text, workflowSha, policySha);
  const input = `      suite:
        description: Benchmark suite
        required: true
        default: explicit-edit
        type: choice
        options: [explicit-edit, explicit-edit-multi-agent]
`;
  if (!updated.includes(input)) {
    if (updated.includes("      suite:")) throw Error("Unexpected caller suite layout");
    const anchor = "      task:\n";
    if (updated.split(anchor).length !== 2) throw Error("Unexpected caller task input layout");
    updated = updated.replace(anchor, input + anchor);
  }
  const forwarding = "      suite: ${{ inputs.suite }}\n";
  if (!updated.includes(forwarding)) {
    const anchor = "      task: ${{ inputs.task }}\n";
    if (updated.split(anchor).length !== 2) throw Error("Unexpected caller task forwarding layout");
    updated = updated.replace(anchor, forwarding + anchor);
  }
  const concurrency =
    /      concurrency:\n        description: [^\n]+\n        required: false\n        default: "(?:10)?"\n        type: string\n/;
  if (!concurrency.test(updated)) throw Error("Unexpected caller concurrency layout");
  const taskDescription =
    '"Explicit Edit: optional task id; empty runs all 226 tasks. Multi-Agent: all 71 tasks; leave empty."';
  return updated
    .replace("Optional task id; empty runs all 226 canonical tasks", taskDescription)
    .replace("Optional Explicit Edit task; Multi-Agent always runs all 71 tasks", taskDescription)
    .replace(
      concurrency,
      `      concurrency:
        description: "Explicit Edit: full-run concurrency (default 10). Multi-Agent: fixed 15. Empty uses the suite default."
        required: false
        default: ""
        type: string
`,
    );
}

/** Upgrade submit-only recovery without changing the original artifact's signer.
 * New runs default to this release; older results need their original signer SHA,
 * which the reusable submit workflow checks against the trusted policy.
 */
export function prepareResubmitTemplate(text, workflowSha, policySha) {
  if (!SHA.test(workflowSha) || !SHA.test(policySha))
    throw Error("Recovery requires full workflow and policy commit SHAs");
  for (const name of ["producer_run_id", "producer_attempt"]) {
    const forwarding = `      ${name}: \${{ inputs.${name} }}\n`;
    if (text.split(forwarding).length !== 2)
      throw Error(`Unexpected recovery ${name} forwarding layout`);
  }
  const submitPin =
    /^(    uses: [^\n]+\/\.github\/workflows\/official-submit\.yml@)[0-9a-f]{40}$/gmu;
  if ([...text.matchAll(submitPin)].length !== 1)
    throw Error("Unexpected recovery submit pin layout");
  let updated = text.replace(submitPin, (_, prefix) => `${prefix}${policySha}`);
  const input = `      signer_sha:
        description: Original producer signer commit; use the original SHA for older results
        required: true
        default: "${workflowSha}"
        type: string
`;
  const inputPattern =
    /^      signer_sha:\n        description: Original producer signer commit; use the original SHA for older results\n        required: true\n        default: "[0-9a-f]{40}"\n        type: string\n/gmu;
  const signerForwarding = "      signer_sha: ${{ inputs.signer_sha }}\n";
  const inputCount = [...updated.matchAll(inputPattern)].length;
  if (inputCount === 1 && updated.split(signerForwarding).length === 2) {
    updated = updated.replace(inputPattern, input);
  } else {
    const legacySigner = /^      signer_sha: [0-9a-f]{40}\n/gmu;
    if (
      inputCount !== 0 ||
      [...updated.matchAll(legacySigner)].length !== 1 ||
      updated.split("      signer_sha:").length !== 2
    )
      throw Error("Unexpected recovery signer layout");
    const attemptInput = `      producer_attempt:
        description: Original workflow attempt
        required: true
        default: "1"
        type: string
`;
    if (updated.split(attemptInput).length !== 2)
      throw Error("Unexpected recovery attempt input layout");
    updated = updated
      .replace(attemptInput, attemptInput + input)
      .replace(legacySigner, signerForwarding);
  }
  if (updated.split("      signer_sha:").length !== 3)
    throw Error("Unexpected recovery signer layout");
  const policyPin = /^      policy_sha: [0-9a-f]{40}\n/gmu;
  const policyCount = [...updated.matchAll(policyPin)].length;
  if (policyCount === 1 && updated.split("policy_sha:").length === 2)
    return updated.replace(policyPin, `      policy_sha: ${policySha}\n`);
  if (policyCount !== 0 || updated.includes("policy_sha:"))
    throw Error("Unexpected recovery policy pin layout");
  return updated.replace(signerForwarding, signerForwarding + `      policy_sha: ${policySha}\n`);
}
/** Build a policy from committed runner identity and reviewed reference evidence. */
export async function prepareReleasePolicy(policy, runnerSha, root = process.cwd()) {
  if (!SHA.test(runnerSha)) throw Error("Release requires a full runner commit SHA");
  const updated = structuredClone(policy);
  updated.suites = await approvedTeamRelease(root);
  const existing = updated.workflows.find(({ sha }) => sha === runnerSha);
  if (existing) {
    if (existing.status !== "active" || existing.runnerSha !== runnerSha)
      throw Error("Release cannot reactivate or replace an existing signer");
  } else updated.workflows.push({ sha: runnerSha, runnerSha, status: "active" });
  return validateOfficialPolicy(updated);
}
/**
 * Maintainer-only release transaction. It derives every pin from committed Git state.
 */
export async function releaseOfficialWorkflow({
  root = process.cwd(),
  templateDirectory,
  callerDirectories = [],
}) {
  requireMaintainerAutomation();
  root = path.resolve(root);
  templateDirectory = path.resolve(templateDirectory);
  callerDirectories = callerDirectories.map((directory) => path.resolve(directory));
  requireClean(root);
  requireClean(templateDirectory);
  for (const directory of callerDirectories) requireClean(directory);
  if (git(root, "branch", "--show-current") === "main")
    throw Error("Create a release branch before updating official workflow pins");

  const runnerSha = commitSha(root);
  const policyFile = path.join(root, POLICY);
  const policy = await prepareReleasePolicy(
    JSON.parse(await readFile(policyFile, "utf8")),
    runnerSha,
    root,
  );
  const directories = [templateDirectory, ...callerDirectories];
  // Validate every layout before the first repository is changed. The real policy
  // commit does not exist yet; the runner SHA is only a validation placeholder.
  const callers = await Promise.all(
    directories.map(async (directory) => ({
      run: await readFile(path.join(directory, WORKFLOW), "utf8"),
      resubmit: await readFile(path.join(directory, RESUBMIT), "utf8"),
    })),
  );
  for (const caller of callers) {
    prepareCallerTemplate(caller.run, runnerSha, runnerSha);
    prepareResubmitTemplate(caller.resubmit, runnerSha, runnerSha);
  }
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  execFileSync("npx", ["--no-install", "oxfmt", POLICY], {
    cwd: root,
    stdio: "inherit",
  });
  const policySha = commit(root, "Approve official workflow release", [POLICY]);

  const revisions = [];
  for (const [index, directory] of directories.entries()) {
    await writeFile(
      path.join(directory, WORKFLOW),
      prepareCallerTemplate(callers[index].run, runnerSha, policySha),
    );
    await writeFile(
      path.join(directory, RESUBMIT),
      prepareResubmitTemplate(callers[index].resubmit, runnerSha, policySha),
    );
    revisions.push(
      commit(directory, "Pin official benchmark workflow release", [WORKFLOW, RESUBMIT]),
    );
  }
  return {
    workflowSha: runnerSha,
    policySha,
    templateSha: revisions[0],
    callerShas: revisions.slice(1),
  };
}

async function main() {
  requireMaintainerAutomation();
  const { values } = parseArgs({
    options: {
      "template-directory": { type: "string" },
      "caller-directory": { type: "string", multiple: true, default: [] },
    },
  });
  if (!values["template-directory"])
    throw Error(
      "Usage: release-official-workflow --template-directory PATH [--caller-directory PATH ...]",
    );
  const result = await releaseOfficialWorkflow({
    templateDirectory: values["template-directory"],
    callerDirectories: values["caller-directory"],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
