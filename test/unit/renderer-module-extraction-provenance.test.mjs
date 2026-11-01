import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  compactBlankLines,
  cppTokens,
  pack,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { maskOrigin } from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import { traceGenerationOrigins } from "../../src/suites/explicit-edit-multi-agent/extraction/provenance.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const original = {
    "main.cpp": '#include "yocto_a.h"\n#include "yocto_b.h"\nint main() { return 0; }\n',
    "yocto_a.h": "#ifndef YOCTO_A_H\n#define YOCTO_A_H\nnamespace yocto { int bad_a(); }\n#endif\n",
    "yocto_b.h": "#ifndef YOCTO_B_H\n#define YOCTO_B_H\nnamespace yocto { int bad_b(); }\n#endif\n",
    "yocto_a.cpp": 'namespace yocto {\nint bad_a() { return 1; }\n}\n#include "yocto_a.h"',
    "yocto_b.cpp": '#include "yocto_b.h"\nnamespace yocto {\nint bad_b() { return 2; }\n}\n',
  };
  let tree = original;
  const operations = [];
  for (const [kind, source] of [
    ["append", "yocto_a.cpp"],
    ["append", "yocto_b.cpp"],
    ["include", "yocto_a.h"],
    ["include", "yocto_b.h"],
  ]) {
    const result = pack(tree, { kind, source, target: "main.cpp" });
    operations.push(result.record);
    tree = result.tree;
  }
  const previous = tree["main.cpp"];
  const names = { bad_a: "current_name_a", bad_b: "current_name_b" };
  const edits = cppTokens(previous)
    .filter((token) => Object.hasOwn(names, token.text))
    .map((token) => ({ start: token.start, old: token.text, new: names[token.text] }));
  let current = "",
    cursor = 0;
  for (const edit of edits) {
    current += previous.slice(cursor, edit.start);
    edit.afterStart = current.length;
    current += edit.new;
    cursor = edit.start + edit.old.length;
  }
  current += previous.slice(cursor);
  operations.push({
    kind: "rename",
    before: treeIdentity(tree),
    after: treeIdentity({ "main.cpp": current }),
    edits,
  });
  tree = { "main.cpp": current };
  const functions = ["int current_name_a() { return 1; }", "int current_name_b() { return 2; }"];
  const positions = functions.map((text) => current.indexOf(text));
  const prototypes = ["int current_name_a();\n", "int current_name_b();\n"];
  const declaration = prototypes.join("") + "\n";
  const declared = current.slice(0, positions[0]) + declaration + current.slice(positions[0]);
  operations.push({
    kind: "function-declarations",
    before: treeIdentity(tree),
    after: treeIdentity({ "main.cpp": declared }),
    edits: [{ start: Buffer.byteLength(current.slice(0, positions[0])), text: declaration }],
  });
  const declaredPositions = positions.map((position) => position + declaration.length);
  const mixed =
    declared.slice(0, declaredPositions[0]) +
    functions[1] +
    declared.slice(declaredPositions[0] + functions[0].length, declaredPositions[1]) +
    functions[0] +
    declared.slice(declaredPositions[1] + functions[1].length);
  const slots = declaredPositions.map((start, index) => ({
    start: Buffer.byteLength(declared.slice(0, start)),
    end: Buffer.byteLength(declared.slice(0, start)) + Buffer.byteLength(functions[1 - index]),
    original: index,
    occupant: 1 - index,
    hash: hash(functions[1 - index]),
  }));
  operations.push({
    kind: "function-permutation",
    before: treeIdentity({ "main.cpp": declared }),
    after: treeIdentity({ "main.cpp": mixed }),
    slots,
  });
  const placements = functions.map((_text, index) => ({
    from: {
      byte: Buffer.byteLength(current.slice(0, positions[index])),
      source: `yocto_${index ? "b" : "a"}.cpp`,
    },
    to: { byte: slots[1 - index].start },
    declaration: {
      byte:
        Buffer.byteLength(current.slice(0, positions[0])) +
        (index ? Buffer.byteLength(prototypes[0]) : 0),
      length: Buffer.byteLength(prototypes[index]),
      hash: hash(prototypes[index]),
    },
  }));
  for (const placement of placements)
    assert.equal(
      hash(
        Buffer.from(mixed).subarray(
          placement.declaration.byte,
          placement.declaration.byte + placement.declaration.length,
        ),
      ),
      placement.declaration.hash,
    );
  const masked = maskOrigin({ "main.cpp": mixed }, { name: "frond" });
  operations.push(masked.record);
  const compacted = compactBlankLines(masked.tree);
  operations.push(compacted.record);
  return {
    initial: compacted.tree,
    manifest: { initial: treeIdentity(original), final: treeIdentity(compacted.tree), operations },
    mixing: { placements },
    functions,
  };
}

