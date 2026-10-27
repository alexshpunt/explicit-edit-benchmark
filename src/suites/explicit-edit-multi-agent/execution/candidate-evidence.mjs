import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, watch } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { lstat, mkdir, open, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeSourceBytes } from "../cpp/source-bytes.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const metadata = (value) =>
  Object.fromEntries(
    ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].map((key) => [key, String(value[key])]),
  );
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const journals = new Map();
const boundaries = new WeakMap();

function journalFor(workspace, root) {
  let journal = journals.get(workspace);
  if (!journal) {
    journal = { root, version: 0, watchers: [], closed: false, error: null };
    journals.set(workspace, journal);
  }
  if (journal.root.dev !== root.dev || journal.root.ino !== root.ino) throw boundaryFailure();
  return journal;
}
function watchDirectory(directory, journal, watchers) {
  // Resolve only an already-open real directory. Never recurse through links.
  const watcher = watch(`/proc/self/fd/${directory.fd}`, () => journal.version++);
  watcher.on("error", (error) => {
    journal.error ??= error;
  });
  watcher.unref();
  watchers.push(watcher);
}
async function flushJournal(journal, version) {
  // Process ready filesystem notifications, without a timer or a grace period.
  await setImmediate();
  if (!journal || journal.closed)
    throw boundaryFailure(
      Object.assign(new Error("Candidate journal is unavailable"), {
        code: "CANDIDATE_JOURNAL_CLOSED",
      }),
    );
  if (journal.error) throw boundaryFailure(journal.error);
  if (version !== undefined && journal.version !== version)
    throw boundaryFailure(
      Object.assign(new Error("Observed a candidate filesystem write"), {
        code: "CANDIDATE_WRITE_EVENT",
      }),
    );
}

/** Release the current workspace watches after its persistent editors have closed. */
export function releaseCandidateWorkspace(workspace) {
  const root = path.resolve(workspace),
    journal = journals.get(root);
  if (!journal) return;
  journal.closed = true;
  for (const watcher of journal.watchers) watcher.close();
  journal.watchers = [];
  journals.delete(root);
}
function boundaryFailure(cause) {
  return Object.assign(new Error("Candidate changed outside an editing delivery", { cause }), {
    category: "infrastructure",
  });
}
function decode(bytes) {
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes) ? text : null;
}

/** Walk through directory descriptors, never through candidate directory symlinks.
 * Preserve raw bytes before interpreting source. The separate mirror retains file
 * and symlink contents; its private manifest also records unsupported entry types.
 */
