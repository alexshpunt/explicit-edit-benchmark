import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  pack,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  mixFunctions,
  undoFunctionMix,
} from "../../src/suites/explicit-edit-multi-agent/generation/function-mix.mjs";
import { includeBoundaries } from "../../src/suites/explicit-edit-multi-agent/cpp/compiler-includes.mjs";

const source = `#include <cstdio>
namespace demo {
struct Value { int n; };
int fixed = 3;
[[maybe_unused]] int fixed_overload(int n) { return n; }
int helper(Value v) { return v.n + fixed; }
int caller(Value v) { return helper(v); }
int third(Value v) { union { int n; float f; } bits{v.n * 2}; const char* label = "λ renderer"; (void)label; return bits.n; }
[[maybe_unused]] int fixed_overload(Value v) { return v.n; }
}
namespace demo {
int fourth(Value v) { return caller(v) + third(v); }
int overload_caller(Value v) { return fixed_overload(v); }
int fifth(Value v) { return fourth(v) + helper(v); }
int sixth(Value v) { return fifth(v) - third(v); }
int pick(int n) { return n + 10; }
int before_double() { double n = 1.5; return pick(n); }
int pick(double n) { return (int)n + 20; }
template <class T> T dependent(T value) { return value; }
auto inferred() { return 1; }
int defaulted(int value = 4) { return value; }
#define SCALE(n) ((n) * 2)
int macro_body(int n) { return SCALE(n); }
int directive_body(int n) {
#if 1
return n;
#endif
}
struct Later { int n; };
int late_one(Later v) { return v.n; }
int late_two(Later v) { return late_one(v) + 1; }
int late_three(Later v) { return late_two(v) + 1; }
[[maybe_unused]] int attributed(Later v) { return v.n; }
}
int main() { std::printf("%d %d\\n", demo::sixth({2}), demo::before_double()); }
`;