test("current shuffled definitions and generated declarations keep their own original implementation owner", () => {
  const input = fixture();
  const result = traceGenerationOrigins(input);
  assert.equal(result.initialIdentity, treeIdentity(input.initial));
  const runs = result.runs;
  assert.equal(runs.map((run) => run.text).join(""), input.initial["main.cpp"]);
  let cursor = 0;
  for (const run of runs) {
    assert.equal(run.start, cursor);
    assert.equal(run.end, run.start + run.text.length);
    assert.equal(run.text, input.initial["main.cpp"].slice(run.start, run.end));
    cursor = run.end;
  }
  for (const [index, text] of input.functions.entries()) {
    const offset = input.initial["main.cpp"].indexOf(text);
    const owners = new Set(
      runs
        .filter((run) => run.start < offset + text.length && offset < run.end)
        .map((run) => run.file),
    );
    assert.deepEqual([...owners], [`frond_${index ? "b" : "a"}.cpp`]);
    const declarations = runs
      .filter(
        (run) =>
          run.role === "generated-declaration" && run.file === `frond_${index ? "b" : "a"}.cpp`,
      )
      .map((run) => run.text)
      .join("");
    assert.equal(declarations, text.slice(0, text.indexOf("{")).trimEnd() + ";\n");
  }
  assert.ok(
    input.initial["main.cpp"].indexOf(input.functions[1]) <
      input.initial["main.cpp"].indexOf(input.functions[0]),
  );
});

test("modified endpoints, inconsistent record chains and substituted declaration ownership fail closed", () => {
  const input = fixture();
  assert.throws(() =>
    traceGenerationOrigins({
      ...input,
      initial: { "main.cpp": input.initial["main.cpp"] + "int extra;\n" },
    }),
  );
  const damaged = structuredClone(input);
  damaged.manifest.operations[1].before = "0".repeat(64);
  assert.throws(() => traceGenerationOrigins(damaged));
  const swapped = structuredClone(input);
  swapped.mixing.placements[0].from.source = "yocto_b.cpp";
  assert.throws(() => traceGenerationOrigins(swapped));
});

test("repeated includes retain their distinct containing-source provenance", () => {
  const original = {
    "main.cpp":
      '#include "vendor.h"\n#define IMPLEMENTATION\n#include "vendor.h"\nnamespace yocto {}\n',
    "vendor.h":
      "#ifndef VENDOR_H\n#define VENDOR_H\nint vendor();\n#endif\n#ifdef IMPLEMENTATION\nint vendor() { return 1; }\n#endif\n",
  };
  const packed = pack(original, {
    kind: "include",
    source: "vendor.h",
    target: "main.cpp",
    repeat: true,
  });
  const masked = maskOrigin(packed.tree, { name: "frond" });
  const compact = compactBlankLines(masked.tree);
  const provenance = traceGenerationOrigins({
    initial: compact.tree,
    manifest: {
      initial: treeIdentity(original),
      final: treeIdentity(compact.tree),
      operations: [packed.record, masked.record, compact.record],
    },
  });
  const copies = provenance.runs.filter((run) => run.originalFile === "vendor.h");
  assert.equal(copies.length, 2);
  assert.deepEqual(
    copies.map((run) => run.embedding.at(-1).originalStart),
    [0, original["main.cpp"].lastIndexOf('#include "vendor.h"')],
  );
  assert.ok(copies.every((run) => run.embedding.at(-1).originalFile === "main.cpp"));
  assert.equal(
    provenance
      .project("vendor.h", 0, original["vendor.h"].length)
      .map((piece) => piece.text)
      .join(""),
    copies.map((copy) => copy.text).join(""),
  );
});
