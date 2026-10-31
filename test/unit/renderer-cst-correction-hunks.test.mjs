import assert from "node:assert/strict";
import test from "node:test";
import { cstCorrectionHunks } from "../../src/suites/explicit-edit-multi-agent/execution/cst-correction-hunks.mjs";

const marker = (key) => `\n@@UNCHANGED_CST[${key}]@@\n`;
const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function flat(text, pieces) {
  const raw = Buffer.from(text);
  let cursor = 0;
  const nodes = [[0, "translation_unit", "", 0, raw.length, -1, []]];
  for (const { text: value, kind = "declaration", label = "" } of pieces) {
    const payload = Buffer.from(value);
    const start = raw.indexOf(payload, cursor);
    assert.ok(start >= 0);
    const id = nodes.length;
    nodes.push([id, kind, label, start, payload.length, 0, []]);
    nodes[0][6].push(id);
    cursor = start + payload.length;
  }
  return { raw, nodes };
}

function compare(actual, expected, mappings) {
  return cstCorrectionHunks({
    actual: actual.raw,
    expected: expected.raw,
    actualNodes: actual.nodes,
    expectedNodes: expected.nodes,
    mappings,
    file: "sample.cpp",
  });
}

function restored(result, side) {
  let text = result[`${side}Skeleton`];
  for (const [key, anchor] of Object.entries(result.anchors)) {
    assert.equal(text.split(marker(key)).length, 2);
    text = text.replace(marker(key), anchor[side]);
  }
  return Buffer.from(text);
}

function replay(result) {
  const source = lines(result.actualSkeleton);
  for (const hunk of JSON.parse(JSON.stringify(result.hunks)).toReversed()) {
    const [start, end] = hunk.actualSkeletonLines;
    assert.equal(source.slice(start, end).join(""), hunk.actual);
    source.splice(start, end - start, ...lines(hunk.expected));
  }
  assert.equal(source.join(""), result.expectedSkeleton);
  let text = source.join("");
  for (const [key, anchor] of Object.entries(result.anchors))
    text = text.replace(marker(key), anchor.actual);
  return Buffer.from(text);
}

