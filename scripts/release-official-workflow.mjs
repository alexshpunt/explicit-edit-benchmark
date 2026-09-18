#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SHA = /^[0-9a-f]{40}$/u;
const WORKFLOW = ".github/workflows/official-run.yml";
const PI_AGENT_IDE_WORKFLOW = ".github/workflows/benchmark.yml";
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

export function pinPiAgentIdeWorkflow(text, workflowSha, policySha) {
  let workflowCount = 0;
  const updated = text.replace(
    /(official-(?:run|submit)\.yml@|signer_sha:\s*)[0-9a-f]{40}/gu,
    (match, prefix) => {
      workflowCount += 1;
      return `${prefix}${workflowSha}`;
    },
  );
  if (workflowCount !== 3)
    throw Error(`Unexpected Pi Agent IDE workflow pin layout: ${workflowCount}`);

  let policyCount = 0;
  const complete = updated.replace(/(policy_sha:\s*)[0-9a-f]{40}/gu, (match, prefix) => {
    policyCount += 1;
    return `${prefix}${policySha}`;
  });
  if (policyCount !== 2) throw Error(`Unexpected Pi Agent IDE policy pin layout: ${policyCount}`);
  return complete;
}

/**
 * Maintainer-only release transaction. It derives every pin from committed Git state.
 */
export async function releaseOfficialWorkflow({
  root = process.cwd(),
  templateDirectory,
  callerDirectories = [],
  piAgentIdeDirectories = [],
}) {
  requireMaintainerAutomation();
  root = path.resolve(root);
  templateDirectory = path.resolve(templateDirectory);
  callerDirectories = callerDirectories.map((directory) => path.resolve(directory));
  piAgentIdeDirectories = piAgentIdeDirectories.map((directory) => path.resolve(directory));
  requireClean(root);
  requireClean(templateDirectory);
  for (const directory of [...callerDirectories, ...piAgentIdeDirectories]) requireClean(directory);
  if (git(root, "branch", "--show-current") === "main")
    throw Error("Create a release branch before updating official workflow pins");

  const runnerSha = commitSha(root);
  const policyFile = path.join(root, POLICY);
  const policy = JSON.parse(await readFile(policyFile, "utf8"));
  if (
    !policy.workflows.some(
      ({ sha, runnerSha: runner }) => sha === runnerSha && runner === runnerSha,
    )
  )
    policy.workflows.push({ sha: runnerSha, runnerSha, status: "active" });
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  execFileSync("npx", ["--no-install", "oxfmt", POLICY], {
    cwd: root,
    stdio: "inherit",
  });
  const policySha = commit(root, "Approve official workflow release", [POLICY]);

  const templateFile = path.join(templateDirectory, WORKFLOW);
  await writeFile(
    templateFile,
    pinCallerTemplate(await readFile(templateFile, "utf8"), runnerSha, policySha),
  );
  const templateSha = commit(templateDirectory, "Pin official benchmark workflow release", [
    WORKFLOW,
  ]);

  const callerShas = [];
  for (const directory of callerDirectories) {
    const callerFile = path.join(directory, WORKFLOW);
    await writeFile(
      callerFile,
      pinCallerTemplate(await readFile(callerFile, "utf8"), runnerSha, policySha),
    );
    callerShas.push(commit(directory, "Pin official benchmark workflow release", [WORKFLOW]));
  }

  const piAgentIdeShas = [];
  for (const directory of piAgentIdeDirectories) {
    const workflowFile = path.join(directory, PI_AGENT_IDE_WORKFLOW);
    await writeFile(
      workflowFile,
      pinPiAgentIdeWorkflow(await readFile(workflowFile, "utf8"), runnerSha, policySha),
    );
    piAgentIdeShas.push(
      commit(directory, "Pin official benchmark workflow release [skip ci]", [
        PI_AGENT_IDE_WORKFLOW,
      ]),
    );
  }

  return { workflowSha: runnerSha, policySha, templateSha, callerShas, piAgentIdeShas };
}

async function main() {
  requireMaintainerAutomation();
  const { values } = parseArgs({
    options: {
      "template-directory": { type: "string" },
      "caller-directory": { type: "string", multiple: true, default: [] },
      "pi-agent-ide-directory": { type: "string", multiple: true, default: [] },
    },
  });
  if (!values["template-directory"])
    throw Error(
      "Usage: release-official-workflow --template-directory PATH [--caller-directory PATH ...] [--pi-agent-ide-directory PATH ...]",
    );
  const result = await releaseOfficialWorkflow({
    templateDirectory: values["template-directory"],
    callerDirectories: values["caller-directory"],
    piAgentIdeDirectories: values["pi-agent-ide-directory"],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
