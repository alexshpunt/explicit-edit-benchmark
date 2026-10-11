import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Generate a private run credential file containing only the explicitly selected provider.
 * Never overwrite a target or print credential values. The receipt identifies the source snapshot.
 */
export async function prepareAuth(source, destination, provider) {
  assert.equal(provider, "openai-codex", "This renderer arm uses openai-codex only");
  const bytes = await readFile(source);
  const slot = JSON.parse(bytes.toString("utf8"))[provider];
  assert.equal(slot?.type, "oauth", "Expected an existing Pi OAuth login");
  assert.ok(
    typeof slot.access === "string" && typeof slot.refresh === "string",
    "Incomplete Pi OAuth login",
  );
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, JSON.stringify({ [provider]: slot }, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return { provider, sourceSha256: createHash("sha256").update(bytes).digest("hex") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(
      process.argv.length,
      5,
      "Usage: node prepare-auth.mjs PRIVATE_SOURCE NEW_PRIVATE_AUTH PROVIDER",
    );
    console.log(JSON.stringify(await prepareAuth(...process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
