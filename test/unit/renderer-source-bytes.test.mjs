import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareFullExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/full-executor.mjs";
import {
  decodeSourceBytes,
  encodeSourceBytes,
  sourceByteOffsets,
} from "../../src/suites/explicit-edit-multi-agent/cpp/source-bytes.mjs";
import { byteToCharacter } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-offsets.mjs";
import { atomicOwnerFrames } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-naming-replay.mjs";

test("the isolated public editor stages the complete byte-coordinate dependency", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-byte-editor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stage = path.join(directory, "executor");
  await prepareFullExecutor(stage);
  const editor = await import(pathToFileURL(path.join(stage, "cpp/cpp-offsets.mjs")).href);
  assert.equal(editor.byteToCharacter("plain")(5), 5);
});
test("valid UTF-8 retains exact source text and compiler byte coordinates", () => {
  const source = 'const char* text = "a😀β";\nint value = 1;\n';
  assert.equal(decodeSourceBytes(Buffer.from(source)), source);
  assert.deepEqual(encodeSourceBytes(source), Buffer.from(source));
  const offsets = sourceByteOffsets(source);
  for (const word of ["const", "text", "int value", "value =", "1;"]) {
    const index = source.indexOf(word);
    assert.equal(offsets[index], Buffer.byteLength(source.slice(0, index)));
  }
});

test("every invalid byte survives lexical decoding without aliasing valid replacement characters", () => {
  const raw = Buffer.concat([
    Buffer.from('const char* text = "'),
    Buffer.from([0xff, 0xc0, 0xaf, 0xed, 0xa0, 0x80]),
    Buffer.from('�";\nint value;'),
  ]);
  const view = decodeSourceBytes(raw);
  assert.deepEqual(encodeSourceBytes(view), raw);
  assert.notEqual(view, raw.toString("utf8"));
  assert.equal(view.includes("\udcff\udcc0\udcaf\udced\udca0\udc80�"), true);
  const index = view.indexOf("int value");
  assert.equal(sourceByteOffsets(view)[index], raw.indexOf(Buffer.from("int value")));
});

test("all byte pairs round-trip without repaired or dropped input bytes", () => {
  const raw = Buffer.alloc(256 * 256 * 2);
  for (let left = 0; left < 256; left++)
    for (let right = 0; right < 256; right++) {
      const index = (left * 256 + right) * 2;
      raw[index] = left;
      raw[index + 1] = right;
    }
  const view = decodeSourceBytes(raw);
  assert.deepEqual(encodeSourceBytes(view), raw);
  assert.equal(sourceByteOffsets(view).at(-1), raw.length);
});

test("truncated multibyte sequences retain each original byte", () => {
  for (const bytes of [
    [0xe2],
    [0xe2, 0x82],
    [0xf0, 0x9f, 0x98],
    [0x80],
    [0xf5, 0x80, 0x80, 0x80],
  ]) {
    const raw = Buffer.from(bytes),
      view = decodeSourceBytes(raw);
    assert.deepEqual(encodeSourceBytes(view), raw);
    assert.equal(sourceByteOffsets(view).at(-1), raw.length);
  }
});

test("byte-view encoding rejects unpaired surrogates that do not represent original bytes", () => {
  for (const source of ["\ud800", "\udc01", "\udfff"]) {
    assert.throws(() => encodeSourceBytes(source));
    assert.throws(() => sourceByteOffsets(source));
  }
});

test("compiler coordinates in a lossless view retain invalid bytes and reject split Unicode", () => {
  const raw = Buffer.concat([Buffer.from("β😀"), Buffer.from([0xff]), Buffer.from(" value")]);
  const view = decodeSourceBytes(raw),
    locate = byteToCharacter(view);
  assert.equal(locate(6), view.indexOf("\udcff"));
  assert.equal(locate(8), view.indexOf("value"));
  assert.equal(locate(raw.length), view.length);
  for (const offset of [1, 3, 4, 5]) assert.throws(() => locate(offset));
});
test("physical lexical frames after malformed source bytes keep original compiler locations", () => {
  const raw = Buffer.concat([
    Buffer.from('const char* text = "'),
    Buffer.from([0xff]),
    Buffer.from('";\nint value = 1;\n'),
  ]);
  const frames = atomicOwnerFrames({ "main.cpp": decodeSourceBytes(raw) });
  const frame = frames.find(({ tokens }) => tokens.includes("value"));
  assert.ok(frame);
  const site = frame.positions[frame.tokens.indexOf("value")];
  assert.equal(site.start, raw.indexOf(Buffer.from("value")));
  assert.equal(site.end, site.start + 5);
});
