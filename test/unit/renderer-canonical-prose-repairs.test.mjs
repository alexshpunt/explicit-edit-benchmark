import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch } from "diff";
import { compareCanonicalSnapshots } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";
import { canonicalCorrectionNodes } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";

const view = (files) => ({ version: "fallback-fixture-v1", files });
const pathBytes = (file) =>
  file.startsWith("source/") ? Buffer.from(file.slice(7)) : Buffer.from(file.slice(6), "base64url");
function delta(hunks, file) {
  const lines = hunks
    .filter((hunk) => hunk.file === file)
    .flatMap((hunk) => [
      JSON.stringify(["hunk", hunk.oldStart, hunk.oldLines, hunk.newLines]),
      ...hunk.lines,
    ]);
  return lines.length ? lines.join("\n") + "\n" : "";
}

// The fallback corrects complete serialized common-baseline diffs, not physical owners.
function corrections(start, expected, actual) {
  const comparison = compareCanonicalSnapshots(view(start), view(expected), view(actual));
  const before = structuredClone(comparison);
  const nodes = canonicalCorrectionNodes(comparison);
  const records = nodes.map(({ prompt }) => JSON.parse(prompt));
  for (const file of new Set(comparison.mismatches.map((item) => item.file))) {
    const hunks = records
      .filter((row) => row.location.pathBytes === pathBytes(file).toString("base64"))
      .map(({ hunk }) => hunk);
    assert.ok(hunks.length > 0);
    assert.equal(
      applyPatch(delta(comparison.actualHunks, file), { hunks }),
      delta(comparison.expectedHunks, file),
    );
  }
  assert.deepEqual(comparison, before);
  assert.equal(new Set(nodes.map(({ id }) => id)).size, nodes.length);
  assert.ok(nodes.every(({ dependencies }) => dependencies.length === 0));
  return { comparison, nodes, records };
}

test("fallback instructions replay the entire directed diff without physical endpoint lookup", () => {
  const start = { "source/main.cpp": "int old_name = 1;\nint other = 2;\n" };
  const expected = { "source/main.cpp": "int new_name = 1;\nint other = 2;\n" };
  const actual = { "source/main.cpp": "int bad_name = 1;\nint other = 2;\n" };
  const { nodes, records } = corrections(start, expected, actual);
  assert.equal(nodes.length, 1);
  assert.equal(records[0].location.path, "main.cpp");
  assert.ok(nodes[0].prompt.includes("bad_name"));
  assert.ok(nodes[0].prompt.includes("new_name"));
});

test("opaque byte contents and symlink targets remain complete in fallback views", () => {
  const content = Buffer.from([0, 255, 96, 10]);
  const target = Buffer.from([128, 47, 97]);
  const expected = {
    "source/data.bin": `${JSON.stringify(["file", "source/data.bin"])}\n${JSON.stringify(["opaque-bytes", content.toString("base64")])}\n`,
    "source/link": `${JSON.stringify(["file", "source/link"])}\n${JSON.stringify(["physical-entry", "symlink", target.toString("base64")])}\n`,
  };
  const { nodes, records } = corrections({}, expected, {});
  assert.equal(nodes.length, 2);
  assert.ok(
    records
      .find((row) => row.location.path === "data.bin")
      .hunk.lines.some((line) => line.includes(content.toString("base64"))),
  );
  assert.ok(
    records
      .find((row) => row.location.path === "link")
      .hunk.lines.some((line) => line.includes(target.toString("base64"))),
  );
});

test("missing directories and files and unexpected entries stay explicit in fallback", () => {
  const { records } = corrections(
    {},
    {
      "source/nested": '["file","source/nested"]\n["physical-entry","directory"]\n',
      "source/nested/a.h": "int restored;\n",
    },
    { "source/extra.h": "int unwanted;\n" },
  );
  assert.deepEqual(records.map((row) => row.location.path).sort(), [
    "extra.h",
    "nested",
    "nested/a.h",
  ]);
  assert.ok(
    records
      .find((row) => row.location.path === "extra.h")
      .hunk.lines.some((line) => line.includes("int unwanted;")),
  );
  assert.ok(
    records
      .find((row) => row.location.path === "nested/a.h")
      .hunk.lines.some((line) => line.includes("int restored;")),
  );
});

test("control characters, markdown delimiters and malformed filename bytes retain exact identities", () => {
  for (const bytes of [
    Buffer.from("odd`name.cpp"),
    Buffer.from("odd\nname.cpp"),
    Buffer.from([0x80, 0x2e, 0x68]),
  ]) {
    const key = `bytes/${bytes.toString("base64url")}`;
    const retained = { "source/main.cpp": "int required;\n" };
    const { records } = corrections({}, retained, { ...retained, [key]: "int extra;\n" });
    assert.deepEqual(Buffer.from(records[0].location.pathBytes, "base64"), bytes);
    assert.equal(records[0].location.path, null);
  }
});

test("unsupported physical-entry records remain visible without controller materialization", () => {
  const file = "source/a.h";
  const unsupported = '["file","source/a.h"]\n["physical-entry","unsupported"]\n';
  const { records } = corrections({}, { [file]: "int restored;\n" }, { [file]: unsupported });
  assert.ok(records[0].hunk.lines.some((line) => line.includes("unsupported")));
  corrections({}, { [file]: unsupported }, {});
});

test("repeated source bodies do not require a guessed physical definition owner", () => {
  const body = "  int a = 1;\n".repeat(12) + "  int wrong = 2;\n" + "  int b = 3;\n".repeat(12);
  const actual = `void first() {\n${body}}\nvoid second() {\n${body}}\n`;
  const expected =
    actual.slice(0, actual.indexOf("void second()")) +
    actual.slice(actual.indexOf("void second()")).replace("int wrong", "int right");
  const { nodes } = corrections({}, { "source/main.cpp": expected }, { "source/main.cpp": actual });
  assert.equal(nodes.length, 1);
});

test("a large mostly agreeing diff needs only the remaining complete outer hunk", () => {
  const expected = Array.from({ length: 9000 }, (_, i) => `int required_${i} = ${i};\n`).join("");
  const actual = expected.replace("required_4500", "wrong_4500");
  const { nodes } = corrections({}, { "source/large.h": expected }, { "source/large.h": actual });
  assert.equal(nodes.length, 1);
  assert.ok(Buffer.byteLength(nodes[0].prompt) < 4096);
});
