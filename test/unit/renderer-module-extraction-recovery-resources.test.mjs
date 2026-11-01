import assert from "node:assert/strict";
import test from "node:test";
import { recoveryResources } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery-resources.mjs";

const a = "int alpha() { return 1; }";
const b = "int beta() { return 2; }";
function assessment(source, fragments = [a, b]) {
  return {
    files: fragments.map((_body, i) => ({
      id: `task-${i}`,
      file: `module-${i}.cpp`,
      targetMatched: true,
      sourceMatched: false,
    })),
    diagnostics: fragments.map((body, i) => ({
      id: `task-${i}`,
      file: "main.cpp",
      kind: "source-residue",
      start: source.indexOf(body),
      end: source.indexOf(body) + body.length,
    })),
  };
}

test("distinct complete global source units retain disjoint current footprints in the same file", async () => {
  const source = `${a}\n${b}\n`;
  const resources = await recoveryResources({ "main.cpp": source }, assessment(source));
  assert.deepEqual(resources.get("task-0"), [
    { file: "module-0.cpp" },
    { file: "main.cpp", range: [0, a.length] },
  ]);
  assert.deepEqual(resources.get("task-1"), [
    { file: "module-1.cpp" },
    { file: "main.cpp", range: [a.length + 1, a.length + 1 + b.length] },
  ]);
});

test("shared namespace and conditional scaffolding serialize otherwise separate bodies", async () => {
  for (const source of [`namespace n {\n${a}\n${b}\n}\n`, `#if SWITCH\n${a}\n${b}\n#endif\n`]) {
    const resources = await recoveryResources({ "main.cpp": source }, assessment(source));
    const left = resources.get("task-0")[1];
    const right = resources.get("task-1")[1];
    assert.deepEqual(left, right);
    assert.equal(left.range[0], 0);
    assert.ok(left.range[1] >= source.indexOf(b) + b.length);
  }
});

test("independent physical namespace blocks do not become one filename-wide lock", async () => {
  const first = `namespace n {\n${a}\n}\n`;
  const source = first + `namespace n {\n${b}\n}\n`;
  const resources = await recoveryResources({ "main.cpp": source }, assessment(source));
  const left = resources.get("task-0")[1].range;
  const right = resources.get("task-1")[1].range;
  assert.ok(left[1] <= right[0]);
});

test("accepted source needs no shared-source edit while missing replacements use a conservative footprint", async () => {
  const source = `${a}\n${b}\n`;
  const state = assessment(source);
  state.files[0].sourceMatched = true;
  state.diagnostics[1] = { id: "task-1", file: "main.cpp", kind: "source-replacement" };
  const resources = await recoveryResources({ "main.cpp": source }, state);
  assert.deepEqual(resources.get("task-0"), [{ file: "module-0.cpp" }]);
  assert.deepEqual(resources.get("task-1"), [{ file: "module-1.cpp" }, { file: "main.cpp" }]);
});

test("ambiguous duplicate units and obsolete or punctuation-only spans never select an occurrence", async () => {
  for (const source of [`${a}\n${a}\n${b}\n`, `// shifted\n${a}\n${b}\n`]) {
    const state = assessment(`${a}\n${b}\n`);
    const resources = await recoveryResources({ "main.cpp": source }, state);
    assert.deepEqual(resources.get("task-0")[1], { file: "main.cpp" });
  }
  const state = assessment(`${a}\n${b}\n`);
  state.diagnostics[0].start = a.indexOf("{");
  state.diagnostics[0].end = state.diagnostics[0].start + 1;
  const resources = await recoveryResources({ "main.cpp": `${a}\n${b}\n` }, state);
  assert.deepEqual(resources.get("task-0")[1], { file: "main.cpp" });
});

test("missing parser tokens make otherwise complete source units conservatively conflict", async () => {
  for (const suffix of ["struct broken { int member; }", "int broken() { return 0 }"]) {
    const source = a + "\n" + b + "\n" + suffix;
    const resources = await recoveryResources({ "main.cpp": source }, assessment(source));
    assert.deepEqual(resources.get("task-0")[1], { file: "main.cpp" });
    assert.deepEqual(resources.get("task-1")[1], { file: "main.cpp" });
  }
});

test("footprints are recomputed from the new snapshot rather than preserving former coordinates", async () => {
  const first = `${a}\n${b}\n`;
  const next = `// prefix added by an earlier repair\n${b}\n`;
  const resources = await recoveryResources({ "main.cpp": next }, assessment(next, [b]));
  const range = resources.get("task-0")[1].range;
  assert.equal(next.slice(...range), b);
  assert.notEqual(range[0], first.indexOf(b));
});
