import assert from "node:assert/strict";
import test from "node:test";
import {
  stripProjectGuards,
  restoreProjectGuards,
} from "../../src/suites/explicit-edit-multi-agent/generation/project-header-guards.mjs";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const headers = [
  { file: "frond_a.h", guard: "A_H", includes: ["frond_b.h"] },
  { file: "frond_b.h", guard: "B_H", includes: [] },
];
const body = [
  "// Ω and 😀 remain byte-identical.",
  'const char* literal = R"tag(',
  "#ifndef A_H",
  "#define A_H",
  "#endif",
  ')tag";',
  "/* #ifndef B_H */",
  "#if INNER_FEATURE",
  "int inner_enabled;",
  "#else",
  "int inner_disabled;",
  "#endif",
];
const vendor = ["#ifndef VENDOR_H", "#define VENDOR_H", "int vendor_payload;", "#endif"];
const source = [
  "// 😀 before all recorded positions.",
  "#ifndef A_H",
  "#define A_H",
  "#include <vector>",
  "#ifndef B_H",
  "#define B_H",
  ...body,
  "#endif",
  ...vendor,
  "#endif",
  "int main() { return 0; }",
  "",
].join("\r\n");
test("guard stripping rejects guard dependencies in retained support files", () => {
  assert.throws(() =>
    stripProjectGuards(
      {
        "main.cpp": source,
        "support/feature.h": "#ifdef A_H\nint activated_by_header;\n#endif\n",
      },
      headers,
    ),
  );
});
test("guard stripping rejects guard dependencies across continued identifier tokens", () => {
  assert.throws(() =>
    stripProjectGuards(
      {
        "main.cpp": source + "#if defined(A_\\\nH)\nint depends;\n#endif\n",
      },
      headers,
    ),
  );
});
const expected = [
  "// 😀 before all recorded positions.",
  "#include <vector>",
  ...body,
  ...vendor,
  "int main() { return 0; }",
  "",
].join("\r\n");
const tree = () => ({ "main.cpp": source, "support/vendor.h": vendor.join("\n") });
const one = (payload) => ({ "main.cpp": payload });
const header = [{ file: "frond_a.h", guard: "A_H" }];
const ordinary = "#ifndef A_H\n#define A_H\nint body;\n#endif\n";

test("guard stripping refuses identifiers assembled through token pasting", () => {
  const dependency =
    "#define JOIN_RAW(a,b) a##b\n#define JOIN(a,b) JOIN_RAW(a,b)\n#define STRING_RAW(x) #x\n#define STRING(x) STRING_RAW(x)\nconst char* state = STRING(JOIN(A_,H));\n";
  assert.throws(() => stripProjectGuards(one(ordinary + dependency), header));
});