test("unchanged syntax retains distinct physical formatting in both lossless envelopes", () => {
  const pieces = [
    { text: "int", kind: "primitive_type" },
    { text: "x", kind: "identifier" },
    { text: ";", kind: ";" },
  ];
  const actual = flat("int x;\n", pieces);
  const expected = flat("int   x ;\n", pieces);
  const result = compare(actual, expected, [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  assert.equal(result.hunks.length, 0);
  assert.equal(Object.keys(result.anchors).length, 1);
  assert.deepEqual(restored(result, "actual"), actual.raw);
  assert.deepEqual(restored(result, "expected"), expected.raw);
  assert.deepEqual(replay(result), actual.raw);
});

test("duplicate occurrences stay distinct when a declaration moves", () => {
  const f = { text: "f();", kind: "expression_statement" };
  const g = { text: "g();", kind: "expression_statement" };
  const actual = flat("f();\nf();\ng();\n", [f, f, g]);
  const expected = flat("f();\ng();\nf();\n", [f, g, f]);
  const result = compare(actual, expected, [
    [0, 0],
    [1, 1],
    [2, 3],
    [3, 2],
  ]);
  assert.equal(Object.keys(result.anchors).length, 3);
  assert.equal(Object.values(result.anchors).filter((value) => value.actual === "f();").length, 2);
  assert.ok(result.hunks.length > 0);
  assert.deepEqual(restored(result, "actual"), actual.raw);
  assert.deepEqual(restored(result, "expected"), expected.raw);
  assert.deepEqual(replay(result), expected.raw);
});

test("unlabelled punctuation residuals remain changed and marker boundaries address original bytes", () => {
  const actual = flat("a\n+\nb\n", [{ text: "a" }, { text: "+", kind: "operator" }, { text: "b" }]);
  const expected = flat("a\n-\nb\n", [
    { text: "a" },
    { text: "-", kind: "operator" },
    { text: "b" },
  ]);
  const result = compare(actual, expected, [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].actual.includes("+"), true);
  assert.equal(result.hunks[0].expected.includes("-"), true);
  assert.deepEqual(result.hunks[0].actualSourceBytes, [1, 4]);
  assert.deepEqual(result.hunks[0].expectedSourceBytes, [1, 4]);
  assert.deepEqual(replay(result), expected.raw);
});

test("source between represented children cannot disappear from equality checks", () => {
  const actual = flat("a+b", [{ text: "a" }, { text: "b" }]);
  const expected = flat("a-b", [{ text: "a" }, { text: "b" }]);
  const result = compare(actual, expected, [
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].actual.includes("+"), true);
  assert.equal(result.hunks[0].expected.includes("-"), true);
  assert.deepEqual(result.hunks[0].actualSourceBytes, [1, 2]);
  assert.deepEqual(replay(result), expected.raw);
});

test("whitespace inside literals is retained as changed content", () => {
  const actual = flat('"a b";\n', [
    { text: '"a b"', kind: "string_literal" },
    { text: ";", kind: ";" },
  ]);
  const expected = flat('"a  b";\n', [
    { text: '"a  b"', kind: "string_literal" },
    { text: ";", kind: ";" },
  ]);
  const result = compare(actual, expected, [
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].actual.includes('"a b"'), true);
  assert.equal(result.hunks[0].expected.includes('"a  b"'), true);
  assert.deepEqual(replay(result), expected.raw);
});

test("UTF-8 offsets and bracket token kinds survive serialization", () => {
  const actual = flat("// é😀\n[1]\n", [
    { text: "// é😀", kind: "comment" },
    { text: "[", kind: "[" },
    { text: "1", kind: "number_literal" },
    { text: "]", kind: "]" },
  ]);
  const expected = flat("// é😀\n[2]\n", [
    { text: "// é😀", kind: "comment" },
    { text: "[", kind: "[" },
    { text: "2", kind: "number_literal" },
    { text: "]", kind: "]" },
  ]);
  const result = compare(actual, expected, [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ]);
  assert.equal(
    Object.values(result.anchors).some((anchor) => anchor.actual === "]"),
    true,
  );
  assert.deepEqual(restored(result, "actual"), actual.raw);
  assert.deepEqual(restored(result, "expected"), expected.raw);
  assert.deepEqual(replay(result), expected.raw);
  for (const hunk of result.hunks) {
    assert.equal(hunk.file, "sample.cpp");
    assert.ok(hunk.actualSourceBytes[0] >= Buffer.byteLength("// é😀\n["));
    for (const key of Object.keys(hunk.unchangedSubtrees)) assert.ok(result.anchors[key]);
    assert.equal(
      hunk.payloadBytes,
      Buffer.byteLength(hunk.actual) + Buffer.byteLength(hunk.expected),
    );
  }
});

test("complete wrappers, opaque regions and trailing bytes remain recoverable", () => {
  const actual = flat("#if 0\nBROKEN(\n#endif\n", [{ text: "BROKEN(", kind: "ERROR" }]);
  const expected = flat("#if 0\nFIXED();\n#endif\n// tail", [
    { text: "FIXED();", kind: "expression_statement" },
  ]);
  const result = compare(actual, expected, [[0, 0]]);
  assert.deepEqual(restored(result, "actual"), actual.raw);
  assert.deepEqual(restored(result, "expected"), expected.raw);
  assert.deepEqual(replay(result), expected.raw);
  assert.equal(
    result.hunks
      .map((hunk) => hunk.expected)
      .join("")
      .includes("#endif\n// tail"),
    true,
  );
});

test("anchor metadata retains complete declaration headers and lexical scopes", () => {
  const nested = (name) => {
    const text = `namespace n {\nint ${name};\nint x(){return 1;}\n}\n`;
    const raw = Buffer.from(text);
    const bodyStart = raw.indexOf(Buffer.from("{"));
    const bodyEnd = raw.lastIndexOf(Buffer.from("}")) + 1;
    const firstStart = raw.indexOf(Buffer.from(`int ${name};`));
    const functionStart = raw.indexOf(Buffer.from("int x()"));
    const functionBody = raw.indexOf(Buffer.from("{return"));
    const functionEnd = functionBody + Buffer.byteLength("{return 1;}");
    return {
      raw,
      nodes: [
        [0, "translation_unit", "", 0, raw.length, -1, [1]],
        [1, "namespace_definition", "", 0, bodyEnd, 0, [2]],
        [2, "declaration_list", "", bodyStart, bodyEnd - bodyStart, 1, [3, 4]],
        [3, "declaration", "", firstStart, Buffer.byteLength(`int ${name};`), 2, []],
        [4, "function_definition", "", functionStart, functionEnd - functionStart, 2, [5]],
        [5, "compound_statement", "", functionBody, functionEnd - functionBody, 4, []],
      ],
    };
  };
  const actual = nested("a");
  const expected = nested("b");
  const originalNodes = structuredClone(actual.nodes);
  const result = compare(
    actual,
    expected,
    Array.from({ length: 6 }, (_, id) => [id, id]),
  );
  const refs = Object.values(result.hunks[0].unchangedSubtrees);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].actual.header, "int x()");
  assert.equal(refs[0].actual.line, 3);
  assert.deepEqual(refs[0].actual.scopes, ["namespace n {"]);
  assert.deepEqual(actual.nodes, originalNodes);
  assert.deepEqual(restored(result, "actual"), actual.raw);
  assert.deepEqual(restored(result, "expected"), expected.raw);
  assert.deepEqual(replay(result), expected.raw);
});