await test("whole functions mix across reopened namespaces without changing lookup or fixed barriers", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-contract-"));
  try {
    const original = { "main.cpp": source };
    const result = await mixFunctions(original, path.join(temporary, "first"));
    assert.equal(result.stages.length, 2);
    assert.ok(result.summary.moved >= 4);
    assert.ok(result.summary.crossRegionMoves > 0);
    assert.ok(result.summary.related.some((pair) => pair.after > pair.before));
    assert.ok(result.summary.excluded.some((entry) => entry.reason.includes("overload")));
    assert.ok(result.summary.excluded.some((entry) => entry.reason.includes("template")));
    assert.ok(result.summary.excluded.some((entry) => entry.reason.includes("auto")));
    assert.ok(result.summary.excluded.some((entry) => entry.reason.includes("default")));
    assert.ok(result.summary.excluded.some((entry) => entry.reason.includes("macro")));
    assert.ok(result.summary.excluded.some((entry) => entry.reason.includes("directive")));
    assert.ok(
      result.summary.excluded.some(
        (entry) => entry.name === "attributed" && entry.reason.includes("attribute"),
      ),
    );
    assert.equal(result.stages[0].record.kind, "function-declarations");
    assert.equal(result.stages[1].record.kind, "function-permutation");
    const originalBytes = Buffer.from(source);
    const mixedBytes = Buffer.from(result.stages.at(-1).tree["main.cpp"]);
    for (const { body } of result.summary.placements)
      assert.deepEqual(
        mixedBytes.subarray(body.start, body.start + body.length),
        originalBytes.subarray(body.fromStart, body.fromStart + body.length),
      );
    const states = [original, ...result.stages.map((stage) => stage.tree)];
    let inverse = result.stages.at(-1).tree;
    for (const stage of [...result.stages].reverse()) {
      inverse = undoFunctionMix(inverse, JSON.parse(JSON.stringify(stage.record)));
      states.push(inverse);
    }
    for (const placement of result.summary.placements) {
      const { byte, length, hash } = placement.declaration;
      const prototype = mixedBytes.subarray(byte, byte + length);
      assert.equal(createHash("sha256").update(prototype).digest("hex"), hash);
      assert.equal(
        mixedBytes.subarray(0, byte).toString("utf8").split("\n").length,
        placement.declarationLine,
      );
      assert.ok(prototype.toString("utf8").includes(placement.name + "("));
    }
    let index = 0;
    for (const tree of states) {
      const directory = path.join(temporary, `state-${index++}`);
      await writeTree(directory, tree);
      const executable = path.join(directory, "program");
      execFileSync("clang++", ["-std=c++17", path.join(directory, "main.cpp"), "-o", executable]);
      assert.equal(execFileSync(executable, [], { encoding: "utf8" }).trim(), "10 11");
      assert.match(tree["main.cpp"], /int fixed = 3;/);
      assert.match(tree["main.cpp"], /struct Later \{ int n; \};/);
      assert.match(
        tree["main.cpp"],
        /\[\[maybe_unused\]\] int attributed\(Later v\) \{ return v.n; \}/,
      );
      assert.match(tree["main.cpp"], /int caller\(Value v\) \{ return helper\(v\); \}/);
    }
    const repeat = await mixFunctions(original, path.join(temporary, "repeat"));
    assert.deepEqual(repeat, result);
    assert.equal(JSON.stringify(result.summary).includes(temporary), false);
    assert.equal(
      JSON.stringify(result.stages.map((stage) => stage.record)).includes("return helper(v)"),
      false,
    );
    let current = result.stages.at(-1).tree;
    assert.throws(
      () => undoFunctionMix({ "main.cpp": current["main.cpp"] + " " }, result.stages.at(-1).record),
      /identity/,
    );
    const damaged = structuredClone(result.stages.at(-1).record);
    damaged.slots[0].hash = "changed";
    assert.throws(() => undoFunctionMix(current, damaged), /span/);
    for (const stage of [...result.stages].reverse())
      current = undoFunctionMix(current, JSON.parse(JSON.stringify(stage.record)));
    assert.deepEqual(current, original);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("new declarations are rejected when they would change an imported overload binding", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-lookup-"));
  try {
    const original = {
      "main.cpp": `namespace other { int take(double n) { return (int)n + 1; } }
namespace demo {
using other::take;
int first() { return take(2); }
int take(int n) { return n + 10; }
int last() { return first(); }
}
int main() { return demo::last(); }
`,
    };
    await assert.rejects(
      mixFunctions(original, path.join(temporary, "changed")),
      /Forward declarations changed compiler bindings/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("line-sensitive macros are rejected instead of silently changing their values", async () => {
  await assert.rejects(
    mixFunctions({ "main.cpp": "int value = __LINE__;\n" }, ".tmp/unused-line-mix"),
    /Line-sensitive macros/,
  );
});

await test("source provenance survives renaming a return type after many earlier length-changing edits", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-origins-"));
  try {
    let tree = {
      "main.cpp": "int main() { return 0; }\n",
      "a.cpp":
        "namespace demo { struct A { int n; }; A one(A value) { return value; } A two(A value) { return one(value); } }\n",
      "b.cpp":
        "namespace demo { struct B { int n; }; B three(B value) { return value; } B four(B value) { return three(value); } }\n",
    };
    const history = [];
    for (const name of ["a.cpp", "b.cpp"]) {
      const result = pack(tree, { kind: "append", source: name, target: "main.cpp" });
      tree = result.tree;
      history.push(result.record);
    }
    const edits = [];
    let shift = 0;
    const source = tree["main.cpp"].replace(/\b[AB]\b/g, (old, start) => {
      const replacement = old + "ValueWithAnIntentionallyLongNameForThisRegression";
      edits.push({ start, afterStart: start + shift, old, new: replacement });
      shift += replacement.length - old.length;
      return replacement;
    });
    history.push({ kind: "rename", edits });
    const result = await mixFunctions({ "main.cpp": source }, path.join(temporary, "mixed"), {
      history,
    });
    for (const placement of result.summary.placements) {
      const expected = ["one", "two"].includes(placement.name) ? "a.cpp" : "b.cpp";
      assert.equal(placement.from.source, expected);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("already active standard includes do not prevent legal moves between original implementation files", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-cross-source-"));
  try {
    let tree = {
      "main.cpp": "#include <algorithm>\nint main() { return 0; }\n",
      "a.cpp":
        "#include <algorithm>\nnamespace demo { int a1() { return 1; } int a2() { return 2; } int a3() { return 3; } int a4() { return 4; } }\n",
      "b.cpp":
        "#include <algorithm>\n#ifdef OPTIONAL_FEATURE\n#include <missing-optional-header.hpp>\n#endif\nnamespace demo { int b1() { return 5; } int b2() { return 6; } int b3() { return 7; } int b4() { return 8; } }\n",
    };
    const history = [];
    for (const name of ["a.cpp", "b.cpp"]) {
      const result = pack(tree, { kind: "append", source: name, target: "main.cpp" });
      tree = result.tree;
      history.push(result.record);
    }
    const result = await mixFunctions(tree, path.join(temporary, "mixed"), { history });
    assert.ok(result.summary.crossRegionMoves > 0);
    for (const placement of result.summary.placements)
      assert.equal(placement.from.source, placement.name.startsWith("a") ? "a.cpp" : "b.cpp");
    assert.equal(result.stages.at(-1).tree["main.cpp"].match(/#include <algorithm>/g).length, 3);
    let current = result.stages.at(-1).tree;
    for (const stage of [...result.stages].reverse())
      current = undoFunctionMix(current, stage.record);
    assert.deepEqual(current, tree);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("an inactive earlier include is not evidence that a later standard include is redundant", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-includes-"));
  try {
    const source =
      "#if 0\n#include <algorithm>\n#endif\n#include <algorithm>\n#include <algorithm>\nint main() { return 0; }\n";
    await writeTree(path.join(temporary, "source"), { "main.cpp": source });
    const { repeated, inactive } = await includeBoundaries(
      path.join(temporary, "source/main.cpp"),
      ["-std=c++17"],
    );
    assert.equal(inactive.size, 3);
    assert.deepEqual(
      [...repeated],
      [Buffer.byteLength(source.slice(0, source.lastIndexOf("#include")))],
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("adjacent definitions keep generated prototypes outside moved function spans", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-adjacent-"));
  try {
    const definitions = [
      "Value first(Value v) { return v; }",
      "int second() { return 2; }",
      "int third() { return 3; }",
      "Value last(Value v) { return v; }",
    ];
    const source =
      "namespace demo { struct Value { int n; }; " +
      definitions.join("") +
      " } int main() { return 0; }\n";
    const result = await mixFunctions({ "main.cpp": source }, path.join(temporary, "mixed"));
    const bytes = Buffer.from(result.stages.at(-1).tree["main.cpp"]);
    for (const slot of result.stages.at(-1).record.slots)
      assert.ok(definitions.includes(bytes.subarray(slot.start, slot.end).toString("utf8")));
    let current = result.stages.at(-1).tree;
    for (const stage of [...result.stages].reverse())
      current = undoFunctionMix(current, stage.record);
    assert.equal(current["main.cpp"], source);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
