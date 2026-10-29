import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureCandidate,
  assertCandidateUnchanged,
  releaseCandidateWorkspace,
} from "../../src/suites/explicit-edit-multi-agent/execution/candidate-evidence.mjs";
import {
  canonicalizeCapturedCandidate,
  canonicalizeTrustedProject,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-candidate.mjs";

const options = { skip: process.platform !== "linux" };
const invalidInput = { category: "infrastructure", code: "CANONICAL_CANDIDATE_INVALID" };
const encoded = (file) => Buffer.from(file).toString("base64");
const rawPath = (root, name) => Buffer.concat([Buffer.from(root + "/"), name]);
const physical = (snapshot, key) =>
  snapshot.files[key]
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "canonical-candidate-"));
  const workspace = path.join(root, "workspace");
  const cleanup = [];
  await mkdir(workspace);
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
    releaseCandidateWorkspace(workspace);
    await rm(root, { recursive: true, force: true });
  });
  let captures = 0;
  return {
    root,
    workspace,
    cleanup,
    async put(file, content) {
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      await writeFile(path.join(workspace, file), content);
    },
    capture(extra = { includeAllFiles: true }) {
      return captureCandidate(workspace, path.join(root, `capture-${captures++}`), extra);
    },
  };
}

test(
  "opt-in capture retains exact bytes for all regular files without changing legacy views",
  options,
  async (t) => {
    const f = await fixture(t);
    const source = Buffer.from([105, 110, 116, 32, 128, 59]);
    const binary = Buffer.from([0, 255, 1]);
    await f.put("main.cpp", source);
    await f.put("data.bin", binary);
    await f.put("support/item.h", "int value;\n");
    const legacy = await f.capture({});
    assert.equal(Object.hasOwn(legacy, "contents"), false);
    const captured = await f.capture();
    assert.equal(captured.contents instanceof Map, true);
    assert.equal(captured.contents.size, 3);
    assert.deepEqual(captured.contents.get(encoded("main.cpp")), source);
    assert.deepEqual(captured.contents.get(encoded("data.bin")), binary);
    for (const field of [
      "tree",
      "lexicalTree",
      "files",
      "invalid",
      "identity",
      "boundaryIdentity",
      "manifest",
    ]) {
      assert.deepEqual(captured[field], legacy[field]);
    }
    await assertCandidateUnchanged(f.workspace, captured);
    for (const includeAllFiles of [1, "true", null, {}, []]) {
      await assert.rejects(f.capture({ includeAllFiles }), { code: "ERR_ASSERTION" });
    }
  },
);

test(
  "captured and trusted canonical projects agree including parent directories and non-C++ files",
  options,
  async (t) => {
    const f = await fixture(t);
    const tree = {
      "src/main.cpp": "int z(){return 1;} int a(){return 2;}\n",
      "src/support/item.h": "#pragma once\nstruct Item { int value; };\n",
      "CMakeLists.txt": "set(VALUE 1)\n",
      "data.bin": Buffer.from([0, 255]),
    };
    for (const [file, content] of Object.entries(tree)) await f.put(file, content);
    const captured = await f.capture();
    const before = structuredClone(captured.manifest);
    const bytes = new Map(
      [...captured.contents].map(([file, value]) => [file, Buffer.from(value)]),
    );
    const actual = await canonicalizeCapturedCandidate(captured);
    const expected = await canonicalizeTrustedProject(tree);
    assert.deepEqual(actual, expected);
    assert.equal(actual.version, "renderer-canonical-project-v1");
    assert.match(actual.sha256, /^[a-f0-9]{64}$/);
    const { sha256, ...sealed } = actual;
    assert.equal(sha256, createHash("sha256").update(JSON.stringify(sealed)).digest("hex"));
    assert.deepEqual(physical(actual, "source/src"), [
      ["file", "source/src"],
      ["physical-entry", "directory"],
    ]);
    assert.deepEqual(physical(actual, "source/src/support"), [
      ["file", "source/src/support"],
      ["physical-entry", "directory"],
    ]);
    assert.deepEqual(captured.manifest, before);
    assert.deepEqual(captured.contents, bytes);
    for (const [file, content] of Object.entries(tree)) {
      assert.deepEqual(await readFile(path.join(f.workspace, file)), Buffer.from(content));
    }
    await assertCandidateUnchanged(f.workspace, captured);
  },
);