test("project guard stripping preserves nested payload, vendor code and Unicode layout", () => {
  const input = tree();
  const before = structuredClone(input);
  const result = stripProjectGuards(input, headers);
  assert.deepEqual(input, before);
  assert.deepEqual(result.tree, { ...input, "main.cpp": expected });
  assert.equal(result.record.kind, "project-header-guards");
  assert.deepEqual(
    result.record.headers,
    headers.map(({ file, guard }) => ({ file, guard })),
  );
  assert.equal(result.record.before, treeIdentity(input));
  assert.equal(result.record.after, treeIdentity(result.tree));
  assert.equal(result.record.edits.length, 6);
  let removed = 0;
  for (const edit of result.record.edits) {
    assert.equal(source.slice(edit.start, edit.start + edit.removed.length), edit.removed);
    assert.equal(edit.afterStart, edit.start - removed);
    removed += edit.removed.length;
    assert.ok(/^\s*#\s*(?:ifndef|define|endif)\b[^\n]*(?:\n|$)$/.test(edit.removed));
  }
  const serialized = JSON.parse(JSON.stringify(result.record));
  assert.deepEqual(restoreProjectGuards(result.tree, serialized), input);
  assert.deepEqual(stripProjectGuards(input, headers), result);
});

test("project guard stripping leaves fake directives in continued macros alone", () => {
  const payload = "#define CONTINUED \\\n#ifndef FAKE_GUARD\n";
  const input = one(payload + ordinary);
  const result = stripProjectGuards(input, header);
  assert.equal(result.tree["main.cpp"], payload + "int body;\n");
  assert.deepEqual(restoreProjectGuards(result.tree, result.record), input);
});

for (const [name, payload] of [
  [
    "guard macro use inside the envelope",
    ordinary.replace("int body;", "#if defined(A_H)\nint body;\n#endif"),
  ],
  ["guard macro use outside the envelope", ordinary + "#undef A_H\n"],
  [
    "an outer alternative branch",
    ordinary.replace("int body;", "int body;\n#else\nint alternate;"),
  ],
  ["an outer elif branch", ordinary.replace("int body;", "int body;\n#elif OTHER\nint alternate;")],
  ["an embedded pragma once", ordinary.replace("int body;", "#pragma once\nint body;")],
  [
    "a pragma once with a comment",
    ordinary.replace("int body;", "#pragma /* explanation */ once\nint body;"),
  ],
  ["a continued pragma once", ordinary.replace("int body;", "#pragma \\\nonce\nint body;")],
  ["a continued pragma keyword", ordinary.replace("int body;", "#pra\\\ngma once\nint body;")],
  ["a missing define", ordinary.replace("#define A_H\n", "")],
  ["a valued guard define", ordinary.replace("#define A_H", "#define A_H 1")],
  ["a missing closing directive", ordinary.replace("#endif\n", "")],
  ["a duplicate guard envelope", ordinary + ordinary],
  ["an unmatched closing conditional", ordinary + "#endif\n"],
  ["an unclosed surrounding conditional", "#if OUTER\n" + ordinary],
  [
    "two else branches in an inner conditional",
    ordinary.replace("int body;", "#if INNER\n#else\n#else\n#endif"),
  ],
]) {
  test(`project guard stripping rejects ${name}`, () => {
    assert.throws(() => stripProjectGuards(one(payload), header));
  });
}

test("project guard metadata only accepts unique own root headers and guards", () => {
  for (const invalid of [
    [],
    [{ file: "support/vendor.h", guard: "A_H" }],
    [{ file: "frond_a.cpp", guard: "A_H" }],
    [{ file: "../frond_a.h", guard: "A_H" }],
    [{ file: "frond_a.h", guard: "A_H|OTHER" }],
    [...header, ...header],
    [
      { file: "frond_a.h", guard: "A_H" },
      { file: "frond_b.h", guard: "A_H" },
    ],
  ])
    assert.throws(() => stripProjectGuards(one(ordinary), invalid));
});

test("guard inverse rejects non-scaffold edits even after their tree hashes are resealed", () => {
  const result = stripProjectGuards(one(ordinary), header);
  const forged = structuredClone(result.record);
  forged.edits[1].removed += "int injected;\n";
  let restored = result.tree["main.cpp"];
  for (const edit of [...forged.edits].reverse())
    restored = restored.slice(0, edit.afterStart) + edit.removed + restored.slice(edit.afterStart);
  forged.before = treeIdentity(one(restored));
  assert.throws(() => restoreProjectGuards(result.tree, forged));
});

test("guard inverse rejects changed input, metadata, coordinates and non-scaffold edits", () => {
  const input = one(ordinary);
  const result = stripProjectGuards(input, header);
  assert.throws(() => restoreProjectGuards({ "main.cpp": "int changed;\n" }, result.record));
  for (const change of [
    (record) => {
      record.kind = "compact";
    },
    (record) => {
      record.headers[0].file = "support/vendor.h";
    },
    (record) => {
      record.before = "0".repeat(64);
    },
    (record) => {
      record.edits[0].afterStart++;
    },
    (record) => {
      record.edits[0].removed += "int injected;\n";
    },
    (record) => {
      record.edits.push({ start: 0, afterStart: 0, removed: "int injected;\n" });
    },
  ]) {
    const changed = structuredClone(result.record);
    change(changed);
    assert.throws(() => restoreProjectGuards(result.tree, changed));
  }
});