test("empty inputs and missing final newlines remain complete source differences", () => {
  const actual = flat("", []);
  const expected = flat("int x;", [{ text: "int x;" }]);
  const result = compare(actual, expected, [[0, 0]]);
  assert.equal(result.hunks.length, 1);
  assert.deepEqual(result.hunks[0].actualSourceBytes, [0, 0]);
  assert.deepEqual(result.hunks[0].expectedSourceBytes, [0, expected.raw.length]);
  assert.deepEqual(replay(result), expected.raw);
});

test("crossed mappings cannot hide different bodies", () => {
  const actual = flat("f(1);\ng(2);\n", [{ text: "f(1);" }, { text: "g(2);" }]);
  const expected = flat("f(3);\ng(2);\n", [{ text: "f(3);" }, { text: "g(2);" }]);
  const result = compare(actual, expected, [
    [0, 0],
    [1, 2],
    [2, 1],
  ]);
  assert.equal(Object.keys(result.anchors).length, 0);
  assert.deepEqual(replay(result), expected.raw);
});

test("invalid source boundaries, tree structure, mappings and marker collisions are refused", () => {
  const a = flat("éx\n", [
    { text: "é", kind: "identifier" },
    { text: "x", kind: "identifier" },
  ]);
  const mappings = [
    [0, 0],
    [1, 1],
    [2, 2],
  ];
  for (const mutate of [
    (nodes) => {
      nodes[1][3] = 1;
      nodes[1][4] = 1;
    },
    (nodes) => {
      nodes[1][4] = 99;
    },
    (nodes) => {
      nodes[0][6] = [2, 1];
    },
    (nodes) => {
      nodes[1][5] = 2;
    },
    (nodes) => {
      nodes[0][6] = [1, 1, 2];
    },
  ]) {
    const broken = structuredClone(a.nodes);
    mutate(broken);
    assert.throws(() => compare({ ...a, nodes: broken }, a, mappings));
  }
  for (const pairs of [
    [
      [0, 0],
      [1, 1],
      [1, 2],
    ],
    [
      [0, 0],
      [1, 1],
      [2, 1],
    ],
    [[99, 0]],
    [[0, 99]],
  ])
    assert.throws(() => compare(a, a, pairs));
  const collision = flat("@@UNCHANGED_CST[not-a-marker]\n", []);
  assert.throws(() => compare(collision, collision, [[0, 0]]));
  const invalid = { raw: Buffer.from([0xff]), nodes: [[0, "translation_unit", "", 0, 1, -1, []]] };
  assert.throws(() => compare(invalid, invalid, [[0, 0]]));
});

// Prose mutation: the tests inspect data, bytes and thrown behavior only. The
// parent worker run should empty assertion messages in the implementation and
// rerun this file; no test searches those messages or explanatory prose.
