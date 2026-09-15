import { test } from "node:test";
import assert from "node:assert/strict";
import { verifierSha256 } from "../../scripts/verifier-identity.mjs";

await test("verifier identity is the same for LF and CRLF checkouts", () => {
  const source = "export const first = 1;\nexport const second = 2;\n";
  assert.equal(verifierSha256(source), verifierSha256(source.replaceAll("\n", "\r\n")));
});
