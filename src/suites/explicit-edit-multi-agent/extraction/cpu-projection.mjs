import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { projectActiveLines } from "./active-line-projection.mjs";

const flags = [
  "-std=c++17",
  "-O0",
  "-ffp-contract=off",
  "-pthread",
  "-E",
  "-fdirectives-only",
  "-fkeep-system-includes",
  "-x",
  "c++",
  "-",
];

/** Resolve only Clang's active CPU preprocessing branches, without expanding macros. */
export function projectCpuSource(source) {
  assert.equal(typeof source, "string");
  const compiler = execFileSync("clang++", ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
  }).split("\n")[0];
  assert.match(compiler, /clang/i);
  const output = execFileSync("clang++", flags, {
    input: source,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return { compiler, flags: [...flags], lines: projectActiveLines(source, output, "<stdin>") };
}
