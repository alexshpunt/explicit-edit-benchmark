import { createHash } from "node:crypto";
import { canonicalizeProject } from "../grading/canonical-snapshot.mjs";
import { decodeSourceBytes, encodeSourceBytes } from "../cpp/source-bytes.mjs";

export const CANONICAL_PROJECT_VERSION = "renderer-canonical-project-v2";
export const CANONICAL_CANDIDATE_POLICY = Object.freeze({
  version: "renderer-canonical-entry-inventory-v1",
  paths: "source-relative-or-byte-encoded",
  regularFiles: "all-captured-bytes",
  physicalEntries: "directory-symlink-unsupported",
  metadata: "exclude-host-locations-times-modes",
});

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const entryTypes = new Set(["file", "directory", "symlink", "unsupported"]);

function invalid(reason) {
  return Object.assign(new Error("Canonical candidate inventory is inconsistent"), {
    category: "infrastructure",
    code: "CANONICAL_CANDIDATE_INVALID",
    reason,
  });
}

function requireInput(condition, reason) {
  if (!condition) throw invalid(reason);
}

function base64(value) {
  requireInput(typeof value === "string", "base64");
  const bytes = Buffer.from(value, "base64");
  requireInput(bytes.toString("base64") === value, "base64");
  return bytes;
}

function relativePath(bytes) {
  // These delimiters are ASCII bytes even when a component is not UTF-8.
  requireInput(bytes.length > 0 && bytes[0] !== 47 && !bytes.includes(0), "path");
  requireInput(
    bytes
      .toString("latin1")
      .split("/")
      .every((part) => part && part !== "." && part !== ".."),
    "path",
  );
  return bytes;
}

function decoded(bytes) {
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes) ? text : null;
}

function entryKey(bytes) {
  const file = decoded(bytes);
  // The generic canonicalizer rejects ambiguous presentation paths. Valid POSIX
  // entries outside that presentation remain measured through original bytes.
  const safe = file !== null && !/[\\\x00-\x1f\x7f]/.test(file) && !/^[A-Za-z]:/.test(file);
  return safe ? `source/${file}` : `bytes/${bytes.toString("base64url")}`;
}

function physicalText(key, entry) {
  return (
    JSON.stringify(["file", key]) +
    "\n" +
    JSON.stringify([
      "physical-entry",
      entry.type,
      ...(entry.type === "symlink" ? [entry.targetBytes] : []),
    ]) +
    "\n"
  );
}

async function canonicalInventory(entries, contents) {
  const known = new Map(),
    rows = [];
  let regular = 0;
  for (const entry of entries) {
    requireInput(entry && typeof entry === "object" && !Array.isArray(entry), "entry");
    requireInput(entryTypes.has(entry.type), "entry-type");
    const bytes = relativePath(base64(entry.pathBytes));
    requireInput(entry.path === decoded(bytes), "decoded-path");
    requireInput(!known.has(entry.pathBytes), "duplicate-path");
    if (entry.type === "file") {
      const value = contents.get(entry.pathBytes);
      requireInput(Buffer.isBuffer(value), "contents");
      requireInput(
        typeof entry.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(entry.sha256) &&
          hash(value) === entry.sha256,
        "hash",
      );
      regular++;
    } else {
      requireInput(!contents.has(entry.pathBytes), "contents");
      if (entry.type === "symlink") {
        const target = base64(entry.targetBytes);
        requireInput(target.length > 0 && !target.includes(0), "symlink-target");
      }
    }
    known.set(entry.pathBytes, entry);
    rows.push({ entry, bytes, key: entryKey(bytes) });
  }
  requireInput(contents.size === regular, "contents");
  for (const { bytes } of rows) {
    for (let slash = bytes.indexOf(47); slash >= 0; slash = bytes.indexOf(47, slash + 1)) {
      const parent = known.get(bytes.subarray(0, slash).toString("base64"));
      requireInput(parent?.type === "directory", "parent");
    }
  }
  rows.sort((left, right) => order(left.key, right.key));
  const source = Object.fromEntries(
    rows
      .filter(({ entry }) => entry.type === "file")
      .map(({ entry, key }) => [key, decodeSourceBytes(contents.get(entry.pathBytes))]),
  );
  const parsed = await canonicalizeProject(source);
  const files = new Map(Object.entries(parsed.files));
  for (const { entry, key } of rows) {
    if (entry.type !== "file") files.set(key, physicalText(key, entry));
  }
  const snapshot = {
    version: CANONICAL_PROJECT_VERSION,
    canonicalizer: parsed.canonicalizer,
    inventory: CANONICAL_CANDIDATE_POLICY,
    files: Object.fromEntries([...files].sort(([left], [right]) => order(left, right))),
    errors: parsed.errors,
  };
  return { ...snapshot, sha256: hash(JSON.stringify(snapshot)) };
}

/** Canonicalize only sealed capture data, never live files or symlink targets.
 * Missing all-file bytes or a changed manifest/content pairing is a verifier
 * input failure. Syntax and encoding damage stay visible in measured content.
 */
export async function canonicalizeCapturedCandidate(candidate) {
  requireInput(candidate && typeof candidate === "object", "candidate");
  requireInput(
    candidate.manifest?.version === "renderer-candidate-evidence-v1" &&
      Array.isArray(candidate.manifest.entries),
    "manifest",
  );
  requireInput(candidate.contents instanceof Map, "contents");
  return canonicalInventory(candidate.manifest.entries, candidate.contents);
}

function trustedBytes(source) {
  try {
    return encodeSourceBytes(source);
  } catch (cause) {
    throw Object.assign(invalid("source-encoding"), { cause });
  }
}

/** Trusted regular-file trees acquire the same explicit directory inventory as
 * a physical capture. Tree strings use the existing lossless source-byte codec.
 */
export async function canonicalizeTrustedProject(tree) {
  requireInput(
    tree && typeof tree === "object" && !Array.isArray(tree) && !Buffer.isBuffer(tree),
    "tree",
  );
  requireInput([Object.prototype, null].includes(Object.getPrototypeOf(tree)), "tree");
  const entries = new Map(),
    contents = new Map();
  for (const [file, source] of Object.entries(tree)) {
    const bytes = relativePath(trustedBytes(file));
    requireInput(typeof source === "string" || Buffer.isBuffer(source), "contents");
    const value = typeof source === "string" ? trustedBytes(source) : source;
    const pathBytes = bytes.toString("base64");
    requireInput(!entries.has(pathBytes) || entries.get(pathBytes).type === "file", "parent");
    entries.set(pathBytes, { type: "file", path: decoded(bytes), pathBytes, sha256: hash(value) });
    contents.set(pathBytes, value);
    for (let slash = bytes.indexOf(47); slash >= 0; slash = bytes.indexOf(47, slash + 1)) {
      const parent = bytes.subarray(0, slash),
        parentBytes = parent.toString("base64");
      requireInput(
        !entries.has(parentBytes) || entries.get(parentBytes).type === "directory",
        "parent",
      );
      entries.set(parentBytes, {
        type: "directory",
        path: decoded(parent),
        pathBytes: parentBytes,
      });
    }
  }
  return canonicalInventory([...entries.values()], contents);
}
