import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { verifierSha256 } from "../../../scripts/verifier-identity.mjs";

/** Portable identity of the trusted suite, excluding private state and outputs. */
export async function suiteVerifier(root = new URL("./", import.meta.url)) {
  const sources = [];
  async function visit(directory, relative = "") {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = relative + item.name;
      const file = new URL(item.name + (item.isDirectory() ? "/" : ""), directory);
      if (item.isDirectory()) await visit(file, name + "/");
      else if (item.isFile() && /\.(?:mjs|py)$/.test(name))
        sources.push([name, verifierSha256(await readFile(file))]);
    }
  }
  await visit(root);
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}