test(
  "canonical inventory fixes every regular byte view before asynchronous parsing begins",
  options,
  async (t) => {
    const f = await fixture(t);
    const tree = { "a.h": "int a;", "z.h": "int z;" };
    for (const [file, content] of Object.entries(tree)) await f.put(file, content);
    const captured = await f.capture();
    const pending = canonicalizeCapturedCandidate(captured);
    const bytes = captured.contents.get(encoded("z.h"));
    const original = bytes[0];
    bytes[0] = 35;
    try {
      assert.deepEqual(await pending, await canonicalizeTrustedProject(tree));
    } finally {
      bytes[0] = original;
    }
    await assertCandidateUnchanged(f.workspace, captured);
  },
);

test(
  "canonical inventory ordering ignores manifest order and host capture metadata",
  options,
  async (t) => {
    const f = await fixture(t);
    await f.put("b.h", "int b;\n");
    await f.put("dir/a.h", "int a;\n");
    const captured = await f.capture();
    const changed = {
      ...captured,
      source: "/not-consulted",
      identity: "host-annotation",
      manifest: {
        ...captured.manifest,
        root: { dev: "different", ino: "different" },
        entries: [...captured.manifest.entries].reverse().map((entry) => ({
          ...entry,
          dev: "different",
          ino: "different",
          mode: "different",
          mtimeNs: "different",
        })),
      },
      contents: new Map([...captured.contents].reverse()),
    };
    assert.deepEqual(
      await canonicalizeCapturedCandidate(changed),
      await canonicalizeCapturedCandidate(captured),
    );
    assert.deepEqual(
      await canonicalizeTrustedProject({ "b.h": "int b;\n", "dir/a.h": "int a;\n" }),
      await canonicalizeTrustedProject({ "dir/a.h": "int a;\n", "b.h": "int b;\n" }),
    );
  },
);

test(
  "canonical captured projects normalize layout but retain damage in an otherwise unused body",
  options,
  async (t) => {
    const f = await fixture(t);
    const trusted = { "main.cpp": "int z(){return 1;} int unused(){return 2;}\n" };
    await f.put("main.cpp", "// note\nint unused() { return 2; }\nint z() {return 1;}\n");
    const normalized = await canonicalizeCapturedCandidate(await f.capture());
    assert.deepEqual(normalized, await canonicalizeTrustedProject(trusted));
    await f.put("main.cpp", "int z(){return 1;} int unused(){return 9;}\n");
    const damaged = await canonicalizeCapturedCandidate(await f.capture());
    assert.notEqual(damaged.files["source/main.cpp"], normalized.files["source/main.cpp"]);
    assert.notEqual(damaged.sha256, normalized.sha256);
  },
);

test(
  "extra opaque files and empty directories remain separate physical project entries",
  options,
  async (t) => {
    const f = await fixture(t);
    await f.put("main.cpp", "int value;\n");
    const expected = await canonicalizeTrustedProject({ "main.cpp": "int value;\n" });
    await f.put("extra.bin", Buffer.from([0, 255]));
    await mkdir(path.join(f.workspace, "empty"));
    const actual = await canonicalizeCapturedCandidate(await f.capture());
    assert.deepEqual(Object.keys(actual.files), [
      "source/empty",
      "source/extra.bin",
      "source/main.cpp",
    ]);
    assert.equal(actual.files["source/main.cpp"], expected.files["source/main.cpp"]);
    assert.ok(actual.files["source/extra.bin"].includes(Buffer.from([0, 255]).toString("base64")));
    assert.deepEqual(physical(actual, "source/empty"), [
      ["file", "source/empty"],
      ["physical-entry", "directory"],
    ]);
    assert.notEqual(actual.sha256, expected.sha256);
  },
);