async function inspect(workspace, { source, signal, observe = false } = {}) {
  signal?.throwIfAborted();
  const root = await open(
    workspace,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const entries = [],
    invalid = [],
    files = [],
    tree = {},
    lexicalTree = {};
  const watchers = [];
  let before,
    journal = null,
    version,
    installed = false;
  async function visit(directory, prefix) {
    if (journal && prefix.length) watchDirectory(directory, journal, watchers);
    const parent = Buffer.from(`/proc/self/fd/${directory.fd}/`);
    const names = await readdir(`/proc/self/fd/${directory.fd}`, { encoding: "buffer" });
    names.sort(Buffer.compare);
    for (const name of names) {
      signal?.throwIfAborted();
      const relative = prefix.length ? Buffer.concat([prefix, Buffer.from("/"), name]) : name;
      const location = Buffer.concat([parent, name]);
      const mirrored = source ? Buffer.concat([Buffer.from(`${source}/`), relative]) : null;
      const info = await lstat(location, { bigint: true });
      const pathname = decode(relative);
      const entry = { path: pathname, pathBytes: relative.toString("base64"), ...metadata(info) };
      if (pathname === null)
        invalid.push({ path: null, pathBytes: entry.pathBytes, reason: "filename" });
      if (pathname !== null && /\.(?:cpp|h)$/.test(pathname)) files.push(pathname);
      if (info.isDirectory()) {
        entry.type = "directory";
        if (mirrored) await mkdir(mirrored);
        const child = await open(
          location,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          if (!same(metadata(await child.stat({ bigint: true })), metadata(info)))
            throw boundaryFailure();
          entries.push(entry);
          await visit(child, relative);
          if (!same(metadata(await child.stat({ bigint: true })), metadata(info)))
            throw boundaryFailure();
        } finally {
          await child.close();
        }
      } else if (info.isFile()) {
        entry.type = "file";
        const handle = await open(
          location,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let bytes;
        try {
          if (!same(metadata(await handle.stat({ bigint: true })), metadata(info)))
            throw boundaryFailure();
          bytes = await handle.readFile();
          if (!same(metadata(await handle.stat({ bigint: true })), metadata(info)))
            throw boundaryFailure();
        } finally {
          await handle.close();
        }
        entry.sha256 = hash(bytes);
        if (mirrored) await writeFile(mirrored, bytes, { flag: "wx", mode: 0o600 });
        if (pathname !== null && /\.(?:cpp|h)$/.test(pathname)) {
          const text = decode(bytes);
          lexicalTree[pathname] = text ?? decodeSourceBytes(bytes);
          if (text === null) invalid.push({ path: pathname, reason: "utf8" });
          else tree[pathname] = text;
        }
        entries.push(entry);
      } else if (info.isSymbolicLink()) {
        entry.type = "symlink";
        const target = await readlink(location, { encoding: "buffer" });
        entry.target = decode(target);
        entry.targetBytes = target.toString("base64");
        if (mirrored) await symlink(target, mirrored);
        invalid.push({ path: pathname, reason: "symlink" });
        entries.push(entry);
      } else {
        entry.type = "unsupported";
        invalid.push({ path: pathname, reason: "entry-type" });
        entries.push(entry);
      }
      if (!same(metadata(await lstat(location, { bigint: true })), metadata(info)))
        throw boundaryFailure();
    }
  }
  try {
    before = metadata(await root.stat({ bigint: true }));
    journal = observe ? journalFor(workspace, before) : null;
    if (journal) {
      watchDirectory(root, journal, watchers);
      await flushJournal(journal);
      version = journal.version;
    }
    await visit(root, Buffer.alloc(0));
    const after = metadata(await root.stat({ bigint: true }));
    const named = metadata(await lstat(workspace, { bigint: true }));
    if (!same(before, after) || !same(after, named)) throw boundaryFailure();
    if (journal) {
      await flushJournal(journal, version);
      // Refresh the full watch set while old watches still cover the boundary.
      // This also handles removed/recreated directories and inode reuse. Keep at
      // most two directory inventories during capture, only one between captures.
      for (const watcher of journal.watchers) watcher.close();
      journal.watchers = watchers;
      installed = true;
    }
    const boundaryIdentity = hash(JSON.stringify({ root: before, entries }));
    const identity = hash(
      JSON.stringify(
        entries.map(({ pathBytes, type, sha256, targetBytes }) => ({
          pathBytes,
          type,
          sha256,
          targetBytes,
        })),
      ),
    );
    return {
      ...(journal ? { journal, version } : {}),
      tree,
      lexicalTree,
      files: files.sort(),
      invalid,
      identity,
      boundaryIdentity,
      manifest: {
        version: "renderer-candidate-evidence-v1",
        root: before,
        entries,
        identity,
        boundaryIdentity,
      },
    };
  } finally {
    if (!installed) for (const watcher of watchers) watcher.close();
    await root.close();
  }
}

export async function captureCandidate(workspace, evidence, { signal } = {}) {
  const root = path.resolve(workspace),
    output = path.resolve(evidence);
  const relative = path.relative(root, output);
  assert.ok(
    relative === ".." || relative.startsWith(`..${path.sep}`),
    "Candidate evidence must be outside the workspace",
  );
  await mkdir(output, { mode: 0o700 });
  const source = path.join(output, "source");
  await mkdir(source, { mode: 0o700 });
  const { journal, version, ...candidate } = await inspect(root, { source, signal, observe: true });
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(candidate.manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await flushJournal(journal, version);
  const result = { ...candidate, source };
  boundaries.set(result, { journal, version });
  return result;
}

/** Reject detached/late writes instead of treating them as another model repair. */
export async function assertCandidateUnchanged(workspace, candidate, { signal } = {}) {
  signal?.throwIfAborted();
  try {
    const boundary = boundaries.get(candidate);
    await flushJournal(boundary?.journal, boundary?.version);
    const current = await inspect(path.resolve(workspace), { signal });
    await flushJournal(boundary.journal, boundary.version);
    if (current.boundaryIdentity !== candidate.boundaryIdentity) throw boundaryFailure();
  } catch (error) {
    signal?.throwIfAborted();
    throw error.category === "infrastructure" ? error : boundaryFailure(error);
  }
}
