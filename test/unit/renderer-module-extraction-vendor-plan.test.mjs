import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { vendorExtractionTasks } from "../../src/suites/explicit-edit-multi-agent/extraction/vendor-plan.mjs";

const vendor = "support/stb_image/stb_image_resize.h";
const activation = "support/stb.cpp";
const guard = "STBIR_INCLUDE_STB_IMAGE_RESIZE_H";
const macro = "STB_IMAGE_RESIZE_IMPLEMENTATION";
const hash = (text) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const firstDeclaration = `#ifndef ${guard}\n#define ${guard}\nint current_vendor();\n#endif\n`;
  const firstImplementation = `\n#ifdef ${macro}\nint original_vendor() { return FIRST_INACTIVE_ONLY; }\n#endif`;
  const secondDeclaration = `#ifndef ${guard}\n#define ${guard}\nint original_vendor(SECOND_INACTIVE_ONLY input);\n#endif\n`;
  const secondImplementation = `\n#ifdef ${macro}\nint current_vendor() { return 7; }\n#endif`;
  const define = `#define ${macro}\n`;
  const first = firstDeclaration + firstImplementation;
  const second = secondDeclaration + secondImplementation;
  const prefix = "int unrelated = 23;\n",
    gap = "\nint between = 29;\n";
  const source =
    prefix + first + gap + define + second + "\nint main() { return unrelated + between; }\n";
  const initial = { "main.cpp": source };
  const start1 = prefix.length,
    startDefine = start1 + first.length + gap.length,
    start2 = startDefine + define.length;
  /** @type {Array<[number, string, string, number, number]>} */
  const copies = [
    [start1, first, "yocto_image.cpp", 26, 0],
    [start2, second, activation, define.length, 1],
  ];
  const provenance = {
    initialIdentity: treeIdentity(initial),
    files: [
      {
        file: vendor,
        originalFile: vendor,
        text: firstDeclaration + `\n#ifdef ${macro}\nint current_vendor() { return 7; }\n#endif`,
      },
      {
        file: activation,
        originalFile: activation,
        text: define + '#include "stb_image/stb_image_resize.h"',
      },
    ],
    runs: [
      ...copies.map(([start, text, originalFile, originalStart, site]) => ({
        file: vendor,
        originalFile: vendor,
        role: "source",
        start,
        end: start + text.length,
        text,
        originalStart: 0,
        originalEnd: 100,
        embedding: [{ originalFile, originalStart, operation: 6, site }],
      })),
      {
        file: activation,
        originalFile: activation,
        role: "source",
        start: startDefine,
        end: start2,
        text: define,
        originalStart: 0,
        originalEnd: define.length,
        embedding: [{ originalFile: "main.cpp", originalStart: 0, operation: 5, site: 0 }],
      },
    ].sort((a, b) => a.start - b.start),
    removedIncludes: [
      {
        file: "frond_image.cpp",
        originalFile: "yocto_image.cpp",
        originalStart: 26,
        text: "#include <stb_image/stb_image_resize.h>\n",
        included: vendor,
      },
      {
        file: activation,
        originalFile: activation,
        originalStart: define.length,
        text: '#include "stb_image/stb_image_resize.h"\n',
        included: vendor,
      },
    ],
  };
  return {
    initial,
    provenance,
    firstDeclaration,
    firstImplementation,
    secondDeclaration,
    secondImplementation,
    define,
  };
}

test("one vendor assignment preserves all four current phases and keeps originally inactive copies suppressed", () => {
  const input = fixture(),
    before = structuredClone(input.initial);
  const tasks = vendorExtractionTasks({ ...input, startIndex: 8 });
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((task) => [task.id, task.file, task.kind]),
    [
      ["extract-009", vendor, "vendor-header"],
      ["extract-010", activation, "implementation"],
    ],
  );
  const [header, implementation] = tasks;
  const expected =
    input.firstDeclaration +
    "\n#if 0\n" +
    input.firstImplementation +
    "\n#endif\n\n#if 0\n" +
    input.secondDeclaration +
    "\n#endif\n" +
    input.secondImplementation +
    "\n";
  assert.equal(header.destination, expected);
  assert.equal(header.guard, guard);
  assert.equal(header.replacement, `#include "${vendor}"\n`);
  assert.deepEqual(
    header.fragments.map((fragment) => fragment.text),
    [
      input.firstDeclaration,
      input.firstImplementation,
      input.secondDeclaration,
      input.secondImplementation,
    ],
  );
  assert.equal(
    implementation.destination,
    input.define + '#include "stb_image/stb_image_resize.h"\n',
  );
  assert.equal(implementation.replacement, "");
  assert.deepEqual(implementation.includes, [vendor]);
  const pieces = tasks.flatMap((task) => task.fragments).sort((a, b) => a.start - b.start);
  for (const fragment of pieces) {
    assert.equal(fragment.text, input.initial["main.cpp"].slice(fragment.start, fragment.end));
    assert.equal(fragment.sha256, hash(fragment.text));
  }
  for (let index = 1; index < pieces.length; index++)
    assert.ok(pieces[index - 1].end <= pieces[index].start);
  assert.deepEqual(input.initial, before);
});

test("unsupported copy identity, activation or source substitution fails closed", () => {
  for (const mutate of [
    (input) => {
      input.provenance.runs = input.provenance.runs.filter(
        (run) => run.file !== vendor || run.embedding.at(-1).originalFile !== activation,
      );
    },
    (input) => {
      input.provenance.runs.find((run) => run.file === vendor).embedding.at(-1).originalFile =
        "yocto_shape.cpp";
    },
    (input) => {
      input.provenance.runs.find((run) => run.file === vendor).start++;
    },
    (input) => {
      input.initial["main.cpp"] += "int injected;\n";
    },
    (input) => {
      input.provenance.removedIncludes.find((entry) => entry.file === activation).text =
        '#include "unrelated.h"\n';
    },
    (input) => {
      input.provenance.runs.push({
        ...input.provenance.runs.find((run) => run.file === activation),
        text: "#define WRONG\n",
      });
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => vendorExtractionTasks(input));
  }
});