test(
  "symlinks and directories named as C++ files have explicit types and are never read as source",
  options,
  async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.root, "outside.h");
    await writeFile(outside, "outside sentinel");
    await symlink(outside, path.join(f.workspace, "linked.h"));
    await mkdir(path.join(f.workspace, "directory.cpp"));
    const captured = await f.capture();
    assert.equal(captured.contents.size, 0);
    await rm(outside);
    const actual = await canonicalizeCapturedCandidate(captured);
    assert.deepEqual(Object.keys(actual.files), ["source/directory.cpp", "source/linked.h"]);
    const linkTokens = actual.files["source/linked.h"]
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(linkTokens, [
      ["file", "source/linked.h"],
      ["physical-entry", "symlink", Buffer.from(outside).toString("base64")],
    ]);
    assert.deepEqual(physical(actual, "source/directory.cpp"), [
      ["file", "source/directory.cpp"],
      ["physical-entry", "directory"],
    ]);
    assert.equal(JSON.stringify(actual).includes("outside sentinel"), false);
    assert.notEqual(
      actual.files["source/linked.h"],
      (await canonicalizeTrustedProject({ "linked.h": "outside sentinel" })).files[
        "source/linked.h"
      ],
    );
    await assertCandidateUnchanged(f.workspace, captured);
  },
);

test(
  "an actual unsupported Unix socket remains visible without being opened or mirrored",
  options,
  async (t) => {
    const f = await fixture(t);
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(f.workspace, "socket.h"), resolve);
    });
    f.cleanup.push(
      () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const captured = await f.capture();
    assert.equal(captured.manifest.entries[0].type, "unsupported");
    assert.equal(captured.contents.size, 0);
    const actual = await canonicalizeCapturedCandidate(captured);
    assert.deepEqual(physical(actual, "source/socket.h"), [
      ["file", "source/socket.h"],
      ["physical-entry", "unsupported"],
    ]);
    assert.notEqual(actual.sha256, (await canonicalizeTrustedProject({})).sha256);
  },
);

test(
  "malformed UTF-8 and unsafe POSIX filenames retain distinct bytes without path-key collisions",
  options,
  async (t) => {
    const f = await fixture(t);
    const invalidName = Buffer.from([0x80, 0x2e, 0x68]);
    const badSource = Buffer.from([105, 110, 116, 32, 128, 59]);
    await writeFile(rawPath(f.workspace, invalidName), badSource);
    await f.put("line\nname.h", "int hidden;\n");
    await f.put("back\\slash.h", "int other;\n");
    const encodedKey = "bytes/" + invalidName.toString("base64url");
    await f.put(encodedKey, "collision sentinel");
    await f.put("bad.cpp", badSource);
    const captured = await f.capture();
    assert.deepEqual(captured.contents.get(invalidName.toString("base64")), badSource);
    const actual = await canonicalizeCapturedCandidate(captured);
    assert.ok(Object.hasOwn(actual.files, encodedKey));
    assert.ok(Object.hasOwn(actual.files, "source/" + encodedKey));
    assert.notEqual(actual.files[encodedKey], actual.files["source/" + encodedKey]);
    assert.ok(
      Object.hasOwn(actual.files, "bytes/" + Buffer.from("line\nname.h").toString("base64url")),
    );
    assert.ok(
      Object.hasOwn(actual.files, "bytes/" + Buffer.from("back\\slash.h").toString("base64url")),
    );
    assert.ok(
      actual.errors.some((entry) => entry.file === "source/bad.cpp" && entry.kind === "encoding"),
    );
    const different = Buffer.from([105, 110, 116, 32, 129, 59]);
    await f.put("bad.cpp", different);
    const next = await canonicalizeCapturedCandidate(await f.capture());
    assert.notEqual(actual.files["source/bad.cpp"], next.files["source/bad.cpp"]);
    assert.deepEqual(await readFile(rawPath(f.workspace, invalidName)), badSource);
  },
);

