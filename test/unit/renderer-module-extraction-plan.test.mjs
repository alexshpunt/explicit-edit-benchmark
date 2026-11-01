import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareHeaderExtraction,
  gradeHeaderExtraction,
} from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";

const inner = "#ifndef INNER_H\n#define INNER_H\ninline int bad_inner() { return 7; }\n#endif\n";
const outerPrefix = "#ifndef OUTER_H\n#define OUTER_H\n";
const outerSuffix = "inline int bad_outer() { return bad_inner(); }\n#endif\n";
const main = "int main() { return bad_outer(); }\n";
const initial = { "main.cpp": outerPrefix + inner + outerSuffix + main };
const headers = [
  { file: "outer.h", guard: "OUTER_H", includes: ["inner.h"] },
  { file: "inner.h", guard: "INNER_H", includes: [] },
];
const selected = ["outer.h", "inner.h"];

function plan() {
  return prepareHeaderExtraction({ initial, headers, modules: selected });
}

test("nested modules have disjoint complete fragments and retain their current names", () => {
  const before = structuredClone(initial);
  const prepared = plan();
  assert.deepEqual(initial, before);
  assert.equal(prepared.tasks.length, 2);
  assert.deepEqual(prepared.expected, {
    "main.cpp": '#include "outer.h"\n' + main,
    "outer.h": outerPrefix + '#include "inner.h"\n' + outerSuffix,
    "inner.h": inner,
  });
  assert.deepEqual(
    prepared.tasks.find(({ file }) => file === "outer.h").fragments.map(({ text }) => text),
    [outerPrefix, outerSuffix],
  );
  const fragments = prepared.tasks
    .flatMap(({ fragments }) => fragments)
    .sort((a, b) => a.start - b.start);
  for (let index = 0; index < fragments.length; index++) {
    const fragment = fragments[index];
    assert.equal(initial["main.cpp"].slice(fragment.start, fragment.end), fragment.text);
    if (index) assert.ok(fragments[index - 1].end <= fragment.start);
  }
  assert.equal(gradeHeaderExtraction(prepared, prepared.expected).status, "pass");
});

test("an extraction subset cannot leave a requested direct header dependency unavailable", () => {
  assert.throws(
    () => prepareHeaderExtraction({ initial, headers, modules: ["outer.h"] }),
    (error) => error.code === "EXTRACTION_DEPENDENCY_MISSING",
  );
});

test("a copied module, a renamed body and unrelated source changes fail final preservation checks", () => {
  const prepared = plan();
  const copied = { ...prepared.expected, "main.cpp": inner + prepared.expected["main.cpp"] };
  assert.equal(gradeHeaderExtraction(prepared, copied).status, "fail");
  assert.equal(gradeHeaderExtraction(prepared, copied).mainMatched, false);
  const renamed = { ...prepared.expected, "inner.h": inner.replaceAll("bad_inner", "nice_inner") };
  assert.equal(
    gradeHeaderExtraction(prepared, renamed).modules.find(({ file }) => file === "inner.h")
      .targetMatched,
    false,
  );
  const extra = { ...prepared.expected, "unexpected.cpp": "int injected;\n" };
  assert.equal(gradeHeaderExtraction(prepared, extra).inventoryMatched, false);
  const changed = {
    ...prepared.expected,
    "main.cpp": prepared.expected["main.cpp"].replace("return bad_outer()", "return 0"),
  };
  assert.equal(gradeHeaderExtraction(prepared, changed).mainMatched, false);
});

test("blank layout is not an extraction error, while raw-string and inactive source contents remain protected", () => {
  const tail = 'const char* raw = R"x(a\n\nb)x";\n#if 0\nint inactive_bad = 9;\n#endif\n';
  const prepared = prepareHeaderExtraction({
    initial: { "main.cpp": inner + tail },
    headers,
    modules: ["inner.h"],
  });
  const spaced = {
    ...prepared.expected,
    "main.cpp": "\n" + prepared.expected["main.cpp"] + "\n\n",
  };
  assert.equal(gradeHeaderExtraction(prepared, spaced).status, "pass");
  const literal = { ...spaced, "main.cpp": spaced["main.cpp"].replace("a\n\nb", "a\nb") };
  assert.equal(gradeHeaderExtraction(prepared, literal).status, "fail");
  const inactive = {
    ...spaced,
    "main.cpp": spaced["main.cpp"].replace("inactive_bad = 9", "inactive_bad = 0"),
  };
  assert.equal(gradeHeaderExtraction(prepared, inactive).status, "fail");
});
