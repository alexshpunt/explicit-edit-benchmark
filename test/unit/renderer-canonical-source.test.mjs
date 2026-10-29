import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalizeCpp } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-snapshot.mjs";

const exec = promisify(execFile);
const programs = {
  macros: String.raw`#include <cstdio>
#define stringify(x) #x
#define expand(x) stringify(x)
#define join(a,b) a##b
#define VALUE ( 1 + \
2 )
int main() {
  int join(va,lue) = VALUE;
  std::printf("%s|%s|%d\n", stringify(alpha + beta), expand(VALUE), value);
}
`,
  literals: String.raw`#include <cstdio>
constexpr unsigned long long operator "" _count(unsigned long long n) { return n; }
int main() {
  const char* raw = u8R"data( a  b
// literal /* content */ café 🙂 )data";
  std::printf("%s|%llu|%c|%g\n", raw, 12_count, ' ', 1e+2);
}
`,
  statements: String.raw`#include <cstdio>
int main() {
  struct State { int z() { return 9; } int x; int a() { return 3; } };
  State state{};
  int total = 0;
  for (int i = 0; i < 4; ++i) total += [i](int x) { return i + x; }(2);
  int value = 1;
  total += value++;
  total += value + +value;
  std::printf("%d|%d\n", total, state.a());
}
`,
};
for (const [kind, source] of Object.entries(programs)) {
  test(`ordered canonical ${kind} code compiles and preserves actual program output`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canonical-source-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const canonical = await canonicalizeCpp(source);
    assert.deepEqual(canonical.errors, []);
    const outputs = [];
    for (const [index, code] of [source, canonical.text].entries()) {
      const file = path.join(root, index + ".cpp"),
        binary = path.join(root, "program-" + index);
      await writeFile(file, code);
      await exec("clang++", ["-std=c++17", file, "-o", binary], { signal: t.signal });
      const { stdout, stderr } = await exec(binary, [], { signal: t.signal });
      assert.equal(stderr, "");
      outputs.push(stdout);
    }
    assert.equal(outputs[1], outputs[0]);
    assert.equal((await canonicalizeCpp(canonical.text)).text, canonical.text);
  });
}