test(
  "trusted trees and captured inventories use the same byte namespace for unsafe valid filenames",
  options,
  async (t) => {
    const f = await fixture(t);
    const tree = { "line\nname.h": "int value;", "nested/back\\name": Buffer.from([0, 255]) };
    for (const [file, bytes] of Object.entries(tree)) await f.put(file, bytes);
    assert.deepEqual(
      await canonicalizeCapturedCandidate(await f.capture()),
      await canonicalizeTrustedProject(tree),
    );
  },
);

test(
  "canonical inventory rejects missing byte capture, changed hashes and incomplete regular content maps",
  options,
  async (t) => {
    const f = await fixture(t);
    await f.put("main.cpp", "int value;\n");
    await assert.rejects(canonicalizeCapturedCandidate(await f.capture({})), invalidInput);
    const original = await f.capture();
    for (const contents of [
      undefined,
      {},
      new Map(),
      new Map([[encoded("main.cpp"), "not bytes"]]),
      new Map([[encoded("main.cpp"), Buffer.from("different")]]),
      new Map([...original.contents, [encoded("extra"), Buffer.alloc(0)]]),
    ]) {
      await assert.rejects(canonicalizeCapturedCandidate({ ...original, contents }), invalidInput);
    }
    const entry = original.manifest.entries[0];
    for (const sha256 of ["bad", "0".repeat(64), null]) {
      await assert.rejects(
        canonicalizeCapturedCandidate({
          ...original,
          manifest: { ...original.manifest, entries: [{ ...entry, sha256 }] },
        }),
        invalidInput,
      );
    }
  },
);

test(
  "canonical inventory rejects malformed internal paths, duplicate entries and impossible ancestry",
  options,
  async (t) => {
    const f = await fixture(t);
    await f.put("nested/main.cpp", "int value;\n");
    const original = await f.capture();
    const directory = original.manifest.entries.find((entry) => entry.type === "directory");
    const file = original.manifest.entries.find((entry) => entry.type === "file");
    for (const raw of [
      Buffer.alloc(0),
      Buffer.from("../escape"),
      Buffer.from("/absolute"),
      Buffer.from("a//b"),
      Buffer.from("a/./b"),
      Buffer.from([0]),
    ]) {
      const pathBytes = raw.toString("base64");
      await assert.rejects(
        canonicalizeCapturedCandidate({
          ...original,
          manifest: {
            ...original.manifest,
            entries: [{ ...file, path: raw.toString(), pathBytes }],
          },
          contents: new Map([[pathBytes, original.contents.get(file.pathBytes)]]),
        }),
        invalidInput,
      );
    }
    for (const entries of [
      [directory, file, file],
      [file],
      [{ ...directory, type: "file", sha256: file.sha256 }, file],
      [directory, { ...file, path: "other.cpp" }],
      [directory, { ...file, pathBytes: "!!!!" }],
      [directory, { ...file, type: "unrecognized" }],
    ]) {
      await assert.rejects(
        canonicalizeCapturedCandidate({ ...original, manifest: { ...original.manifest, entries } }),
        invalidInput,
      );
    }
  },
);

test("trusted canonical projects reject impossible paths and unsupported source values", async () => {
  for (const file of ["", "/absolute", "../escape", "a//b", "a/./b", "a/../b", "nul\0name"]) {
    await assert.rejects(canonicalizeTrustedProject({ [file]: "int value;" }), invalidInput);
  }
  await assert.rejects(canonicalizeTrustedProject({ "main.cpp": 42 }), invalidInput);
  await assert.rejects(canonicalizeTrustedProject({ "main.cpp": "\ud800" }), invalidInput);
  await assert.rejects(canonicalizeTrustedProject({ "\ud800": "int value;" }), invalidInput);
  await assert.rejects(
    canonicalizeTrustedProject({ a: "value", "a/b.h": "int value;" }),
    invalidInput,
  );
  await assert.rejects(canonicalizeTrustedProject(null), invalidInput);
});
