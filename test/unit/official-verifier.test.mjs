import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractOfficialArchive } from "../../scripts/official-verifier.mjs";

function header(name, size, type = "0") {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

async function archive(file, entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    chunks.push(header(entry.name, content.length, entry.type), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  await pipeline(
    Readable.from(Buffer.concat(chunks)),
    createGzip(),
    await import("node:fs").then((m) => m.createWriteStream(file)),
  );
}

test("official extraction accepts only the signed public layout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "official-archive-"));
  try {
    const file = path.join(root, "result.tar.gz");
    await archive(file, [
      { name: "official-manifest.json", content: "{}" },
      { name: "execution-plan.json", content: "{}" },
      { name: "installed-dependencies.json", content: "{}" },
      { name: "normalized/manifest.json", content: "{}" },
      { name: "normalized/profiles.jsonl", content: "" },
      { name: "normalized/configurations.jsonl", content: "" },
      { name: "normalized/trials.jsonl", content: "" },
      { name: "normalized/rounds.jsonl", content: "" },
      { name: "normalized/tool-calls.jsonl", content: "" },
    ]);
    const output = path.join(root, "out");
    await extractOfficialArchive(file, output);
    assert.equal(await readFile(path.join(output, "official-manifest.json"), "utf8"), "{}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official extraction rejects traversal and links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "official-archive-"));
  try {
    for (const [name, type] of [
      ["../escape", "0"],
      ["normalized/link", "2"],
    ]) {
      const file = path.join(root, `${type}.tar.gz`);
      await archive(file, [{ name, type }]);
      await assert.rejects(
        extractOfficialArchive(file, path.join(root, `out-${type}`)),
        /layout|regular file/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
