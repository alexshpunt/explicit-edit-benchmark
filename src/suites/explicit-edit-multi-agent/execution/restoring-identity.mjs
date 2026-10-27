import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { suiteVerifier } from "../source-identity.mjs";

const exec = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The suite verifier alone does not bind CLI, harness or dependency code.
 * Only a clean, exact commit can authorize measured restoring execution.
 * Ignored private configuration and evidence never enter the source inventory.
 */
export async function restoringSourceIdentity(
  root = fileURLToPath(new URL("../../../../", import.meta.url)),
) {
  const cwd = path.resolve(root);
  const git = async (...args) => (await exec("git", args, { cwd, encoding: "utf8" })).stdout;
  const sourceCommit = (await git("rev-parse", "HEAD")).trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const files = (
    await git("ls-files", "-z", "--", "src", "scripts", "package.json", "package-lock.json")
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.ok(files.length > 0, "Missing tracked restoring runner source");
  const sources = [];
  for (const file of files) sources.push([file, digest(await readFile(path.join(cwd, file)))]);
  const verifierSha256 = await suiteVerifier(
    pathToFileURL(path.join(cwd, "src/suites/explicit-edit-multi-agent/")),
  );
  return {
    sourceCommit,
    sourceClean: (await git("status", "--porcelain=v1", "--untracked-files=all")).trim() === "",
    verifierSha256,
    runnerSha256: digest(JSON.stringify(sources)),
  };
}
