import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { projectActiveLines } from "../../src/suites/explicit-edit-multi-agent/extraction/active-line-projection.mjs";

test("retains only active original lines and their exact source offsets", () => {
  const source = "#define SELECT 1\n#if SELECT\nint  active = 1;\n#else\nint hidden = 2;\n#endif\n";
  const output = execFileSync(
    "clang++",
    ["-x", "c++", "-std=c++17", "-E", "-fdirectives-only", "-fkeep-system-includes", "-"],
    { input: source, encoding: "utf8" },
  );
  const result = projectActiveLines(source, output, "<stdin>");
  assert.equal(result.map(({ text }) => text).join(""), "#define SELECT 1\nint  active = 1;\n");
  for (const { start, end, text } of result) assert.equal(source.slice(start, end), text);
});

test("retains real system include directives from the input", () => {
  const source = "#include <vector>\nint answer = 42;\n";
  const output = execFileSync(
    "clang++",
    ["-x", "c++", "-std=c++17", "-E", "-fdirectives-only", "-fkeep-system-includes", "-"],
    { input: source, encoding: "utf8" },
  );
  assert.equal(
    projectActiveLines(source, output, "<stdin>")
      .map(({ text }) => text)
      .join(""),
    source,
  );
});

test("rejects changed literal content, unfamiliar markers, and ambiguous source markers", () => {
  const source = 'const char* s = "a b";\n';
  assert.throws(() =>
    projectActiveLines(source, '# 1 "input.cpp"\nconst char* s = "ab";\n', "input.cpp"),
  );
  assert.throws(() => projectActiveLines(source, '# 1 "input.cpp" 99\n', "input.cpp"));
  assert.throws(() => projectActiveLines('#line 8 "other.cpp"\n', "", "input.cpp"));
});

test("rejects a change to function-like macro binding", () => {
  const source = "#define F(x) x\n";
  assert.throws(() =>
    projectActiveLines(source, '# 1 "input.cpp"\n#define F (x) x\n', "input.cpp"),
  );
});
