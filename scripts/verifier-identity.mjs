import { createHash } from "node:crypto";

/** Hash verifier source independently of the checkout's text line endings. */
export function verifierSha256(source) {
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
  return createHash("sha256")
    .update(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"))
    .digest("hex");
}
