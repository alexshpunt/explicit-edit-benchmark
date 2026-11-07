import assert from "node:assert/strict";
import test from "node:test";
import { isToolchainBinary } from "../../src/suites/explicit-edit-multi-agent/execution/toolchain-mask.mjs";

test("compilers and language servers are hidden, the loader and shell tools are not", () => {
  for (const name of [
    "clang",
    "clang++-18",
    "clangd",
    "clang-cpp-18",
    "g++-13",
    "gcc",
    "cc",
    "cpp",
    "c++",
    "x86_64-linux-gnu-g++-13",
    "pip3",
  ])
    assert.ok(isToolchainBinary(name), name);
  for (const name of ["ld.so", "ldd", "bash", "python3", "sed", "grep", "rg", "node", "cat"])
    assert.ok(!isToolchainBinary(name), name);
});
