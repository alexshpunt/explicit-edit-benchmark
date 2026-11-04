import assert from "node:assert/strict";
import test from "node:test";
import { projectCpuSource } from "../../src/suites/explicit-edit-multi-agent/extraction/cpu-projection.mjs";

test("CPU projection is produced by Clang and preserves active original lines", () => {
  const source = "#ifdef __CUDACC__\nint gpu;\n#else\nint cpu;\n#endif\n";
  const result = projectCpuSource(source);
  assert.match(result.compiler, /clang/i);
  assert.deepEqual(
    result.lines.map((line) => line.text),
    ["int cpu;\n"],
  );
});
