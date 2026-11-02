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

await test("optimized mixing improves dispersion without changing bodies or legal bindings", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-dispersion-"));
  try {
    const original = { "main.cpp": source };
    const baseline = await mixFunctions(original, path.join(temporary, "baseline"), {
      strategy: "baseline",
    });
    const defaultResult = await mixFunctions(original, path.join(temporary, "default"));
    assert.deepEqual(defaultResult.stages, baseline.stages);
    const optimized = await mixFunctions(original, path.join(temporary, "optimized"), {
      strategy: "dispersion",
    });
    assert.ok(optimized.summary.optimization);
    assert.ok(optimized.summary.optimization.sources.length > 0);
    for (const row of optimized.summary.optimization.sources) {
      const positions = optimized.summary.placements.filter(
        (item) => item.from.source === row.file,
      );
      const exact = optimized.summary.optimization.after.sources.find(
        (item) => item.owner === row.file,
      );
      const bytes = positions.map((item) => item.to.byte).sort((a, b) => a - b);
      let pairDistance = 0;
      for (let i = 0; i < bytes.length; i++)
        for (let j = i + 1; j < bytes.length; j++) pairDistance += bytes[j] - bytes[i];
      assert.equal(exact.distance, pairDistance);
      assert.equal(row.count, positions.length);
      assert.equal(
        row.after.meanDisplacement,
        positions.reduce((sum, item) => sum + Math.abs(item.to.line - item.from.line), 0) /
          positions.length,
      );
    }
    const bounded = await mixFunctions(original, path.join(temporary, "bounded"), {
      strategy: "dispersion",
      search: { restarts: 0, passes: 0 },
    });
    assert.equal(bounded.summary.optimization.search.passes, 0);
    assert.equal(bounded.summary.optimization.search.restarts, 0);
    assert.ok(
      optimized.summary.optimization.after.dispersion >=
        optimized.summary.optimization.before.dispersion,
    );
    assert.deepEqual(optimized.summary.optimization.before, baseline.summary.optimization.after);
    assert.equal(optimized.summary.bindings.fingerprint, baseline.summary.bindings.fingerprint);
    assert.deepEqual(
      optimized.summary.placements.map((row) => row.bodyHash).sort(),
      baseline.summary.placements.map((row) => row.bodyHash).sort(),
    );
    const repeat = await mixFunctions(original, path.join(temporary, "repeat"), {
      strategy: "dispersion",
    });
    assert.deepEqual(repeat, optimized);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
await test("ordinary inline definitions can be mixed without moving constexpr definitions", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-inline-"));
  try {
    const original = {
      "main.cpp": `#include <cstdio>
namespace demo {
constexpr int constant() { return 2; }
static_assert(constant() == 2);
inline int first(int value) { return value + 1; }
inline int second(int value) { return first(value) * 2; }
inline int third(int value) { return second(value) + 1; }
int fourth(int value) { return third(value) + constant(); }
int fifth(int value) { return fourth(value) - 2; }
}
int main() { std::printf("%d\\n", demo::fifth(3)); }
`,
    };
    const ordinary = await mixFunctions(original, path.join(temporary, "default"));
    assert.ok(
      ordinary.summary.placements.every(
        ({ name }) => !["first", "second", "third", "constant"].includes(name),
      ),
    );
    const mixed = await mixFunctions(original, path.join(temporary, "inline"), {
      allowInline: true,
    });
    const names = new Set(mixed.summary.placements.map(({ name }) => name));
    assert.ok(["first", "second", "third"].every((name) => names.has(name)));
    assert.ok(!names.has("constant"));
    assert.ok(mixed.summary.excluded.some(({ name }) => name === "constant"));
    const bytes = Buffer.from(mixed.stages.at(-1).tree["main.cpp"]);
    for (const placement of mixed.summary.placements.filter(({ name }) =>
      ["first", "second", "third"].includes(name),
    )) {
      const { byte, length, hash } = placement.declaration;
      const declaration = bytes.subarray(byte, byte + length);
      assert.equal(createHash("sha256").update(declaration).digest("hex"), hash);
      assert.match(
        declaration.toString("utf8"),
        new RegExp(`^inline int ${placement.name}\\(int value\\);\\n$`),
      );
    }
    const states = [original, ...mixed.stages.map(({ tree }) => tree)];
    let restored = mixed.stages.at(-1).tree;
    for (const stage of [...mixed.stages].reverse())
      restored = undoFunctionMix(restored, stage.record);
    assert.deepEqual(restored, original);
    for (const [index, tree] of states.entries()) {
      const directory = path.join(temporary, `state-${index}`);
      await writeTree(directory, tree);
      const executable = path.join(directory, "program");
      execFileSync("clang++", ["-std=c++17", path.join(directory, "main.cpp"), "-o", executable]);
      assert.equal(execFileSync(executable, [], { encoding: "utf8" }).trim(), "9");
    }
    const repeat = await mixFunctions(original, path.join(temporary, "repeat"), {
      allowInline: true,
    });
    assert.deepEqual(repeat, mixed);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
await test("inline mixing retains template and default-argument declaration boundaries", async () => {
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/mix-inline-boundaries-"));
  try {
    const original = {
      "main.cpp": `namespace demo {
inline int beforeA(int n) { return n + 1; }
inline int beforeB(int n) { return beforeA(n) + 1; }
template <class T> int fixedTemplate(T value) { return value + 3; }
inline int middleA(int n) { return fixedTemplate(n); }
inline int middleB(int n) { return fixedTemplate(n) + 1; }
static int withDefault(int n = 4) { return n; }
inline int afterA(int n) { return withDefault() + n; }
inline int afterB(int n) { return afterA(n) + 1; }
}
int main() { return demo::afterB(2) != 7; }
`,
    };
    const result = await mixFunctions(original, path.join(temporary, "mixed"), {
      allowInline: true,
      strategy: "dispersion",
    });
    const bytes = Buffer.from(result.stages.at(-1).tree["main.cpp"]);
    const template = bytes.indexOf("template <class T>"),
      fixed = bytes.indexOf("static int withDefault");
    for (const row of result.summary.placements) {
      if (row.name.startsWith("before")) assert.ok(row.to.byte < template);
      if (row.name.startsWith("middle")) assert.ok(template < row.to.byte && row.to.byte < fixed);
      if (row.name.startsWith("after")) assert.ok(fixed < row.to.byte);
    }
    assert.ok(result.summary.placements.some((row) => row.name.startsWith("after")));
    const file = path.join(temporary, "mixed", "permutation", "main.cpp");
    const executable = path.join(temporary, "check");
    execFileSync("clang++", ["-std=c++17", file, "-o", executable]);
    execFileSync(executable);
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
